import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type {
  CancellationPreviewWire,
  OrderLineRequestWire,
  OrderWire,
} from '@wewin/contract/order';

import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type PaymentsApp,
} from '../payments/support/payments-app';
import {
  accountBalance,
  dropForfeitPolicy,
  giveOrderHeldMoney,
  seedForfeitPolicy,
} from '../payments/support/money-fixture';

/**
 * `GET /orders/:orderId/cancellation-preview` — and the one property that matters.
 *
 * ── The property ────────────────────────────────────────────────────────────────
 *
 * **The figure a customer is shown as the cost of cancelling is the figure the ledger keeps.**
 * Not "close to", not "computed the same way" — the same number, taken from the same call. The
 * storefront now has a cancel button that states a forfeit before it confirms, and a screen that
 * promises ฿0 while the ledger keeps ฿9,216 is the money-bug family this repository has found
 * three times already (plan 7.13: `scheduledDepositMinor` written three ways, answering ฿5,530
 * and ฿18,432 for the same 30/70 order).
 *
 * That is asserted the only way it can honestly be asserted: take the preview, perform the
 * cancellation, and compare the preview against the *posted ledger balance*. A test that
 * compared the preview against arithmetic restated here would be a fourth implementation
 * agreeing with itself.
 *
 * ── ⚠️ WITH A NON-ZERO POLICY, BECAUSE 0 bp PROVES NOTHING ──────────────────────
 *
 * The shipped `plan13_default` forfeits nothing in all twelve cells — deliberately; plan 13
 * records it as a default awaiting the owner's answer. Every assertion about the forfeit against
 * it is `0 === 0`, and stays green with the multiplication, the `least()`, the clamp and the
 * fault lookup all deleted. So this file publishes a policy with a real rate *before* it submits
 * the orders that pin it, and asserts the previewed figure is non-zero before comparing it to
 * anything. `refunds.pg.test.ts` learned this first; the note is repeated because a later reader
 * lowering the rate to zero would silently disarm the file.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** The fold the refund path reads. What is still owed back after a forfeit is debited. */
async function heldThbMinor(db: Database, orderId: string): Promise<bigint> {
  const result = await db.execute(sql`select order_held_thb_minor(${orderId}::uuid)::text as held`);
  const rows = (result as { rows?: unknown }).rows;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const held = row?.['held'];
  if (typeof held !== 'string') throw new Error('fixture: the held fold returned no row');
  return BigInt(held);
}

