import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { notifications, orderEvents } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type {
  OrderEventListWire,
  OrderEventWire,
  OrderLineRequestWire,
  OrderWire,
} from '@wewin/contract/order';

import { guestCookieName } from '../../src/rbac/guest-cookie';
import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type Json,
  type LifecycleApp,
} from './support/lifecycle-app';

/**
 * The nine statuses, every legal move, and the four traps that are this module's — over real
 * HTTP, against a real Postgres, with nothing stubbed.
 *
 * Nothing here is asserted through a service call, because every property this round is about
 * lives *between* the layers:
 *
 *   - the transition table, the payload-key check and the freeze stamp are in the database,
 *     so a test that never issues a statement never meets them;
 *   - the ownership term is a WHERE clause, and a mock has no WHERE clause;
 *   - the outbox is written by a trigger inside the transition's own transaction, which is
 *     not observable from anywhere except a connection that can read the rows afterwards.
 *
 * ── What is deliberately not cleaned up ─────────────────────────────────────────
 *
 * Submitted orders. `orders_block_delete()` refuses to delete anything but a never-submitted
 * draft, correctly — an order is an accounting record — so a teardown that could remove one
 * would be a teardown contradicting the schema under test. Rows are tagged with a per-run id
 * and left behind, exactly as `packages/db/tests/order.test.ts` decided for the same reason.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `orders-${who}-${tag}@probe.invalid`,
  name: `orders lifecycle probe ${tag}`,
});

describeWithPg('the order lifecycle end to end', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  let staff: Actor;
  let customerA: Actor;
  let customerB: Actor;

  /** A published product, its live catalogue handle, and a line configured at its defaults. */
  let line: OrderLineRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    staff = await makeActor(db, app, `orders probe staff ${tag}`, ['orders.read', 'orders.write']);
    customerA = await makeActor(db, app, `orders probe customer A ${tag}`, []);
    customerB = await makeActor(db, app, `orders probe customer B ${tag}`, []);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    /*
     * No citation cleanup any more, and its removal is the point.
     *
     * This hook used to delete `order_document_product_versions` rows for this suite's own
     * orders, because `order_document_versions_block_truncate()` refuses `seedCatalog` on any
     * database carrying a contract — and `globalSetup` seeded before every run, so one
     * submitted order made the whole suite unrunnable from the second run onward. That was a
     * workaround, it was documented as one, and it leaked: an order whose contact address did
     * not match the regex turned 116 catalogue tests into skips.
     *
     * The suite now runs against a database `globalSetup` creates empty every time
     * (`tests/test-db.ts`), so there is nothing to clean up and the production rule is left
     * exactly as it is. Deleting evidence to make a test suite re-runnable was always the
     * wrong half of the problem to solve.
     */
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Helpers that speak the API
   * ---------------------------------------------------------------- */

  const create = async (auth: { token?: string; cookie?: string }): Promise<Json> =>
    call('POST', '/orders', { ...auth, body: {} });

  const move = async (
    orderId: string,
    toStatus: string,
    auth: { token?: string; cookie?: string },
    body: unknown = {},
  ): Promise<Json> => call('POST', `/orders/${orderId}/transitions/${toStatus}`, { ...auth, body });

  const submit = async (
    orderId: string,
    auth: { token?: string; cookie?: string },
    who: string,
  ): Promise<Json> => move(orderId, 'awaiting_payment', auth, { contact: contactFor(who), lines: [line] });

  /** A submitted, unfrozen order owned by customer A. The starting point for most blocks. */
  const submittedOrder = async (who: string): Promise<OrderWire> => {
    const created = await create({ token: customerA.token });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;

    const submitted = await submit(draft.id, { token: customerA.token }, who);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return submitted.body as OrderWire;
  };

  const eventsOf = async (orderId: string): Promise<readonly OrderEventWire[]> => {
    const answer = await call('GET', `/orders/${orderId}/events`, { token: staff.token });
    expect(answer.status).toBe(200);
    return (answer.body as OrderEventListWire).events;
  };

  const lastEvent = async (orderId: string, eventType: string): Promise<OrderEventWire> => {
    const found = [...(await eventsOf(orderId))].reverse().find((event) => event.eventType === eventType);
    if (!found) throw new Error(`no ${eventType} event on order ${orderId}`);
    return found;
  };

  /* ---------------------------------------------------------------- *
   * The funnel
   * ---------------------------------------------------------------- */

  it('starts a cart for a visitor who has nothing — and gives them the referent for it', async () => {
    /*
     * Plan section 6: the anonymous visitor is the main funnel, and `POST /orders` is the one
     * route that mints the principal the rest of the module requires. A `guests` row is a
     * write, which is why the guard does not do it — it would create a row per crawler.
     */
    const created = await create({});
    expect(created.status).toBe(201);

    const cookie = created.headers.get('set-cookie');
    expect(cookie).toContain(`${guestCookieName(false)}=`);
    expect(cookie).toContain('HttpOnly');

    const order = created.body as OrderWire;
    expect(order.status).toBe('draft');
    expect(order.isFrozen).toBe(false);
    /* A cart is not numbered: burning a sequence on browsing publishes the abandonment rate. */
    expect(order.orderNo).toBeNull();
    expect(order.money).toBeNull();

    /* And the guest can act on it on the next request, with only the cookie. */
    const asGuest = await call('GET', `/orders/${order.id}`, { cookie: cookieHeader(cookie) });
    expect(asGuest.status).toBe(200);
  });

  it('refuses every order route to a caller with no principal at all', async () => {
    const order = await submittedOrder('anon');

    for (const [method, path] of [
      ['GET', `/orders/${order.id}`],
      ['GET', `/orders/${order.id}/events`],
      ['GET', `/orders/${order.id}/document`],
      ['GET', '/orders'],
    ] as const) {
      const answer = await call(method, path, {});
      expect(answer.status, `${method} ${path}`).toBe(401);
    }
  });

  /* ---------------------------------------------------------------- *
   * Submit — trap 3
   * ---------------------------------------------------------------- */

  it('pins a document at submit, numbers the order, and prices it itself', async () => {
    const order = await submittedOrder('pin');

    expect(order.status).toBe('awaiting_payment');
    expect(order.orderNo).toMatch(/^WW-\d+$/);
    expect(order.submittedAt).not.toBeNull();
    expect(order.isFrozen).toBe(false);
    expect(order.documentRevision).toBe(1);

    const money = order.money;
    if (!money) throw new Error('a submitted order has money');

    /* Plan 4.4: the three columns foot, and `grand_total` is the VAT-inclusive one. */
    expect(toBigInt(money.grandTotalThbMinor)).toBe(
      toBigInt(money.netThbMinor) + toBigInt(money.vatThbMinor),
    );
    expect(toBigInt(money.vatThbMinor)).toBeGreaterThan(0n);

    /*
     * ⚠️ Plan 13's default, asserted *as* the default: the deposit obligation is the whole
     * amount until the owner answers. If somebody quietly introduces a 30% placeholder, this
     * fails and the conversation happens.
     */
    expect(toBigInt(money.scheduledDepositThbMinor)).toBe(toBigInt(money.grandTotalThbMinor));

    const document = await call('GET', `/orders/${order.id}/document`, { token: customerA.token });
    expect(document.status).toBe(200);
    const pinned = document.body as { documentHash: string; lines: readonly { productVersionId: string }[] };
    expect(pinned.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.lines[0]?.productVersionId).toBe(line.productVersionId);
  });

  it('refuses a submit whose catalogue handle has moved under it', async () => {
    const created = await create({ token: customerA.token });
    const draft = created.body as OrderWire;

    const stale = await move(draft.id, 'awaiting_payment', { token: customerA.token }, {
      contact: contactFor('stale'),
      lines: [{ ...line, documentHash: 'f'.repeat(64) }],
    });

    expect(stale.status).toBe(409);
    /* And nothing was written: the order is still a cart. */
    const after = await call('GET', `/orders/${draft.id}`, { token: customerA.token });
    expect((after.body as OrderWire).status).toBe('draft');
  });

  /* ---------------------------------------------------------------- *
   * The outbox — plan 10.1
   * ---------------------------------------------------------------- */

  it('queues the notifications in the same transaction as the event, without being asked', async () => {
    const order = await submittedOrder('outbox');
    const event = await lastEvent(order.id, 'submitted_for_payment');

    const queued = await db
      .select({
        eventId: notifications.eventId,
        templateKey: notifications.templateKey,
        recipientKind: notifications.recipientKind,
        status: notifications.status,
        recipientKey: notifications.recipientKey,
      })
      .from(notifications)
      .where(eq(notifications.orderId, order.id));

    /*
     * Nothing in `orders.service.ts` mentions notifications. These rows exist because the
     * fan-out trigger runs on the spine — plan 10.1's whole argument, made structural: there
     * is no call for a service to forget and no rollback that can leave one behind.
     */
    expect(queued.length).toBeGreaterThanOrEqual(2);
    expect(queued.map((row) => row.recipientKind).sort()).toStrictEqual(['customer', 'sales_queue']);
    expect(queued.every((row) => row.eventId === event.id)).toBe(true);
    expect(queued.every((row) => row.status === 'pending')).toBe(true);

    const customerRow = queued.find((row) => row.recipientKind === 'customer');
    expect(customerRow?.recipientKey).toBe(`email:${contactFor('outbox').email}`);

    /* The same transaction, as a fact rather than as a comment. */
    const [spine] = await db
      .select({ writeTxid: orderEvents.writeTxid })
      .from(orderEvents)
      .where(eq(orderEvents.id, event.id));
    expect(spine?.writeTxid).toMatch(/^\d+$/);
  });

  /* ---------------------------------------------------------------- *
   * The freeze point, and the moves after it
   * ---------------------------------------------------------------- */

  /**
   * ⚠️ TWO CLOCKS. `orders_frozen_after_submitted` compares `submitted_at` against
   * `frozen_at`, and the freeze is stamped by a trigger with Postgres's `now()`. So
   * `submitted_at` may not come from the API process's clock: the API and the database are
   * separate containers, their clocks drift apart by tens of milliseconds as a matter of
   * course, and nothing keeps them in step.
   *
   * The consequence is not a wrong timestamp — it is a **refusal**. An order submitted while
   * the API is ahead of the database, and confirmed for production before the database's
   * clock catches up, violates the CHECK and the transition fails. The customer has paid; the
   * order will not move. It is worst exactly when it is least excusable, because the window
   * is "confirmed quickly".
   *
   * Found in phase 7 as a red `packages/db` suite that passed alone and failed after another
   * file — the measured skew on this machine was 25 ms, and warming the pool was enough to
   * bring the two writes inside it. The suite's own config blamed process collision and set
   * `maxWorkers: 1`, which is why it came back.
   *
   * Winding Node's clock a minute forward is the whole test: it is what container drift does,
   * only large enough to be certain rather than lucky. `sql`now()`` passes; `new Date()` — the
   * code this replaced — fails on the transition below.
   */
  it('submits with the database clock, so a fast confirmation is not refused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const order = await submittedOrder('skew');

      const confirmed = await move(order.id, 'production_confirmed', { token: staff.token });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks the happy path to delivered, freezing exactly once', async () => {
    const order = await submittedOrder('happy');

    /* The customer may not confirm their own payment: the transition row says `{staff,system}`. */
    const selfConfirm = await move(order.id, 'production_confirmed', { token: customerA.token });
    expect(selfConfirm.status).toBe(403);

    const confirmed = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const frozen = confirmed.body as OrderWire;
    expect(frozen.status).toBe('production_confirmed');
    /* Stamped by the database on entry — no caller passes it, and no caller could. */
    expect(frozen.isFrozen).toBe(true);
    expect(frozen.frozenAt).not.toBeNull();

    for (const next of ['in_production', 'awaiting_installation', 'delivered'] as const) {
      const moved = await move(order.id, next, { token: staff.token });
      expect(moved.status, `${next}: ${JSON.stringify(moved.body)}`).toBe(200);
      expect((moved.body as OrderWire).status).toBe(next);
    }

    const delivered = await call('GET', `/orders/${order.id}`, { token: staff.token });
    /* Terminal: the transition table has no row out of `delivered`. */
    expect((delivered.body as OrderWire).availableTransitions).toStrictEqual([]);
    expect((delivered.body as OrderWire).frozenAt).toBe(frozen.frozenAt);
  });

  it('bounces to redesign and back without re-dating the freeze — plan 7.2', async () => {
    const order = await submittedOrder('bounce');
    await move(order.id, 'production_confirmed', { token: staff.token });

    const started = await move(order.id, 'in_production', { token: staff.token });
    const frozenAt = (started.body as OrderWire).frozenAt;

    const bounced = await move(order.id, 'redesign', { token: staff.token }, {
      reason: 'โปรไฟล์บางเกินไปสำหรับช่วงกว้างนี้',
    });
    expect(bounced.status, JSON.stringify(bounced.body)).toBe(200);
    expect((bounced.body as OrderWire).status).toBe('redesign');
    /* A redesign has a contract, money and production history — which is why it is not `draft`. */
    expect((bounced.body as OrderWire).isFrozen).toBe(true);

    const approved = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body as OrderWire).status).toBe('production_confirmed');

    /*
     * The order froze the first time, and that is the date the money rules are about. A second
     * entry into `production_confirmed` must not re-stamp it — the constraint is in the
     * database, and this is the path that would have exercised the bug.
     */
    expect((approved.body as OrderWire).frozenAt).toBe(frozenAt);

    /* What the company absorbed is *recorded*, derived by subtraction, never typed by a human. */
    const event = await lastEvent(order.id, 'redesign_approved');
    expect(event.payload['absorbed_delta_thb_minor']).toBe('0');
    expect(event.payload['contracted_revision']).toBe(1);
  });

  /* ---------------------------------------------------------------- *
   * Trap 4 — the payload schema is chosen after the order is loaded
   * ---------------------------------------------------------------- */

  it('records `fault` on a post-freeze cancellation, which the pre-freeze schema has no field for', async () => {
    const order = await submittedOrder('cancel-post');
    await move(order.id, 'production_confirmed', { token: staff.token });

    const cancelled = await move(order.id, 'cancelled', { token: customerA.token }, {
      reason: 'ลูกค้าเปลี่ยนใจหลังยืนยันการชำระเงิน',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((cancelled.body as OrderWire).status).toBe('cancelled');

    /*
     * ⚠️ THE TRAP, AS AN ASSERTION. The client sent `{reason}` and nothing else, exactly as it
     * would for a pre-freeze cancellation. The stored event carries `fault` — which the
     * pre-freeze payload kind has no field for and `required_payload_keys` refuses to do
     * without. A service that chose its schema from the destination status would have
     * produced an event with no `fault` and the INSERT would have failed; a service that
     * chose it *and* dropped the database check would have cancelled a frozen order with the
     * refund question silently unanswered.
     */
    const event = await lastEvent(order.id, 'cancelled');
    expect(event.payload['fault']).toBe('customer');
    expect(event.payload['reason']).toBeTypeOf('string');

    /* And the freeze survives the cancellation, which is why the report reads `frozen_at`. */
    expect((cancelled.body as OrderWire).isFrozen).toBe(true);
  });

  it('carries no `fault` on a pre-freeze cancellation, because there is no money to divide', async () => {
    const order = await submittedOrder('cancel-pre');

    const cancelled = await move(order.id, 'cancelled', { token: customerA.token }, {
      reason: 'ยังไม่ได้โอนเงิน เปลี่ยนใจก่อน',
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as OrderWire).isFrozen).toBe(false);

    const event = await lastEvent(order.id, 'cancelled');
    expect(event.payload['fault']).toBeUndefined();
  });

  it('refuses to attribute fault to the company on an order with no bounce on record', async () => {
    const order = await submittedOrder('fault-claim');
    await move(order.id, 'production_confirmed', { token: staff.token });

    /* 🔒 Plan 7.8: staff may claim it, and the claim is checked against the spine. */
    const refused = await move(order.id, 'cancelled', { token: staff.token }, {
      reason: 'ยกเลิกโดยฝ่ายขาย',
      attributeFaultToCompany: true,
    });
    expect(refused.status).toBe(422);

    /* A customer cannot even name the field. */
    const stripped = await move(order.id, 'cancelled', { token: customerA.token }, {
      reason: 'ขอยกเลิก',
      attributeFaultToCompany: true,
    });
    expect(stripped.status).toBe(400);
  });

  it('attributes fault to the company when the factory really did bounce it', async () => {
    const order = await submittedOrder('fault-company');
    await move(order.id, 'production_confirmed', { token: staff.token });
    await move(order.id, 'redesign', { token: staff.token }, { reason: 'ทำไม่ได้ตามแบบ' });

    const cancelled = await move(order.id, 'cancelled', { token: staff.token }, {
      reason: 'แก้แบบแล้วยังผลิตไม่ได้',
      attributeFaultToCompany: true,
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const event = await lastEvent(order.id, 'cancelled');
    expect(event.payload['fault']).toBe('company');
  });

  /* ---------------------------------------------------------------- *
   * Trap 5 — a change request with something that clears it
   * ---------------------------------------------------------------- */

  it('blocks the freeze while an objection is open, and lets a second one be raised once it is answered', async () => {
    const order = await submittedOrder('objection');

    const opened = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอเปลี่ยนสีเฟรมเป็นสีดำ' },
    });
    expect(opened.status).toBe(201);
    const first = opened.body as { id: string };

    /* Plan 10.4: the freeze does not happen over an unanswered objection. */
    const blocked = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(blocked.status).toBe(409);

    /* Trap 5's first half: a second request while one is open is refused, not silently queued. */
    const second = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอเปลี่ยนอีกอย่างหนึ่ง' },
    });
    expect(second.status).toBe(409);

    /* The customer may withdraw their own; only staff may answer one. */
    const answeredByCustomer = await call(
      'POST',
      `/orders/${order.id}/change-requests/${first.id}/resolution`,
      { token: customerA.token, body: { resolution: 'accepted' } },
    );
    expect(answeredByCustomer.status).toBe(403);

    const resolved = await call(
      'POST',
      `/orders/${order.id}/change-requests/${first.id}/resolution`,
      { token: staff.token, body: { resolution: 'rejected', noteTh: 'สีดำไม่มีในรุ่นนี้' } },
    );
    expect(resolved.status).toBe(200);

    /*
     * Trap 5's second half, and the reason the partial index is a fix rather than the bug:
     * the *next* request is possible. Without a resolution path the first objection would
     * block every later one for the lifetime of the order.
     */
    const third = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'งั้นขอเลื่อนวันติดตั้ง' },
    });
    expect(third.status).toBe(201);

    await call('POST', `/orders/${order.id}/change-requests/${(third.body as { id: string }).id}/resolution`, {
      token: staff.token,
      body: { resolution: 'accepted' },
    });

    const unblocked = await move(order.id, 'production_confirmed', { token: staff.token });
    expect(unblocked.status, JSON.stringify(unblocked.body)).toBe(200);
  });

  it('refuses a child row against an order that has moved on — trap 6, from the API side', async () => {
    /*
     * Plan 7.4 trap 6 is about slip upload, which is 5b's. The *mechanism* is general and is
     * already in the database: `order_child_require_status()` re-reads the parent under
     * `FOR SHARE`, so a child insert racing a transition blocks and then sees the winner's
     * status rather than its own stale snapshot. `FOR UPDATE` in the transition orders the
     * race; it does not forbid the write, and this trigger is what forbids it.
     *
     * The only child table 5a writes is `order_change_requests`, so this is the API's half:
     * the refusal arrives as a 409 a client can act on rather than as an untranslated 500.
     * SEAM 5b: `slips` attaches to the same function with `'{awaiting_payment}'`.
     */
    const order = await submittedOrder('trap6');
    const cancelled = await move(order.id, 'cancelled', { token: customerA.token }, {
      reason: 'ยกเลิกก่อนโอนเงิน',
    });
    expect(cancelled.status).toBe(200);

    const late = await call('POST', `/orders/${order.id}/change-requests`, {
      token: customerA.token,
      body: { noteTh: 'ขอแก้ไขหลังยกเลิกไปแล้ว' },
    });
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toContain('CONFLICT');
  });

  /* ---------------------------------------------------------------- *
   * Trap 2 — ownership is in the query
   * ---------------------------------------------------------------- */

  it('does not tell customer B that customer A has an order', async () => {
    const order = await submittedOrder('tenancy');

    for (const [method, path] of [
      ['GET', `/orders/${order.id}`],
      ['GET', `/orders/${order.id}/events`],
      ['GET', `/orders/${order.id}/document`],
    ] as const) {
      const answer = await call(method, path, { token: customerB.token });
      /* 404 and not 403: "exists but not yours" is an oracle for enumerating order ids. */
      expect(answer.status, `${method} ${path}`).toBe(404);
      /*
       * And not a byte of A's order in the body. The id itself is excluded from this check
       * on purpose — it is echoed in `path` because B sent it, and refusing to repeat what
       * the caller wrote would prove nothing. What must not appear is anything B did not
       * already have: the customer-facing number, the contact, the money.
       */
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(order.orderNo ?? 'WW-');
      expect(text).not.toContain(contactFor('tenancy').email);
    }

    const cancelled = await move(order.id, 'cancelled', { token: customerB.token }, { reason: 'ไม่ใช่ของฉัน' });
    expect(cancelled.status).toBe(404);

    const listed = await call('GET', '/orders', { token: customerB.token });
    expect(JSON.stringify(listed.body)).not.toContain(order.id);
  });

  it('shows staff the order and a customer only their own', async () => {
    const order = await submittedOrder('queues');

    const asStaff = await call('GET', '/orders?status=awaiting_payment&limit=200', { token: staff.token });
    expect(asStaff.status).toBe(200);
    expect(JSON.stringify(asStaff.body)).toContain(order.id);

    const asOwner = await call('GET', '/orders', { token: customerA.token });
    expect(JSON.stringify(asOwner.body)).toContain(order.id);
  });

  /* ---------------------------------------------------------------- *
   * Illegal moves
   * ---------------------------------------------------------------- */

  it('refuses a move the transition table does not have a row for', async () => {
    const order = await submittedOrder('illegal');

    /* `awaiting_payment → delivered` is not a row, and skipping production is not a shortcut. */
    const skipped = await move(order.id, 'delivered', { token: staff.token });
    expect(skipped.status).toBe(409);

    /* `superseded` is reachable only from `redesign` — on purpose, and it is one INSERT to change. */
    const superseded = await move(order.id, 'superseded', { token: staff.token }, { reason: 'x' });
    expect(superseded.status).toBe(409);

    /* And a status nobody has heard of is a 400 before it can reach a query. */
    const nonsense = await move(order.id, 'shipped', { token: staff.token });
    expect(nonsense.status).toBe(400);
  });

  it('supersedes only through redesign, and creates the successor the customer must approve', async () => {
    const order = await submittedOrder('supersede');
    await move(order.id, 'production_confirmed', { token: staff.token });
    await move(order.id, 'redesign', { token: staff.token }, { reason: 'ส่วนต่างสูงเกินกว่าจะรับไว้เอง' });

    const superseded = await move(order.id, 'superseded', { token: staff.token }, {
      reason: 'ออกใบใหม่ให้ลูกค้าอนุมัติ',
    });
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(200);

    const replaced = superseded.body as OrderWire;
    expect(replaced.status).toBe('superseded');
    /*
     * `superseded` without a successor is a cancellation wearing a better word, and the money
     * already received would have nowhere to be carried to. The database refuses it; this is
     * the successor being created in the same transaction so the refusal never fires.
     *
     * SEAM 5b: the money follows this pointer as an allocation carrying
     * `carried_from_order_id`, never as an instalment row on the new order (plan 7.8).
     */
    expect(replaced.supersededByOrderId).not.toBeNull();

    const successor = await call('GET', `/orders/${replaced.supersededByOrderId ?? ''}`, {
      token: staff.token,
    });
    expect(successor.status).toBe(200);
    expect((successor.body as OrderWire).status).toBe('draft');
    expect((successor.body as OrderWire).supersedesOrderId).toBe(order.id);
  });
});

