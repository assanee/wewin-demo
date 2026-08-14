import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import { encodeThb } from '@wewin/contract/order';
import type { MoneyWire } from '@wewin/contract/money';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import type { PermissionCode } from '../../../src/rbac';
import type { SlipReviewWire } from '../../../src/payments/slips';
import {
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  type Actor,
  type Json,
} from '../support/payments-app';
import { makePng } from '../../media/fixtures';
import { bootSlipsApp, type SlipsApp } from './support/slips-app';

/**
 * 🔒 `SlipReviewWire.viewerIsSubmitter` — whose slip the review screen is looking at.
 *
 * ── The defect this file is the regression test for ──────────────────────────────
 *
 * The dashboard used to answer that question itself, with `submittedByUserId === null →
 * "somebody else's"`. The database does not answer it that way: `slip_submitter_user_ids()`
 * follows `payment_slips.submitted_by_guest_id → guests.claimed_by_user_id` as well, so a slip
 * uploaded from an anonymous cart that the reviewing staff member later signed into **is their
 * own submission** — with `submitted_by_user_id` NULL for ever, because the upload happened
 * before there was an account to name.
 *
 * The consequence was not a hole. `SlipsService.accept` and `payment_slips_guard_write()` both
 * still refused. It was a *dead end*: the dialog concluded "not mine", rendered no warning and no
 * declaration textarea, the reviewer pressed รับรอง, and the API answered 403
 * `self_review_needs_reason` — naming a field that was nowhere on the screen. The review could
 * not be completed through the UI at all, on the funnel plan §6 calls the main one.
 *
 * ⚠️ **This is the very case 0047 was careful about.** Its author computes `selfReviewed` from
 * `slip_submitter_user_ids()` rather than by comparing two columns, and says so in the migration.
 * The screen did not get the same treatment, so the fact is now on the wire, computed once, by
 * the same SQL function the refusal calls.
 *
 * ── What each `it` is evidence of ────────────────────────────────────────────────
 *
 * Not the boolean on its own — a boolean is cheap to make green. Each case asserts the boolean
 * *and* what the API then does to the same reviewer on the same slip, so the screen's warning and
 * the server's refusal are pinned to one another:
 *
 *   guest cart, later claimed   true   · and accepting with no reason is 403, with a reason 200
 *   somebody else's slip        false  · and accepting it plainly works, no declaration involved
 *   own slip, signed in         true   · the case the old comparison did get right
 *
 * The middle one is the control: without it, `viewerIsSubmitter: true` hard-coded would pass.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `viewer-${who}-${tag}@probe.invalid`,
  name: `viewerIsSubmitter ${tag}`,
});

/** A reviewer the owner trusts to close a payment alone — the review set plus the bypass. */
const SOLO_REVIEWER: readonly PermissionCode[] = [
  'payments.read',
  'payments.verify',
  'payments.self_review_slip',
  'orders.read',
  'orders.write',
];

/** An ordinary colleague: reviews, and holds no bypass. */
const REVIEWER: readonly PermissionCode[] = [
  'payments.read',
  'payments.verify',
  'orders.read',
  'orders.write',
];

const minor = (wire: MoneyWire<'THB'>): bigint => toBigInt(wire);

/**
 * The shared `client()` cannot carry a cookie, and the whole point of this file is the funnel
 * that starts without an account. Same shape as the one `redteam5b-money.pg.test.ts` keeps for
 * the same reason.
 */
function cookieClient(baseUrl: string) {
  return async function call(
    method: string,
    path: string,
    options: { token?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? null : (JSON.parse(text) as unknown),
      headers: response.headers,
    };
  };
}

/** The image route takes the file as the body, and this one may send it as a guest. */
async function putBytes(
  baseUrl: string,
  path: string,
  auth: { token?: string; cookie?: string },
  bytes: Buffer,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'image/png' };
  if (auth.token !== undefined) headers['authorization'] = `Bearer ${auth.token}`;
  if (auth.cookie !== undefined) headers['cookie'] = auth.cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