describeWithPg('what cancelling costs, stated before it is done', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;

  let customer: Actor;
  let stranger: Actor;
  /** Confirms the slip that closes the gate, and starts production. Both are staff-only moves. */
  let staff: Actor;
  let policyId: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `preview customer ${tag}`, []);
    stranger = await makeActor(db, app, `preview stranger ${tag}`, []);
    staff = await makeActor(db, app, `preview staff ${tag}`, [
      'orders.read',
      'orders.write',
      'payments.verify',
      'payments.read',
    ]);

    line = await liveLine(call);

    /*
     * Published before any order in this file is submitted, which is the whole reason it applies:
     * `orders.forfeit_policy_id` is pinned at submit, so a policy published afterwards cannot
     * reach backwards — that pin is the point of `0012_payment_closure.sql`.
     */
    policyId = await seedForfeitPolicy(db, {
      code: `preview_${tag}`.slice(0, 40),
      customerFaultBp: 5_000,
    });
  }, 90_000);

  afterAll(async () => {
    await dropForfeitPolicy(db, policyId);
    await app.close();
    await pool.end();
  });

  /** A submitted order holding the whole contract in cash, priced by the real submit. */
  async function orderHoldingMoney(label: string): Promise<{ order: OrderWire; grandTotal: bigint }> {
    const order = await submittedOrder(call, customer, line, {
      email: `preview-${label}-${tag}@probe.invalid`,
      name: `preview ${label} ${tag}`,
    });

    const money = order.money;
    if (money === null) throw new Error('fixture: the submit did not price the order');

    const grandTotal = toBigInt(money.grandTotalThbMinor);
    expect(grandTotal, 'the submit must have priced the order').toBeGreaterThan(0n);

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `preview payer ${tag}`,
      payerAccountLast4: '4321',
      reviewerUserId: staff.userId,
    });

    return { order, grandTotal };
  }

  async function preview(orderId: string, actor: Actor): Promise<CancellationPreviewWire> {
    const response = await call('GET', `/orders/${orderId}/cancellation-preview`, {
      token: actor.token,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as CancellationPreviewWire;
  }

  /* ================================================================ *
   * The one that matters
   * ================================================================ */

  /**
   * ⭐ THE LOAD-BEARING ASSERTION, pre-freeze.
   *
   * `awaiting_payment` × `customer` is 5,000 bp under the probe policy, so the previewed forfeit
   * is half the money held and every step of the arithmetic is observable. Then the customer
   * cancels — with `{ reason }` and nothing else, because that is the entire body a customer can
   * send — and the ledger is asked what it actually kept.
   */
  it('previews the exact figure the ledger then forfeits, and the exact figure it returns', async () => {
    const { order, grandTotal } = await orderHoldingMoney('pre-freeze');

    const quoted = await preview(order.id, customer);

    expect(quoted.fromStatus).toBe('awaiting_payment');
    expect(toBigInt(quoted.heldThbMinor)).toBe(grandTotal);

    /*
     * ⚠️ The guard that keeps this file honest. Under the shipped 0 bp policy every assertion
     * below is `0 === 0` and cannot fail; if this line ever trips, the comparison that follows
     * has stopped being evidence.
     */
    expect(toBigInt(quoted.forfeitThbMinor), '0 bp proves nothing — see the file header').toBeGreaterThan(0n);
    expect(toBigInt(quoted.refundThbMinor)).toBe(grandTotal - toBigInt(quoted.forfeitThbMinor));

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'เปลี่ยนใจ ขอยกเลิกครับ' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((cancelled.body as OrderWire).status).toBe('cancelled');

    /* What was kept, off the ledger — not off a formula this test restated. */
    expect(await accountBalance(db, order.id, 'forfeited')).toBe(-toBigInt(quoted.forfeitThbMinor));

    /* And what is still owed back, which is what `RefundsService.request` will refund. */
    expect(await heldThbMinor(db, order.id)).toBe(toBigInt(quoted.refundThbMinor));
  }, 60_000);

  /**
   * ⭐ THE LOAD-BEARING ASSERTION, post-freeze — where the money actually hurts.
   *
   * The brief's real question: a customer cancelling after aluminium has been committed. `fault`
   * is derived as `'customer'` from the actor and nothing in the request can change that, so the
   * preview prices the only cancellation this person can make. `in_production` × `customer` is
   * 5,000 bp; `production_confirmed` is pinned to 0 by CHECK and would prove nothing.
   */
  it('prices a post-freeze cancellation the customer can actually make, and the ledger agrees', async () => {
    const { order, grandTotal } = await orderHoldingMoney('post-freeze');

    const confirmed = await call('POST', `/orders/${order.id}/transitions/production_confirmed`, {
      token: staff.token,
      body: {},
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const started = await call('POST', `/orders/${order.id}/transitions/in_production`, {
      token: staff.token,
      body: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((started.body as OrderWire).isFrozen).toBe(true);

    const quoted = await preview(order.id, customer);
    expect(quoted.fromStatus).toBe('in_production');
    expect(toBigInt(quoted.forfeitThbMinor), '0 bp proves nothing').toBeGreaterThan(0n);
    expect(toBigInt(quoted.heldThbMinor)).toBe(grandTotal);

    /*
     * 🔒 `{ reason }` only. A customer has no field through which to attribute fault — see
     * `CancelOrderRequestWire`, which does not have one, and `faultFor`, which returns
     * `'customer'` for every non-staff actor before it looks at anything else.
     */
    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'ขอยกเลิกแม้จะเริ่มผลิตแล้ว' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    expect(await accountBalance(db, order.id, 'forfeited')).toBe(-toBigInt(quoted.forfeitThbMinor));
    expect(await heldThbMinor(db, order.id)).toBe(toBigInt(quoted.refundThbMinor));
  }, 60_000);

  /* ================================================================ *
   * Who may ask, and when there is nothing to ask about
   * ================================================================ */

  /**
   * The availability gate is `order_status_transitions`, not a list of statuses in the service.
   *
   * A cancelled order has no outgoing `cancelled` edge — the table has no `(cancelled, cancelled)`
   * row and could not have one, `order_status_transitions_no_self_loop` forbids it. So there is
   * no cancellation to price and saying so is a conflict, not a ฿0 preview that reads as "free".
   */
  it('refuses to price a cancellation the table does not offer', async () => {
    const { order } = await orderHoldingMoney('already-over');

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customer.token,
      body: { reason: 'ยกเลิกรอบแรก' },
    });
    expect(cancelled.status).toBe(200);

    const again = await call('GET', `/orders/${order.id}/cancellation-preview`, {
      token: customer.token,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
  }, 60_000);

  /**
   * Ownership is the shape of the query, and this route is no exception.
   *
   * A signed-in stranger gets the same 404 a nonexistent order gets — `ScopedOrderRepository`
   * collapses "not yours" and "no such order" so the difference cannot be used to learn which
   * ids exist. A preview that leaked what somebody else's cancellation would cost would be
   * leaking what they have paid.
   */
  it('is somebody else\'s order to nobody else', async () => {
    const { order } = await orderHoldingMoney('not-yours');

    const peeked = await call('GET', `/orders/${order.id}/cancellation-preview`, {
      token: stranger.token,
    });
    expect(peeked.status, JSON.stringify(peeked.body)).toBe(404);
  }, 60_000);
});