/**
 * ⚠️ Drop this run's catalogue citations, so the next run can seed at all.
 *
 * `order_document_versions_block_truncate()` (0007) refuses `TRUNCATE categories, products,
 * option_groups CASCADE` while *any* row cites a catalogue version — because that cascade
 * ignores `ON DELETE RESTRICT` and would leave every pinned document with its money and no
 * record of what it was priced from. That guard is right, and `tests/globalSetup.ts` seeds
 * unconditionally before every run, so a suite that submits an order and leaves the citations
 * behind makes the *whole* api suite unrunnable from the second run onward — including the
 * fidelity and admin suites, which fail inside `seedCatalog` with a message about orders.
 *
 * Only the join rows go, and only for this file's probe orders. The orders and their frozen
 * documents stay: `orders_block_delete()` refuses a submitted order and `order_documents_freeze`
 * refuses its document, both correctly, and a teardown that could remove them would be a
 * teardown contradicting the schema under test.
 *
 * What this costs is stated rather than hidden: those probe documents keep their totals and
 * lose the link to the versions they were priced from — exactly the loss the trigger exists
 * to prevent, accepted here for rows created by this file and nowhere else.
 *
 * 🚩 **This is a workaround for a real conflict that needs a decision, not a fix.** The
 * production rule ("a database with contracts cannot be re-seeded") and the test architecture
 * ("every run re-seeds") cannot both hold. The durable answers are a separate test database
 * per suite, or a seed that reconciles instead of truncating.
 */
/** The cookie value alone, as a request header. */
function cookieHeader(setCookie: string | null): string {
  const first = setCookie?.split(';')[0];
  if (first === undefined) throw new Error('no cookie was set');
  return first;
}

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * The handle comes from `GET /catalog/products` rather than from the fixture table, because
 * that pair is what trap 3 pins and a hard-coded one would be stale the first time anything
 * republishes. The configuration comes from the fixture product of the same id, which the
 * fidelity suite already proves is byte-identical to what the database serves.
 */
async function liveLine(call: ReturnType<typeof client>): Promise<OrderLineRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as { products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[] };

  for (const published of wire.products) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to order');
}
