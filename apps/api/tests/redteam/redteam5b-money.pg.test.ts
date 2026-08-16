import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { encodeThb } from '@wewin/contract/order';
import { toBigInt } from '@wewin/contract/exact';
import type { MoneyWire } from '@wewin/contract/money';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { AppModule } from '../../src/app.module';
import { parseOAuthConfig } from '../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { testSessionConfig , testMfaSecretKey } from '../support/app';
import { makePng } from '../media/fixtures';
import {
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  type Actor,
  type Json,
} from '../payments/support/payments-app';
import { cancelWithScheduleClosed, expectRejection } from '../payments/support/money-fixture';
import { confirmQuotation } from '../support/confirm-quotation';

/**
 * RED TEAM 5b — money that has actually moved.
 *
 * ⚠️ READ THIS BEFORE EDITING AN EXPECTATION HERE.
 *
 * These started life as **reproductions**: every `it` marked ATTACK LANDS was green because
 * the attack worked, and the doing of it was the finding. The closing round fixed them, which
 * turned this file red — a red-team suite going red is what success looks like — and each one
 * has been rewritten to assert the refusal instead, keeping the whole attack in the body so
 * the fix is pinned by the walk that broke it rather than by a unit test of the patch.
 *
 * Each `it` now says which it is:
 *   CLOSED    — the attack was walked end to end and is now refused; the refusal is the test.
 *   DEFENDED  — it never worked; the refusal was pinned the first time and still holds.
 *   RESIDUAL  — it still works, deliberately, and the number or the reason is the finding.
 *
 * A test that flips from CLOSED back to landing is a regression in the one control this
 * payment model has.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `rt5bmoney-${who}-${tag}@probe.invalid`,
  name: `redteam 5b money ${tag}`,
});

interface Booted {
  readonly app: INestApplication;
  readonly baseUrl: string;
}

async function boot(env: ReturnType<typeof paymentsEnv>): Promise<Booted> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, {
        session: testSessionConfig(),
        mfaSecretKey: testMfaSecretKey(),
        oauth: parseOAuthConfig({}),
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

/** The shared JSON client cannot carry a cookie; the guest half of every attack needs one. */
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

const minor = (wire: MoneyWire<'THB'>): bigint => toBigInt(wire);