describeWithPg('🔒 whose slip is this — the review wire answers, the screen does not guess', () => {
  let pool: Pool;
  let db: Database;
  let app: SlipsApp;
  let call: ReturnType<typeof cookieClient>;

  /** The person who will hold the browser that uploaded, and then review it. */
  let solo: Actor;
  /** A second human, so every "true" here is about identity and not about the route. */
  let colleague: Actor;
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootSlipsApp(paymentsEnv(url ?? ''));
    call = cookieClient(app.baseUrl);

    solo = await makeActor(db, app, `viewer solo ${tag}`, SOLO_REVIEWER);
    colleague = await makeActor(db, app, `viewer colleague ${tag}`, REVIEWER);
    line = await liveLine(client(app.baseUrl));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ------------------------------------------------------------------ *
   * Fixtures — every one of them through the application
   * ------------------------------------------------------------------ */

  /** A submitted order owned by a *guest*, plus the cookie that owns it. */
  async function guestOrder(who: string): Promise<{ id: string; cookie: string; grand: bigint }> {
    const created = await call('POST', '/orders', { body: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    const draft = created.body as OrderWire;
    const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
      cookie,
      body: { contact: contactFor(who), lines: [line] },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const order = submitted.body as OrderWire;
    if (order.money === null) throw new Error('a submitted order has money');
    return { id: order.id, cookie, grand: minor(order.money.grandTotalThbMinor) };
  }

  /** The gating instalment the submit opened. Written by the application, read here. */
  async function gatingInstalment(orderId: string): Promise<string> {
    const found = await db.execute<{ id: string }>(sql`
      select id::text as id from order_instalments
       where order_id = ${orderId}::uuid order by seq asc limit 1
    `);

    const id = found.rows[0]?.id;
    if (id === undefined) throw new Error(`order ${orderId} has no schedule`);
    return id;
  }

  /** A slip, uploaded by whoever holds the cookie or the token. */
  async function slipAs(
    orderId: string,
    auth: { token?: string; cookie?: string },
    amount: bigint,
  ): Promise<{ id: string }> {
    const uploaded = await putBytes(
      app.baseUrl,
      `/orders/${orderId}/payment-slips/image`,
      auth,
      makePng(),
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const { imageHandle } = uploaded.body as { imageHandle: string };

    const created = await call('POST', `/orders/${orderId}/payment-slips`, {
      ...auth,
      body: {
        imageHandle,
        amountThbMinor: encodeThb(amount),
        transferredAt: new Date().toISOString(),
        bankReference: `VIS-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as { id: string };
  }

  /**
   * Signing in with a cart claims it — the UPDATE `IdentityLinkService` performs at the end of
   * the OAuth flow. Driving a whole sign-in here would be testing OAuth; the claim is the fact
   * this file is about.
   */
  async function claimGuestOf(slipId: string, userId: string): Promise<void> {
    const row = await db.execute<{ guest: string | null; who: string | null }>(sql`
      select submitted_by_guest_id::text as guest, submitted_by_user_id::text as who
        from payment_slips where id = ${slipId}::uuid
    `);

    /* The two columns the whole defect lives between: no user, and a guest. */
    expect(row.rows[0]?.who).toBeNull();
    const guestId = row.rows[0]?.guest;
    expect(guestId, 'a guest upload records which cart it came from').not.toBeNull();

    await db.execute(sql`
      update guests set claimed_by_user_id = ${userId}::uuid, claimed_at = now()
       where id = ${guestId ?? ''}::uuid
    `);
  }

  const reviewAs = async (slipId: string, actor: Actor): Promise<SlipReviewWire> => {
    const screen = await call('GET', `/payments/slips/${slipId}`, { token: actor.token });
    expect(screen.status, JSON.stringify(screen.body)).toBe(200);
    return screen.body as SlipReviewWire;
  };

  /* ================================================================== *
   * ⓵ The guest cart the reviewer later claimed — the case that dead-ended
   * ================================================================== */

  it('⭐ says TRUE on a guest-cart slip the reviewing staff member later claimed', async () => {
    const order = await guestOrder('claimed');
    const instalmentId = await gatingInstalment(order.id);

    /* Uploaded from a private window: no bearer token, just the cart's cookie. */
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand);
    await claimGuestOf(slip.id, solo.userId);

    const screen = await reviewAs(slip.id, solo);

    /*
     * ⚠️ The assertion the dashboard's comparison could never make. `submittedByUserId` is null
     * on this row and stays null — asserted right here so this test is evidence about the union
     * and not about some column having been filled in behind the screen's back.
     */
    expect(screen.slip.submittedByUserId).toBeNull();
    expect(screen.viewerIsSubmitter).toBe(true);

    /*
     * …and the reason the screen has to know: without the declaration this is refused, and a
     * dialog that rendered no textarea for it left the reviewer with no way to proceed at all.
     */
    const noReason = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
    });
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(403);
    expect(noReason.body).toMatchObject({
      error: { details: { reason: 'self_review_needs_reason' } },
    });

    /* With the sentence the screen now asks for, the same person may finish it. */
    const declared = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: {
        allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
        selfReviewReasonTh: 'ปิดยอดคนเดียวเพราะอยู่เวรคนเดียวในวันหยุด',
      },
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);

    /* And the trail says so, from the same function this wire asked. */
    const reasoned = await db.execute<{ reason: string | null }>(sql`
      select self_review_reason_th as reason from payment_slips where id = ${slip.id}::uuid
    `);
    expect(reasoned.rows[0]?.reason).toContain('คนเดียว');
  }, 90_000);

  /* ================================================================== *
   * ⓶ The control — somebody else's slip, which must ask for nothing
   * ================================================================== */

  it('says FALSE on an ordinary slip somebody else entered', async () => {
    const order = await guestOrder('other');
    const instalmentId = await gatingInstalment(order.id);

    /* Entered by a colleague, signed in, so the column is filled and it is not the viewer's. */
    const slip = await slipAs(order.id, { token: colleague.token }, order.grand);

    const screen = await reviewAs(slip.id, solo);
    expect(screen.slip.submittedByUserId).toBe(colleague.userId);
    expect(screen.viewerIsSubmitter).toBe(false);

    /*
     * The consequence, asserted rather than described: the two-person case needs no declaration,
     * so a screen told `false` correctly offers รับรอง with nothing else to fill in.
     */
    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: solo.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const reasoned = await db.execute<{ reason: string | null }>(sql`
      select self_review_reason_th as reason from payment_slips where id = ${slip.id}::uuid
    `);
    expect(reasoned.rows[0]?.reason).toBeNull();
  }, 90_000);

  /* ================================================================== *
   * ⓷ The half the old comparison did get right, kept
   * ================================================================== */

  it('says TRUE on a slip the viewer entered under their own user id', async () => {
    const order = await guestOrder('mine');
    const slip = await slipAs(order.id, { token: solo.token }, order.grand);

    const screen = await reviewAs(slip.id, solo);
    expect(screen.slip.submittedByUserId).toBe(solo.userId);
    expect(screen.viewerIsSubmitter).toBe(true);

    /* And it is about the reader, not about the slip: a colleague sees the ordinary case. */
    const theirs = await reviewAs(slip.id, colleague);
    expect(theirs.viewerIsSubmitter).toBe(false);
  }, 90_000);
});