describeWithPg('RED TEAM 5b — moving money you are not allowed to move', () => {
  let pool: Pool;
  let db: Database;
  let booted: Booted;
  let call: ReturnType<typeof cookieClient>;
  let line: OrderLineRequestWire;

  /** One human, holding every permission a slip reviewer is ever given. */
  let reviewer: Actor;
  /** A second reviewer, for the control case. */
  let reviewer2: Actor;
  let customer: Actor;
  let requester: Actor;
  let approver: Actor;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    booted = await boot(paymentsEnv(url ?? ''));
    call = cookieClient(booted.baseUrl);

    const asApp = { app: booted.app, baseUrl: booted.baseUrl, close: async () => {} };

    reviewer = await makeActor(db, asApp, `rt5b reviewer ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
    ]);
    reviewer2 = await makeActor(db, asApp, `rt5b reviewer2 ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
    ]);
    customer = await makeActor(db, asApp, `rt5b customer ${tag}`, []);
    requester = await makeActor(db, asApp, `rt5b requester ${tag}`, ['orders.refund', 'payments.read']);
    approver = await makeActor(db, asApp, `rt5b approver ${tag}`, ['orders.refund', 'payments.read']);

    line = await liveLine(client(booted.baseUrl));
  }, 120_000);

  afterAll(async () => {
    await booted.app.close();
    await pool.end();
  });

  /* ------------------------------------------------------------------ *
   * Helpers
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

    /* A submit lands unconfirmed since 0056; a slip may only be attached once staff confirm. */
    await confirmQuotation(db, draft.id);

    const order = submitted.body as OrderWire;
    if (order.money === null) throw new Error('a submitted order has money');
    return { id: order.id, cookie, grand: minor(order.money.grandTotalThbMinor) };
  }

  /**
   * The order's own gating instalment — **written by the submit, not by this file**.
   *
   * ⚠️ This used to INSERT the row, and finding D1 below is why it had to: `OrdersService.submit`
   * created no schedule at all, so every attack in this file had to manufacture the instalment a
   * slip is allocated against. Since the closing round the submit calls
   * `PaymentLifecycleService.onSubmitted`, so the row is there and inserting a second one
   * collides on `order_instalments_order_seq_key` — which is what a red-team harness finding its
   * own scaffolding redundant looks like.
   */
  async function oneInstalment(orderId: string, grand: bigint): Promise<string> {
    const found = await db.execute(sql`
      select id::text as id, due_thb_minor::text as due from order_instalments
       where order_id = ${orderId}::uuid order by seq asc limit 1
    `);

    const rows = (found as { rows?: unknown }).rows;
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    const id = row?.['id'];

    if (typeof id !== 'string') {
      throw new Error(`order ${orderId} has no schedule; the submit path stopped opening one`);
    }

    /* And it is the whole contract, because plan 13's gate default is payment in full. */
    expect(row?.['due']).toBe(grand.toString());
    return id;
  }

  async function slipAs(
    orderId: string,
    auth: { token?: string; cookie?: string },
    amount: bigint,
    payer: { name?: string; last4?: string } = {},
  ): Promise<{ id: string }> {
    const uploaded = await putBytes(
      booted.baseUrl,
      `/orders/${orderId}/payment-slips/image`,
      auth,
      makePng(),
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const handle = (uploaded.body as { imageHandle: string }).imageHandle;

    const created = await call('POST', `/orders/${orderId}/payment-slips`, {
      ...auth,
      body: {
        imageHandle: handle,
        amountThbMinor: encodeThb(amount),
        transferredAt: new Date().toISOString(),
        bankReference: `RT-${randomUUID().slice(0, 8)}`,
        ...(payer.name === undefined ? {} : { payerName: payer.name }),
        ...(payer.last4 === undefined ? {} : { payerAccountLast4: payer.last4 }),
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as { id: string };
  }

  async function held(orderId: string): Promise<bigint> {
    const result = await db.execute<{ amount: string }>(
      sql`select order_held_thb_minor(${orderId}::uuid)::text as amount`,
    );
    return BigInt(result.rows[0]?.amount ?? '0');
  }

  /* ================================================================== *
   * A1 — the two-person slip review, with one of the columns null
   * ================================================================== */

  it('A1 CLOSED (funnel path) · RESIDUAL (second browser): the guest who uploaded is the user who claimed it', async () => {
    /*
     * The single control this whole payment model has (plan 7.7) is that the person who
     * uploads a slip is not the person who accepts it. It used to be enforced in two places
     * and BOTH compared against `payment_slips.submitted_by_user_id`:
     *
     *   TS  `assertReviewerIsNotSubmitter`  slip.submittedByUserId !== reviewerId
     *   SQL `payment_slips_reviewer_is_not_submitter`  IS DISTINCT FROM
     *
     * A guest-submitted slip has that column NULL, so `null !== x` and `null IS DISTINCT FROM
     * x` were both true and every reviewer in the company passed — including the one holding
     * the browser that uploaded it. Two copies of one predicate over one nullable column,
     * failing together, on the path plan §6 calls the MAIN funnel.
     *
     * What closed it: a guest is a real identity (`guests.secret_hash`, 0008) and signing in
     * *claims* it. `payment_slips.submitted_by_guest_id` records which one uploaded, and
     * `slip_submitter_user_ids()` unions the direct submitter with whoever claimed that guest.
     * So the ordinary funnel — anonymous cart, upload, sign in, review — is now the same
     * person and is refused.
     *
     * ⚠️ RESIDUAL, and it is in the migration in these words: a reviewer who uses a second
     * browser and *never* claims the guest is two identities to this system and always will
     * be. Nothing identity-based can catch an anonymous submitter. The second half of the walk
     * — turning that acceptance into cash — is closed instead at the refund, see B1.
     */
    const order = await guestOrder('a1');
    const instalmentId = await oneInstalment(order.id, order.grand);

    /* The reviewer, in a private window: no bearer token, just the guest cookie. */
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'ผู้โอนนิรนาม',
      last4: '1111',
    });

    const submitted = await db.execute<{ who: string | null; guest: string | null }>(
      sql`select submitted_by_user_id::text as who, submitted_by_guest_id::text as guest
            from payment_slips where id = ${slip.id}::uuid`,
    );
    expect(submitted.rows[0]?.who).toBeNull();
    /* The column that made the rule enforceable at all. */
    const guestId = submitted.rows[0]?.guest;
    expect(guestId).not.toBeNull();

    /*
     * Signing in with that cart claims it. `IdentityLinkService` does exactly this UPDATE at
     * the end of the OAuth flow; driving a whole sign-in here would be testing OAuth, not the
     * guard, and the guard is what this is about.
     */
    await db.execute(sql`
      update guests set claimed_by_user_id = ${reviewer.userId}::uuid, claimed_at = now()
       where id = ${guestId ?? ''}::uuid
    `);

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
      },
    });

    /*
     * 403 and a sentence, from `assertReviewerIsNotSubmitter` — which asks
     * `slip_submitter_user_ids()` rather than comparing one nullable column, so the service and
     * the trigger are refusing the same set of people. C1 asserts the trigger half with every
     * service removed, because a test green through the *other* mechanism is a test that lies.
     */
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(403);
    expect(accepted.body).toMatchObject({ error: { details: { reason: 'reviewer_is_submitter' } } });

    /* Nothing moved: no freeze, no money held, and the slip is still in the queue. */
    expect(await held(order.id)).toBe(0n);
    const status = await db.execute<{ s: string }>(
      sql`select status as s from orders where id = ${order.id}::uuid`,
    );
    expect(status.rows[0]?.s).toBe('awaiting_payment');

    /* And a second human still can, so this is evidence about the identity and not about the
     * route being broken. */
    const byOther = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer2.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
    });
    expect(byOther.status, JSON.stringify(byOther.body)).toBe(200);
    expect(await held(order.id)).toBe(order.grand);
  }, 60_000);

  it('A1b DEFENDED (control): the same reviewer signed in cannot accept their own upload', async () => {
    /*
     * The control case, so A1 is evidence about the null and not about the rule being absent.
     * Reviewer uploads while *signed in* — the column is filled — and is refused.
     */
    const created = await call('POST', '/orders', { token: reviewer.token, body: {} });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;
    const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
      token: reviewer.token,
      body: { contact: contactFor('a1b'), lines: [line] },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    /* A submit lands unconfirmed since 0056; a slip may only be attached once staff confirm. */
    await confirmQuotation(db, draft.id);

    const order = submitted.body as OrderWire;
    if (order.money === null) throw new Error('a submitted order has money');
    const grand = minor(order.money.grandTotalThbMinor);

    const instalmentId = await oneInstalment(order.id, grand);
    const slip = await slipAs(order.id, { token: reviewer.token }, grand);

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(grand) }] },
    });

    expect(accepted.status).toBe(403);
    expect(accepted.body).toMatchObject({ error: { details: { reason: 'reviewer_is_submitter' } } });

    /* And a second person can. Two humans, as designed. */
    const byOther = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer2.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(grand) }] },
    });
    expect(byOther.status, JSON.stringify(byOther.body)).toBe(200);
  }, 60_000);

  /* ================================================================== *
   * A2 — the payee "on record" is a field the payer typed
   * ================================================================== */

  it('A2 CLOSED: an attacker-typed payer no longer reads as payeeIsOriginalAccount=yes', async () => {
    /*
     * `deriveOriginalAccount` compares the requested payee against `payment_slips.payer_name`
     * and `payer_account_last4` — and both of those used to be OPTIONAL FIELDS ON THE
     * CUSTOMER'S OWN CREATE-SLIP BODY. Nothing compared them to the photograph, to the bank
     * reference, or to anything a bank said, so the account "the money came from" was whatever
     * the uploader typed. Name a mule account on the slip, ask for the refund to the same mule
     * account, and plan 7.12's entire fraud control — a reason at request, an acknowledgement
     * at approval, a line in the different-account report — was switched off by the party it
     * is a control against.
     *
     * What closed it: `payer_verified_by_user_id`/`payer_verified_at`, written **only** by the
     * statement that accepts the slip and **only** by the reviewer (`payment_slips_guard_write`
     * ⓸), and `acceptedPayers` reading attested slips and nothing else. An unattested payer is
     * no payer at all, so the same request now reads `no` and fails into the customer's
     * inconvenience rather than into somebody else's bank account.
     */
    const order = await guestOrder('a2');
    const instalmentId = await oneInstalment(order.id, order.grand);

    /* The slip claims a payer that has nothing to do with whoever transferred anything. */
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'MULE ACCOUNT',
      last4: '9999',
    });

    /* Accepted without a `payer` block: the reviewer read nothing off the image. */
    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((accepted.body as { slip: { payerVerified: boolean } }).slip.payerVerified).toBe(false);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ทดสอบ red team',
      fault: 'customer',
    });

    /* The mule account, worded exactly as before — `sameName` still folds case and spacing. */
    const noReason = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: {
        orderId: order.id,
        payee: { name: 'mule   account', bankCode: '014', accountLast4: '9999' },
      },
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body).toMatchObject({
      error: { details: { reason: 'different_account_requires_reason' } },
    });

    const requested = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: {
        orderId: order.id,
        payee: { name: 'mule   account', bankCode: '014', accountLast4: '9999' },
        reasonTh: 'ลูกค้าแจ้งว่าปิดบัญชีเดิมแล้ว',
      },
    });

    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const detail = requested.body as {
      refund: { id: string; payeeIsOriginalAccount: string; amountThbMinor: string };
    };

    /* 'no' — the reason was required, the acknowledgement will be, and the report lists it. */
    expect(detail.refund.payeeIsOriginalAccount).toBe('no');

    const report = await call('GET', '/payments/refunds?payee=different&status=requested', {
      token: requester.token,
    });
    expect(report.status).toBe(200);
    const listed = (report.body as { refunds: readonly { id: string }[] }).refunds;
    expect(listed.map((row) => row.id)).toContain(detail.refund.id);

    /* The ordinary approval click no longer works: it has no acknowledgement on it. */
    const clicked = await call('POST', `/payments/refunds/${detail.refund.id}/decision`, {
      token: approver.token,
      body: { decision: 'approved' },
    });
    expect(clicked.status).toBe(422);

    const approved = await call('POST', `/payments/refunds/${detail.refund.id}/decision`, {
      token: approver.token,
      body: { decision: 'approved', acknowledgeDifferentAccount: true },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body as { refund: { status: string } }).refund.status).toBe('approved');
  }, 60_000);

  it('A2b CONTROL: a payer the reviewer attested off the image does read as the original account', async () => {
    /*
     * So A2 is evidence about the *attestation* and not about the comparison having been
     * broken. The trust moved from the party that typed the figures to a member of staff who
     * says they read them off the picture — which is what plan 7.12 asks for and is as far as
     * the columns can go: `payment_slips` has no bank code, so "the same account" is proved on
     * a name and four digits, and `matchedSlipId` is in the response so a reviewer can open the
     * slip and look.
     */
    const order = await guestOrder('a2b');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'สมชาย ใจดี',
      last4: '4321',
    });

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
        payer: { name: 'สมชาย ใจดี', accountLast4: '4321' },
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((accepted.body as { slip: { payerVerified: boolean } }).slip.payerVerified).toBe(true);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ทดสอบ red team',
      fault: 'customer',
    });

    const requested = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refund = (requested.body as {
      refund: { payeeIsOriginalAccount: string; payeeAccountLast4: string };
      matchedSlipId: string | null;
    });
    expect(refund.refund.payeeIsOriginalAccount).toBe('yes');
    expect(refund.refund.payeeAccountLast4).toBe('4321');
  }, 60_000);

  /* ================================================================== *
   * A3 — the requester may pay out what they asked for
   * ================================================================== */

  it('A3 RESIDUAL (by design, stated): the requester disburses their own refund', async () => {
    /*
     * `disburse` refuses only `approvedByUserId === disburserUserId`. Requester → disburser is
     * deliberately allowed and documented. The consequence, written as a number: cash leaves
     * the company with exactly TWO humans involved, and one of them touches it twice.
     */
    const order = await guestOrder('a3');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'ผู้โอน',
      last4: '4321',
    });
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: {
            allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
            payer: { name: 'ผู้โอน', accountLast4: '4321' },
          },
        })
      ).status,
    ).toBe(200);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ทดสอบ red team',
      fault: 'customer',
    });

    const requested = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refundId = (requested.body as { refund: { id: string } }).refund.id;

    expect(
      (
        await call('POST', `/payments/refunds/${refundId}/decision`, {
          token: approver.token,
          body: { decision: 'approved' },
        })
      ).status,
    ).toBe(200);

    const paid = await call('POST', `/payments/refunds/${refundId}/disbursement`, {
      token: requester.token,
      body: { disbursementReference: 'BANK-RT-0001' },
    });

    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const row = (paid.body as { refund: { status: string; disbursedByUserId: string; requestedByUserId: string } })
      .refund;
    expect(row.status).toBe('disbursed');
    expect(row.disbursedByUserId).toBe(row.requestedByUserId);
  }, 60_000);

  /* ================================================================== *
   * A4 — changing a refund after approval
   * ================================================================== */

  it('A4 DEFENDED: the amount and every payee column are frozen once the refund leaves requested', async () => {
    const order = await guestOrder('a4');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'ผู้โอน',
      last4: '4321',
    });
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: {
            allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
            payer: { name: 'ผู้โอน', accountLast4: '4321' },
          },
        })
      ).status,
    ).toBe(200);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ทดสอบ red team',
      fault: 'customer',
    });

    const requested = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refundId = (requested.body as { refund: { id: string } }).refund.id;

    expect(
      (
        await call('POST', `/payments/refunds/${refundId}/decision`, {
          token: approver.token,
          body: { decision: 'approved' },
        })
      ).status,
    ).toBe(200);

    /* There is no HTTP route that could carry an amount at all — the schemas have no field. */
    const overAmount = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id, amountThbMinor: encodeThb(999_999_00n) },
    });
    /* 400: `createRefundSchema` is a strictObject, so the key does not exist to be honoured. */
    expect(overAmount.status).toBe(400);

    /* And the database refuses the UPDATE a second writer would make. */
    await expect(
      db.execute(
        sql`update refunds set amount_thb_minor = 99999900, payee_account_last4 = '0000'
             where id = ${refundId}::uuid`,
      ),
    ).rejects.toThrow();

    const after = await db.execute<{ amount: string; last4: string }>(
      sql`select amount_thb_minor::text as amount, payee_account_last4 as last4
            from refunds where id = ${refundId}::uuid`,
    );
    expect(after.rows[0]?.amount).toBe(order.grand.toString());
    expect(after.rows[0]?.last4).toBe('4321');
  }, 60_000);

  /* ================================================================== *
   * A5 — fault
   * ================================================================== */

  it('A5 DEFENDED: fault=company cannot be set from a body, by a customer or by staff with no bounce', async () => {
    /* A customer trying to buy themselves a full refund on their own cancellation. */
    const own = await guestOrder('a5-customer');
    const asCustomer = await call('POST', `/orders/${own.id}/transitions/cancelled`, {
      cookie: own.cookie,
      body: { reason: 'เปลี่ยนใจ', fault: 'company', attributeFaultToCompany: true },
    });
    /* The pre-freeze schema is strict: the extra keys are refused outright, 400. */
    expect(asCustomer.status).toBe(400);

    const clean = await call('POST', `/orders/${own.id}/transitions/cancelled`, {
      cookie: own.cookie,
      body: { reason: 'เปลี่ยนใจ' },
    });
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);

    const payload = await db.execute<{ payload: unknown }>(
      sql`select payload from order_events
           where order_id = ${own.id}::uuid and to_status = 'cancelled' order by seq desc limit 1`,
    );
    expect(JSON.stringify(payload.rows[0]?.payload)).not.toContain('company');

    /* Staff, post-freeze, on an order that never bounced. */
    const frozen = await guestOrder('a5-staff');
    const instalmentId = await oneInstalment(frozen.id, frozen.grand);
    const slip = await slipAs(frozen.id, { cookie: frozen.cookie }, frozen.grand);
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(frozen.grand) }] },
        })
      ).status,
    ).toBe(200);

    const claimed = await call('POST', `/orders/${frozen.id}/transitions/cancelled`, {
      token: reviewer.token,
      body: { reason: 'อ้างว่าบริษัทผิด', attributeFaultToCompany: true },
    });
    expect(claimed.status).toBe(422);
    expect(claimed.body).toMatchObject({ error: { details: { reason: 'no_bounce_on_record' } } });
  }, 60_000);

  /* ================================================================== *
   * A6 — reaching payment endpoints you should not
   * ================================================================== */

  it('A6 DEFENDED: guests, plain customers and closed accounts are refused the money routes', async () => {
    const order = await guestOrder('a6');

    /* A guest at the reviewer queue and at the refund routes: 401, never a scope with reach. */
    expect((await call('GET', '/payments/slips', { cookie: order.cookie })).status).toBe(401);
    expect((await call('GET', '/payments/refunds', { cookie: order.cookie })).status).toBe(401);
    expect(
      (
        await call('POST', '/payments/refunds', {
          cookie: order.cookie,
          body: { orderId: order.id },
        })
      ).status,
    ).toBe(401);

    /* A signed-in customer with no permission at all. */
    expect((await call('GET', '/payments/slips', { token: customer.token })).status).toBe(403);
    expect(
      (
        await call('POST', '/payments/refunds', {
          token: customer.token,
          body: { orderId: order.id },
        })
      ).status,
    ).toBe(403);

    /* Cross-ownership: a different customer asking for this guest's slips. */
    expect((await call('GET', `/orders/${order.id}/payment-slips`, { token: customer.token })).status).toBe(404);

    /* A reviewer whose account is closed after the token was minted. */
    const asApp = { app: booted.app, baseUrl: booted.baseUrl, close: async () => {} };
    const doomed = await makeActor(db, asApp, `rt5b doomed ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
    ]);
    expect((await call('GET', '/payments/slips', { token: doomed.token })).status).toBe(200);

    await db.execute(
      sql`update users set status = 'closed', closed_at = now() where id = ${doomed.userId}::uuid`,
    );
    expect((await call('GET', '/payments/slips', { token: doomed.token })).status).toBe(401);
  }, 60_000);

  it('A6b DEFENDED: a slip cannot be attached to a finished contract', async () => {
    const order = await guestOrder('a6b');
    /* No schedule on this one, so the ordinary cancel route works. */
    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      cookie: order.cookie,
      body: { reason: 'ทดสอบ' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const uploaded = await putBytes(
      booted.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      { cookie: order.cookie },
      makePng(),
    );
    expect(uploaded.status).toBe(409);
    expect(uploaded.body).toMatchObject({
      error: { details: { reason: 'order_not_accepting_slips' } },
    });
  }, 60_000);

  /* ================================================================== *
   * A7 — "view" and "download" are separated by a header
   * ================================================================== */

  it('A7 CLOSED: the permission gates the bytes now, not Content-Disposition', async () => {
    /*
     * Plan 7.6 asks for "ดู" and "ดาวน์โหลด" to be separate rights, because a slip carries a
     * bank account number. What was built was `mintGrant` refusing `purpose=download` to staff
     * without `payments.verify` — and then handing the *view* grant, which serves exactly the
     * same bytes from an anonymous URL. The only thing the permission bought was `inline`
     * instead of `attachment`: a right-click away, and no distance at all from curl.
     *
     * A permission split that both branches walk past is worse than none, because it is on the
     * screen and in the plan and does nothing. So it was collapsed honestly: staff need
     * `payments.verify` to mint *either* purpose, and `purpose` survives as what it always was,
     * a rendering hint for one response header.
     *
     * ⚠️ A REAL split needs the bytes to differ — a watermarked, downscaled render for viewing
     * and the original for download. That is a feature, not a permission, and when it exists
     * the download side wants `payments.download_slip` rather than `payments.verify`.
     */
    const order = await guestOrder('a7');
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand);

    const asApp = { app: booted.app, baseUrl: booted.baseUrl, close: async () => {} };
    const looker = await makeActor(db, asApp, `rt5b looker ${tag}`, ['payments.read', 'orders.read']);

    /* Neither purpose. The one that used to be free is the one that mattered. */
    for (const purpose of ['download', 'view'] as const) {
      const refused = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
        token: looker.token,
        body: { purpose },
      });
      expect(refused.status, `${purpose}: ${JSON.stringify(refused.body)}`).toBe(403);
      expect(refused.body).toMatchObject({ error: { details: { purpose } } });
    }

    /* A reviewer gets one, and the URL is still the credential — by design, so a browser can
     * render an <img> without carrying a bearer token into a third-party context. */
    const view = await call('POST', `/payments/slips/${slip.id}/image-grant`, {
      token: reviewer.token,
      body: { purpose: 'view' },
    });
    expect(view.status, JSON.stringify(view.body)).toBe(201);
    const path = (view.body as { path: string }).path;

    const served = await fetch(`${booted.baseUrl}${path}`);
    expect(served.status).toBe(200);
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  }, 60_000);

  /* ================================================================== *
   * B1 — the whole chain, by one insider plus one click
   * ================================================================== */

  it('B1 CLOSED: one insider cannot manufacture money and pay it to themselves', async () => {
    /*
     * The composition of A1, A2 and A3, run as one person. Nothing here needs two accounts to
     * be *held* by two people; `orders.refund` and `payments.verify` are separate codes but
     * nothing forbids one group carrying both, and the fixture grants exactly what a "payments
     * officer" group would plausibly carry.
     *
     *   1. open an order anonymously                      (no identity recorded at all)
     *   2. upload a slip for money that never moved       (submitted_by_user_id NULL)
     *   3. accept it                                      (the null defeated the two-person rule)
     *   4. cancel the order                               (staff, fault=customer, forfeit 0 bp)
     *   5. request the refund to an account they named on the slip in step 2
     *   6. ONE other person clicks approve
     *   7. disburse it themselves
     *
     * Real baht left the company at step 7, to an account chosen at step 2, against a
     * photograph nobody independent ever looked at — and `bank_thb` netted to **zero**, because
     * the fake money in and the real money out cancel exactly. No per-order balance check could
     * ever have caught it.
     *
     * ── Where it is broken now, and why there ────────────────────────────────────
     *
     * Step 3 is closed for the ordinary funnel (A1) and cannot be closed for a second browser:
     * nothing identity-based can catch an anonymous submitter, and the migration says so in
     * those words. So the chain is cut at **step 5**, the first step where an identity always
     * exists — whoever accepted the payment may not request its refund
     * (`refunds_requester_did_not_take_the_money`, and `RefundsService.request` for the
     * sentence). It is "the reviewer is not the submitter" pointed the other way.
     *
     * It costs no new approval point, which plan 7.13 warns is the way to kill the only control
     * that means anything. With two employees a refund is still two humans: A accepts the slip,
     * B requests, A approves, B disburses. What is gone is the composition where one person
     * both creates the money and drives the payout.
     */
    const insider = await makeActor(
      db,
      { app: booted.app, baseUrl: booted.baseUrl, close: async () => {} },
      `rt5b insider ${tag}`,
      ['payments.verify', 'payments.read', 'orders.read', 'orders.write', 'orders.refund'],
    );

    const order = await guestOrder('b1');
    const instalmentId = await oneInstalment(order.id, order.grand);

    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'INSIDER MULE',
      last4: '7777',
    });

    /*
     * Steps 2 and 3 still go through: a second browser is two identities and always will be.
     * The insider even attests the payer themselves, which is the strongest version of the
     * attack — the trust RT-2 moved onto a member of staff is here held by the attacker.
     */
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: insider.token,
          body: {
            allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
            payer: { name: 'INSIDER MULE', accountLast4: '7777' },
          },
        })
      ).status,
    ).toBe(200);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: insider.userId,
      reasonTh: 'ยกเลิก',
      fault: 'customer',
    });

    /* 🔒 STEP 5 IS WHERE IT STOPS. */
    const requested = await call('POST', '/payments/refunds', {
      token: insider.token,
      body: {
        orderId: order.id,
        payee: { name: 'INSIDER MULE', bankCode: '014', accountLast4: '7777' },
      },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(403);
    expect(requested.body).toMatchObject({
      error: { details: { reason: 'requester_accepted_the_payment', slipId: slip.id } },
    });

    /* And the row guard says the same thing with every service removed. */
    await expectRejection(
      db.execute(sql`
        insert into refunds (order_id, accrual_entry_id, amount_thb_minor, payee_name,
                             payee_bank_code, payee_account_last4, payee_is_original_account,
                             requested_by_user_id)
        select ${order.id}::uuid, e.id, ${order.grand.toString()}::bigint, 'INSIDER MULE',
               '014', '7777', 'yes', ${insider.userId}::uuid
          from ledger_entries e
         where e.order_id = ${order.id}::uuid limit 1
      `),
      /cannot request its refund/u,
    );

    /* No refund exists, no cash left, and the money is still visibly held on a dead order. */
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from refunds where order_id = ${order.id}::uuid`,
    );
    expect(rows.rows[0]?.n).toBe('0');
    expect(await held(order.id)).toBe(order.grand);

    /*
     * The colleague can still do it, which is the point: this is a separation of duties and not
     * a wall. Two humans, one of whom did not accept the money.
     */
    const byColleague = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: {
        orderId: order.id,
        payee: { name: 'INSIDER MULE', bankCode: '014', accountLast4: '7777' },
      },
    });
    expect(byColleague.status, JSON.stringify(byColleague.body)).toBe(201);
  }, 90_000);

  /* ================================================================== *
   * B2 — accepting a slip while the order is in `redesign`
   * ================================================================== */

  it('B2 DEFENDED: a slip cannot smuggle an order out of `redesign` — the spine clause holds it shut', async () => {
    /*
     * `redesign → production_confirmed` exists in `order_status_transitions` and its event type
     * is `redesign_approved`. So if `freeze()` ever fired from `redesign`, accepting a payment
     * would write "the redesign was approved" onto the spine and close an unresolved bounce —
     * which is the fact `faultFor` reads to decide whether a later cancellation may be the
     * company's fault, i.e. how much money goes back.
     *
     * It cannot fire, and the reason is the first half of `order_gate_is_open()`: every route
     * into `redesign` comes from a status the order could only reach by having entered
     * `production_confirmed`, so `order_events` already carries that row and the gate is
     * permanently open. `gateOpenBefore` is therefore true and `gateOpened` is false.
     *
     * The consequence, which is the finding rather than the attack: money accepted while an
     * order sits in `redesign` moves nothing and is simply recorded. That is correct, and it
     * is only correct because of one clause in one SQL function.
     */
    const order = await guestOrder('b2');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand);

    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
        })
      ).status,
    ).toBe(200);

    const bounced = await call('POST', `/orders/${order.id}/transitions/redesign`, {
      token: reviewer.token,
      body: { reason: 'ฝ่ายผลิตตีกลับ' },
    });
    expect(bounced.status, JSON.stringify(bounced.body)).toBe(200);

    const gate = await db.execute<{ open: boolean }>(
      sql`select order_gate_is_open(${order.id}::uuid, 'production_confirmed') as open`,
    );
    expect(gate.rows[0]?.open).toBe(true);

    const events = await db.execute<{ t: string }>(
      sql`select event_type as t from order_events where order_id = ${order.id}::uuid order by seq`,
    );
    expect(events.rows.map((row) => row.t)).not.toContain('redesign_approved');

    const status = await db.execute<{ s: string }>(
      sql`select status as s from orders where id = ${order.id}::uuid`,
    );
    expect(status.rows[0]?.s).toBe('redesign');
  }, 90_000);

  /* ================================================================== *
   * B3 — money that arrives and cannot be recorded
   * ================================================================== */

  it('B3 CLOSED: an overpaid slip is received, and the excess is named rather than orphaned', async () => {
    /*
     * ฿100.00 more than the whole contract. It used to be unacceptable (no instalment has room),
     * undeletable (`payment_slips_guard_write`) and un-rejectable (the money really did arrive):
     * `order_cash_thb_minor` ฿0.00, `order_held_thb_minor` ฿0.00, and a slip sitting in the
     * queue for ever. Refusing a slip does not make the money go away, it makes it invisible.
     *
     * What closed it: `payment_slips.unallocated_thb_minor`, the identity
     * `SUM(allocations) + unallocated = slip.amount` in `assert_slip_allocations`, and a
     * reviewer who has to name the excess exactly. The pay-off beyond the orphan is that
     * `paidMinor` and `settledMinor` are now genuinely different numbers on a reachable path,
     * which plan 7.13 says they must be.
     */
    const order = await guestOrder('b3');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const over = order.grand + 100_00n;

    const slip = await slipAs(order.id, { cookie: order.cookie }, over);

    /* No instalment absorbs more than it is due — that rule is unchanged. */
    const wholeSlip = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(over) }] },
    });
    expect(wholeSlip.status).toBe(422);
    expect(wholeSlip.body).toMatchObject({ error: { details: { reason: 'over_allocated' } } });

    /* Nor is the excess absorbed silently: it has to be stated. */
    const unstated = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }] },
    });
    expect(unstated.status).toBe(422);
    expect(unstated.body).toMatchObject({
      error: { details: { reason: 'overpayment_not_acknowledged', unallocatedThbMinor: '10000' } },
    });

    /* And a figure that is not the excess is refused rather than believed. */
    const wrong = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
        acknowledgeOverpaymentThbMinor: encodeThb(99_00n),
      },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ error: { details: { reason: 'overpayment_mismatch' } } });

    const accepted = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
        acknowledgeOverpaymentThbMinor: encodeThb(100_00n),
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    /* The whole transfer is held; the schedule is settled by the part that had a home. */
    expect(await held(order.id)).toBe(over);
    const money = (accepted.body as { money: { settledThbMinor: MoneyWire<'THB'>; paidThbMinor: MoneyWire<'THB'> } }).money;
    expect(minor(money.settledThbMinor)).toBe(order.grand);
    expect(minor(money.paidThbMinor)).toBe(over);
    /* Two numbers plan 7.13 says must differ, differing on a path a customer can reach. */
    expect(minor(money.paidThbMinor) - minor(money.settledThbMinor)).toBe(100_00n);
  }, 60_000);

  /* ================================================================== *
   * B4 — token confusion between the two grant kinds
   * ================================================================== */

  it('B4 DEFENDED: an upload handle cannot be replayed as a read capability', async () => {
    const order = await guestOrder('b4');
    const uploaded = await putBytes(
      booted.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      { cookie: order.cookie },
      makePng(),
    );
    expect(uploaded.status).toBe(201);
    const handle = (uploaded.body as { imageHandle: string }).imageHandle;

    const replayed = await fetch(`${booted.baseUrl}/payments/slip-images/${handle}`);
    expect(replayed.status).toBe(404);

    /* And a handle minted for one order cannot name a slip on another. */
    const other = await guestOrder('b4-other');
    const crossed = await call('POST', `/orders/${other.id}/payment-slips`, {
      cookie: other.cookie,
      body: {
        imageHandle: handle,
        amountThbMinor: encodeThb(1000n),
        transferredAt: new Date().toISOString(),
      },
    });
    expect(crossed.status).toBe(400);
    expect(crossed.body).toMatchObject({ error: { details: { reason: 'handle_order_mismatch' } } });
  }, 60_000);

  /* ================================================================== *
   * B5 — a second refund on an order that has already been paid out
   * ================================================================== */

  it('B5 DEFENDED: a disbursed order cannot be refunded twice', async () => {
    const order = await guestOrder('b5');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'ผู้โอน',
      last4: '4321',
    });
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: {
            allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
            payer: { name: 'ผู้โอน', accountLast4: '4321' },
          },
        })
      ).status,
    ).toBe(200);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ยกเลิก',
      fault: 'customer',
    });

    const first = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const refundId = (first.body as { refund: { id: string } }).refund.id;

    /* A second request while the first is open. */
    const concurrent = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(concurrent.status).toBe(409);

    expect(
      (
        await call('POST', `/payments/refunds/${refundId}/decision`, {
          token: approver.token,
          body: { decision: 'approved' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', `/payments/refunds/${refundId}/disbursement`, {
          token: requester.token,
          body: { disbursementReference: 'BANK-RT-B5' },
        })
      ).status,
    ).toBe(200);

    const again = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(again.status).toBe(409);
    expect(await held(order.id)).toBe(0n);
  }, 90_000);

  /* ================================================================== *
   * B6 — a slip amount larger than the column
   * ================================================================== */

  it('B6 CLOSED: a slip amount beyond bigint is a validation failure, not a 500', async () => {
    const order = await guestOrder('b6');
    const uploaded = await putBytes(
      booted.baseUrl,
      `/orders/${order.id}/payment-slips/image`,
      { cookie: order.cookie },
      makePng(),
    );
    expect(uploaded.status).toBe(201);
    const handle = (uploaded.body as { imageHandle: string }).imageHandle;

    const created = await call('POST', `/orders/${order.id}/payment-slips`, {
      cookie: order.cookie,
      body: {
        imageHandle: handle,
        amountThbMinor: { unit: 'THB.satang', digits: '9'.repeat(40) },
        transferredAt: new Date().toISOString(),
      },
    });

    /*
     * It used to be 500 INTERNAL with a logged stack, reachable by any guest holding a cart:
     * `positiveThbSchema` checked the shape and the sign and never the magnitude, so a
     * forty-digit `digits` reached a `bigint` column as SQLSTATE 22003 — a driver error that is
     * neither an `AppError` nor an `HttpException` and falls straight through the filter.
     *
     * The bound belongs in the schema and not beside each column, because "fits in the column"
     * is a fact about every money field in the wire protocol.
     */
    expect(created.status, JSON.stringify(created.body)).toBe(400);
    expect(JSON.stringify(created.body)).not.toContain('INTERNAL');
  }, 60_000);

  /* ================================================================== *
   * C — the two-person rules, at the schema level, with a null in one column
   * ================================================================== */

  it('C1 CLOSED: the rule left the CHECK for a trigger that can see the guest', async () => {
    /*
     * The database half of A1, isolated from every service.
     *
     * `payment_slips_reviewer_is_not_submitter` was a CHECK written with `IS DISTINCT FROM`,
     * and a CHECK is the wrong instrument for this rule: it can only see one row. For a
     * guest-submitted slip `submitted_by_user_id` is NULL, `null IS DISTINCT FROM x` is true,
     * and there was no constraint at all on who reviewed it — both halves of the "defence in
     * depth" being the same predicate over the same nullable column, failing together.
     *
     * `payment_slips_guard_write()` can join `guests`, so the rule now reads *"the reviewer is
     * not the submitter, and not the user who claimed the submitting guest"*. Same sentence,
     * an instrument that can check it.
     */
    const order = await guestOrder('c1');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand);

    const guest = await db.execute<{ id: string | null }>(
      sql`select submitted_by_guest_id::text as id from payment_slips where id = ${slip.id}::uuid`,
    );
    await db.execute(sql`
      update guests set claimed_by_user_id = ${reviewer.userId}::uuid, claimed_at = now()
       where id = ${guest.rows[0]?.id ?? ''}::uuid
    `);

    /* The guest slip, with the guest claimed: refused with every service out of the picture. */
    await expectRejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into slip_allocations (slip_id, instalment_id, amount_thb_minor)
          values (${slip.id}::uuid, ${instalmentId}::uuid, ${order.grand.toString()}::bigint)
        `);
        await tx.execute(sql`
          update payment_slips set status = 'accepted',
                 reviewed_by_user_id = ${reviewer.userId}::uuid, reviewed_at = now()
           where id = ${slip.id}::uuid
        `);
      }),
      /cannot review it/u,
    );

    const row = await db.execute<{ s: string }>(
      sql`select status as s from payment_slips where id = ${slip.id}::uuid`,
    );
    expect(row.rows[0]?.s).toBe('submitted');

    /* And with the column filled, the same statement is refused. */
    const named = await guestOrder('c1-named');
    const namedInstalment = await oneInstalment(named.id, named.grand);
    const namedSlip = await slipAs(named.id, { token: reviewer.token }, named.grand);

    await expectRejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into slip_allocations (slip_id, instalment_id, amount_thb_minor)
          values (${namedSlip.id}::uuid, ${namedInstalment}::uuid, ${named.grand.toString()}::bigint)
        `);
        await tx.execute(sql`
          update payment_slips set status = 'accepted',
                 reviewed_by_user_id = ${reviewer.userId}::uuid, reviewed_at = now()
           where id = ${namedSlip.id}::uuid
        `);
      }),
      /cannot review it/u,
    );

    /*
     * ⚠️ AND THE RESIDUAL, ASSERTED RATHER THAN DESCRIBED. An unclaimed guest is nobody, so
     * this one is still accepted — which is why B1 closes the chain at the refund instead.
     */
    const anon = await guestOrder('c1-anon');
    const anonInstalment = await oneInstalment(anon.id, anon.grand);
    const anonSlip = await slipAs(anon.id, { cookie: anon.cookie }, anon.grand);

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into slip_allocations (slip_id, instalment_id, amount_thb_minor)
        values (${anonSlip.id}::uuid, ${anonInstalment}::uuid, ${anon.grand.toString()}::bigint)
      `);
      await tx.execute(sql`
        update payment_slips set status = 'accepted',
               reviewed_by_user_id = ${reviewer.userId}::uuid, reviewed_at = now()
         where id = ${anonSlip.id}::uuid
      `);
    });

    const anonRow = await db.execute<{ s: string }>(
      sql`select status as s from payment_slips where id = ${anonSlip.id}::uuid`,
    );
    expect(anonRow.rows[0]?.s).toBe('accepted');
  }, 90_000);

  it('C2 DEFENDED: a refund cannot be disbursed with a null approver, though the CHECK alone would allow it', async () => {
    /*
     * `refunds_disburser_is_not_approver` is `disbursed_by IS NULL OR disbursed_by <> approved_by`
     * — null-permissive in exactly the same way as C1. What closes it is a *different*
     * constraint, `refunds_status_shape`, which demands `approved_by_user_id IS NOT NULL` on a
     * disbursed row. The service's own check (`refund.approvedByUserId === disburserUserId`)
     * would also pass on a null.
     *
     * So the two-person rule on the way out is held up by the status-shape CHECK and not by the
     * rule that is named after it. Removing `refunds_status_shape` for an unrelated reason would
     * silently reopen it.
     */
    const order = await guestOrder('c2');
    const instalmentId = await oneInstalment(order.id, order.grand);
    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand, {
      name: 'ผู้โอน',
      last4: '4321',
    });
    expect(
      (
        await call('POST', `/payments/slips/${slip.id}/acceptance`, {
          token: reviewer.token,
          body: {
            allocations: [{ instalmentId, amountThbMinor: encodeThb(order.grand) }],
            payer: { name: 'ผู้โอน', accountLast4: '4321' },
          },
        })
      ).status,
    ).toBe(200);

    await cancelWithScheduleClosed(db, {
      orderId: order.id,
      fromStatus: 'production_confirmed',
      actorKind: 'staff',
      actorUserId: reviewer.userId,
      reasonTh: 'ยกเลิก',
      fault: 'customer',
    });

    const requested = await call('POST', '/payments/refunds', {
      token: requester.token,
      body: { orderId: order.id },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const refundId = (requested.body as { refund: { id: string } }).refund.id;

    /* Straight to disbursed, approver never named. Refused — by the status shape. */
    const failure = await db
      .execute(sql`
        update refunds set status = 'disbursed', disbursed_by_user_id = ${requester.userId}::uuid,
               disbursed_at = now(), disbursement_reference = 'X'
         where id = ${refundId}::uuid
      `)
      .then(() => '')
      .catch((error: unknown) => String((error as { cause?: { message?: string } }).cause?.message ?? error));

    expect(failure).toMatch(/refunds_status_shape|does not go from/u);
  }, 90_000);

  /* ================================================================== *
   * D — the assembled system, as opposed to the four modules
   * ================================================================== */

  it('D1 CLOSED: submitting an order opens its schedule, and the freeze gate is no longer vacuous', async () => {
    /*
     * `ScheduleService.open()` had no caller. `OrdersService.submit` did not know the module
     * existed, so a real order submitted through the real route had **zero** instalments, and
     * three things followed that no unit test of any module could see:
     *
     *   `order_settled_through()` = NULL, so `order_gate_is_open(order,'production_confirmed')`
     *   was **true with ฿0.00 received** — the freeze gate was vacuous;
     *
     *   `planAllocations` had an empty instalment map, so every allocation was
     *   `instalment_not_on_this_order` and no slip could ever be accepted;
     *
     *   every attack in this file had to write the instalment row by hand.
     *
     * `PaymentLifecycleService` is the caller now, and it is called from the transaction that
     * stamps `submitted_at` — not after it, because a schedule written a statement later is a
     * window in which the order exists and its terms do not.
     */
    const order = await guestOrder('d1');

    const instalments = await db.execute<{ n: string; due: string; gate: string | null }>(
      sql`select count(*)::text as n, max(due_thb_minor)::text as due,
                 max(gates_entry_to::text) as gate
            from order_instalments where order_id = ${order.id}::uuid`,
    );
    expect(instalments.rows[0]?.n).toBe('1');
    /* Plan 13's documented default: gate coverage is payment in full, so one row, whole total. */
    expect(instalments.rows[0]?.due).toBe(order.grand.toString());
    expect(instalments.rows[0]?.gate).toBe('production_confirmed');

    const schedules = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from order_payment_schedules where order_id = ${order.id}::uuid`,
    );
    expect(schedules.rows[0]?.n).toBe('1');

    /* 🔒 The gate is SHUT on an order that has received nothing. This is the assertion that was
     * false before, and it is the one that decides whether aluminium gets cut. */
    const gate = await db.execute<{ open: boolean }>(
      sql`select order_gate_is_open(${order.id}::uuid, 'production_confirmed') as open`,
    );
    expect(gate.rows[0]?.open).toBe(false);

    /* And the schedule foots against the total the customer was quoted. */
    const foots = await db.execute<{ due: string; total: string }>(sql`
      select (select sum(due_thb_minor)::text from order_instalments where order_id = o.id) as due,
             o.grand_total_thb_minor::text as total
        from orders o where o.id = ${order.id}::uuid
    `);
    expect(foots.rows[0]?.due).toBe(foots.rows[0]?.total);

    const slip = await slipAs(order.id, { cookie: order.cookie }, order.grand);

    /* The review screen offers the row, and a suggestion the reviewer may take or ignore. */
    const screen = await call('GET', `/payments/slips/${slip.id}`, { token: reviewer.token });
    expect(screen.status).toBe(200);
    expect((screen.body as { instalments: readonly unknown[] }).instalments).toHaveLength(1);

    /* A fabricated id is still refused — the map is populated, not permissive. */
    const fabricated = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: [{ instalmentId: randomUUID(), amountThbMinor: encodeThb(order.grand) }],
      },
    });
    expect(fabricated.status).toBe(422);
    expect(fabricated.body).toMatchObject({
      error: { details: { reason: 'instalment_not_on_this_order' } },
    });

    /* And an empty allocation list — the "just confirm it" shape — is refused by the schema. */
    const empty = await call('POST', `/payments/slips/${slip.id}/acceptance`, {
      token: reviewer.token,
      body: { allocations: [] },
    });
    expect(empty.status).toBe(400);
  }, 90_000);

  /* ================================================================== *
   * A8 — is any of this actually served by the application?
   * ================================================================== */

  it('A8 CLOSED: the money routes are served by the shipped AppModule', async () => {
    /*
     * Every attack above needed `SlipsModule` and `RefundsModule` imported by hand: the shipped
     * graph was `AppModule.forRoot` alone and `/payments/slips` and `/payments/refunds` were
     * **404**. A module nobody imports is a module that does not exist, however green its own
     * suite is — which is the finding, and it is why this test boots the graph with nothing
     * added rather than the one the rest of this file uses.
     */
    const plain = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(paymentsEnv(url ?? ''), {
          session: testSessionConfig(),
          mfaSecretKey: testMfaSecretKey(),
          oauth: parseOAuthConfig({}),
        }),
      ],
    }).compile();

    const app = plain.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter(paymentsEnv(url ?? '')));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    try {
      for (const path of ['/payments/slips', '/payments/refunds']) {
        const response = await fetch(`${base}${path}`, {
          headers: { authorization: `Bearer ${reviewer.token}` },
        });
        /*
         * Served, and answering about authority rather than about existence. 401 rather than
         * 200: this is a second application instance with a session secret of its own, so the
         * token minted against the first one is not a token here — which is exactly the
         * distinction being asserted, because a route that does not exist answers 404 to a
         * bad credential just as readily as to a good one.
         */
        expect(response.status, path).not.toBe(404);
        expect([200, 401, 403]).toContain(response.status);
      }

      /* And with no credential at all: refused, not absent. */
      for (const path of ['/payments/slips', '/payments/refunds']) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(401);
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
