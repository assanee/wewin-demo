import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { encodeThb } from '@wewin/contract/order';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { makePng } from '../../media/fixtures';
import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type Json,
  type PaymentsApp,
} from '../support/payments-app';
import { folds, ledgerKinds, uploadImage, writeThirtySeventy } from '../slips/support/slips-app';

/**
 * The seam between the order lifecycle and the money — walked through the real application.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────
 *
 * 5b shipped four modules — schedule, slips, ledger, refunds — each with a green suite of its
 * own, and the red team measured what the assembled system did with them:
 *
 *   an order submitted through the real route had **0 instalments**, so
 *   `order_gate_is_open(order,'production_confirmed')` was **true with ฿0.00 received** and no
 *   slip could ever be accepted;
 *
 *   a delivered, installed, fully paid job's entire ledger was `bank_thb` +฿19,722.24 against
 *   `deposit_held` −฿19,722.24, with `revenue` **empty, for ever**;
 *
 *   an order that had taken a deposit could not be cancelled by any ordering of statements,
 *   and could not be superseded, so plan 7.8's carry was dead code and a customer whose quote
 *   was revised was billed the whole contract a second time.
 *
 * Every one of those is the same omission — two systems and a seam with nobody standing in it —
 * and every one of them is invisible to a test that boots one module. `PaymentLifecycleService`
 * is the person standing in the seam; this is its suite, and it exercises it only through
 * `OrdersService`, because "does anything call it?" is the question that was answered wrong.
 *
 * ⚠️ Every number below is produced by the application from the published catalogue. Nothing
 * here fabricates an `orders` row, and the one thing it writes by hand — the 30/70 schedule —
 * goes through `ScheduleService.replace`, the method 5c's authoring route will call.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('the order lifecycle and the money are one transaction', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;

  let customer: Actor;
  let reviewer: Actor;
  let staff: Actor;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `lifecycle customer ${tag}`, []);
    reviewer = await makeActor(db, app, `lifecycle reviewer ${tag}`, [
      'payments.verify',
      'payments.read',
      'orders.read',
      'orders.write',
    ]);
    staff = await makeActor(db, app, `lifecycle staff ${tag}`, ['orders.read', 'orders.write']);

    line = await liveLine(call);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ------------------------------------------------------------------ *
   * Helpers — all through routes, none through raw SQL
   * ------------------------------------------------------------------ */

  const order = async (who: string): Promise<{ id: string; grand: bigint }> => {
    const wire = await submittedOrder(call, customer, line, {
      email: `lifecycle-${who}-${tag}@probe.invalid`,
      name: `lifecycle probe ${tag}`,
    });

    return { id: wire.id, grand: toBigInt(wire.grandTotalThbMinor ?? never()) };
  };

  const never = (): never => {
    throw new Error('a submitted order has a grand total');
  };

  const slip = async (orderId: string, amount: bigint): Promise<string> => {
    const uploaded = await uploadImage(
      app.baseUrl,
      `/orders/${orderId}/payment-slips/image`,
      customer.token,
      makePng(),
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);

    const created = await call('POST', `/orders/${orderId}/payment-slips`, {
      token: customer.token,
      body: {
        imageHandle: (uploaded.body as { imageHandle: string }).imageHandle,
        amountThbMinor: encodeThb(amount),
        transferredAt: new Date().toISOString(),
        bankReference: `LC-${randomUUID().slice(0, 8)}`,
        payerName: 'สมชาย ใจดี',
        payerAccountLast4: '4321',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body as { id: string }).id;
  };

  const accept = async (slipId: string, allocations: readonly { id: string; amount: bigint }[]): Promise<Json> =>
    call('POST', `/payments/slips/${slipId}/acceptance`, {
      token: reviewer.token,
      body: {
        allocations: allocations.map((allocation) => ({
          instalmentId: allocation.id,
          amountThbMinor: encodeThb(allocation.amount),
        })),
        payer: { name: 'สมชาย ใจดี', accountLast4: '4321' },
      },
    });

  const move = async (orderId: string, to: string, actor: Actor, body: unknown = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/${to}`, { token: actor.token, body });

  const instalments = async (orderId: string): Promise<{ id: string; due: bigint; seq: number }[]> => {
    const rows = await db.execute<{ id: string; due: string; seq: number }>(sql`
      select id::text as id, due_thb_minor::text as due, seq
        from order_instalments where order_id = ${orderId}::uuid order by seq
    `);
    return rows.rows.map((row) => ({ id: row.id, due: BigInt(row.due), seq: row.seq }));
  };

  const account = async (orderId: string, name: string): Promise<bigint> => {
    const rows = await db.execute<{ amount: string }>(
      sql`select order_account_thb_minor(${orderId}::uuid, ${name})::text as amount`,
    );
    return BigInt(rows.rows[0]?.amount ?? '0');
  };

  const gateOpen = async (orderId: string): Promise<boolean> => {
    const rows = await db.execute<{ open: boolean }>(
      sql`select order_gate_is_open(${orderId}::uuid, 'production_confirmed') as open`,
    );
    return rows.rows[0]?.open ?? false;
  };

  /* ================================================================== *
   * Submit
   * ================================================================== */

  /**
   * The three things a submit pins, and the one that made the gate a lie.
   *
   * Plan 7.13 lists seven pins at `submit_for_payment`; two of them are money and both were
   * missing. `scheduled_deposit_thb_minor` came from a **second implementation** —
   * `divRoundHalfUp(grand × SCHEDULED_DEPOSIT_BP_DEFAULT, 10000)` — which agreed with the
   * schedule only while the default gate coverage was payment in full, and `forfeit_policy_id`
   * did not exist, so a policy published between contract and cancellation changed what that
   * customer got back.
   */
  it('opens the schedule, pins the deposit from it, and pins the forfeit policy — all in the submit', async () => {
    const { id, grand } = await order('submit');

    const rows = await instalments(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.due).toBe(grand);

    const pinned = await db.execute<{ deposit: string; policy: string | null; schedules: string }>(sql`
      select o.scheduled_deposit_thb_minor::text as deposit,
             o.forfeit_policy_id::text as policy,
             (select count(*)::text from order_payment_schedules s where s.order_id = o.id) as schedules
        from orders o where o.id = ${id}::uuid
    `);
    expect(pinned.rows[0]?.schedules).toBe('1');
    expect(pinned.rows[0]?.policy).not.toBeNull();
    /* Plan 13's documented default — gate coverage is payment in full — so 100% of the total. */
    expect(pinned.rows[0]?.deposit).toBe(grand.toString());

    /* 🔒 And the gate is SHUT on an order that has received nothing. It used to be open. */
    expect(await gateOpen(id)).toBe(false);
  }, 60_000);

  /**
   * ⚠️ THE PIN COMES FROM THE SCHEDULE, WHICH IS PLAN 7.13's FOURTH SEAM.
   *
   * A 30/70 is where the two implementations disagreed, and the gap is the ceiling on every
   * forfeit: ฿5,916.67 against ฿19,722.24 on the red team's own order — plan 7.8's ฿12,902,
   * read VAT-inclusive. The fixture re-pins because 5c's authoring route will have to; what
   * this asserts is that a submit and its schedule agree by construction rather than by
   * coincidence.
   */
  it('pins a deposit that is the schedule and not a second formula', async () => {
    const { id, grand } = await order('deposit-seam');
    const schedule = await writeThirtySeventy(db, app, id, grand);

    const rows = await instalments(id);
    expect(rows.map((row) => row.due)).toEqual([schedule.depositThbMinor, schedule.balanceThbMinor]);
    /* Foots: the balance is the *difference*, never a second rounding. */
    expect(schedule.depositThbMinor + schedule.balanceThbMinor).toBe(grand);

    const pinned = await db.execute<{ deposit: string }>(
      sql`select scheduled_deposit_thb_minor::text as deposit from orders where id = ${id}::uuid`,
    );
    expect(pinned.rows[0]?.deposit).toBe(schedule.depositThbMinor.toString());
  }, 60_000);

  /* ================================================================== *
   * The whole walk
   * ================================================================== */

  /**
   * Deposit, gate, freeze, balance, production, delivery — and every account explained.
   *
   * The ledger of a delivered job used to be two postings: `bank_thb` +total against
   * `deposit_held` −total, with `revenue` structurally empty. The trial balance therefore said
   * the company owed every customer it had ever delivered to, for ever, because nothing ever
   * moved the money out of a liability account.
   */
  it('walks a 30/70 to delivery, and the ledger ends with revenue rather than a liability', async () => {
    const { id, grand } = await order('walk');
    const schedule = await writeThirtySeventy(db, app, id, grand);
    const [deposit, balance] = await instalments(id);
    if (!deposit || !balance) throw new Error('a 30/70 has two instalments');

    /* ── the deposit closes the gating instalment, and that IS the transition ── */
    const depositSlip = await slip(id, schedule.depositThbMinor);
    const accepted = await accept(depositSlip, [{ id: deposit.id, amount: schedule.depositThbMinor }]);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({
      gateOpened: true,
      orderTransition: { to: 'production_confirmed' },
    });

    const afterDeposit = await folds(db, id);
    expect(afterDeposit.cash).toBe(schedule.depositThbMinor);
    expect(afterDeposit.held).toBe(schedule.depositThbMinor);
    expect(afterDeposit.settled).toBe(schedule.depositThbMinor);
    /* The frontier is a MAX over the settled prefix, so one — not "one instalment settled". */
    expect(afterDeposit.settledThrough).toBe(1);

    /* And the freeze happened once. A second slip is a payment event and moves nothing. */
    const frozen = await db.execute<{ frozen: string | null; status: string }>(
      sql`select frozen_at::text as frozen, status from orders where id = ${id}::uuid`,
    );
    expect(frozen.rows[0]?.frozen).not.toBeNull();
    expect(frozen.rows[0]?.status).toBe('production_confirmed');

    /* ── the balance: money lands, the order does not move ── */
    const balanceSlip = await slip(id, schedule.balanceThbMinor);
    const second = await accept(balanceSlip, [{ id: balance.id, amount: schedule.balanceThbMinor }]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ gateOpened: false, orderTransition: null });

    const paid = await folds(db, id);
    expect(paid.cash).toBe(grand);
    expect(paid.held).toBe(grand);
    expect(paid.settled).toBe(grand);
    expect(paid.settledThrough).toBe(2);

    /* ── to delivery, through the real transitions ── */
    for (const to of ['in_production', 'awaiting_installation', 'delivered']) {
      const moved = await move(id, to, staff);
      expect(moved.status, `${to}: ${JSON.stringify(moved.body)}`).toBe(200);
    }

    /* 🔒 The posting that did not exist. */
    expect(await ledgerKinds(db, id)).toContain('revenue_recognised');

    /*
     * Every account, folded, and each one explainable in a sentence:
     *
     *   bank_thb       +grand   the customer's two transfers, at face value
     *   deposit_held    ฿0.00   held while the job was open, released when it was delivered
     *   revenue        −grand   credited, because revenue is a credit balance
     *
     * `held` is zero and `cash` is not: the company has the money and no longer owes it.
     */
    expect(await account(id, 'bank_thb')).toBe(grand);
    expect(await account(id, 'deposit_held')).toBe(0n);
    expect(await account(id, 'revenue')).toBe(-grand);

    const done = await folds(db, id);
    expect(done.cash).toBe(grand);
    expect(done.held).toBe(0n);

    /* Once, and only once — a second delivery event would double the revenue. */
    const entries = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from ledger_entries
       where order_id = ${id}::uuid and kind = 'revenue_recognised'
    `);
    expect(entries.rows[0]?.n).toBe('1');
  }, 120_000);

  /* ================================================================== *
   * Cancellation
   * ================================================================== */

  /**
   * ⚠️ AN ORDER THAT HAD TAKEN A DEPOSIT COULD NOT BE CANCELLED. BY ANY ORDERING.
   *
   * `assert_order_schedule()` refuses a terminal order whose schedule is open *and* a live
   * order whose schedule is closed, and it is DEFERRED — so closing first and cancelling first
   * both fail, and there is no sequence of separate transactions that works. 5a's handler
   * closed nothing. The consequence was not an inconvenience: `RefundsService.request` requires
   * `cancelled`, so no order carrying a schedule could ever reach a refund at all.
   */
  it('cancels an order holding a deposit, closes the schedule and posts the forfeit in one transaction', async () => {
    const { id, grand } = await order('cancel');
    const schedule = await writeThirtySeventy(db, app, id, grand);
    const [deposit] = await instalments(id);
    if (!deposit) throw new Error('a 30/70 has two instalments');

    const depositSlip = await slip(id, schedule.depositThbMinor);
    expect((await accept(depositSlip, [{ id: deposit.id, amount: schedule.depositThbMinor }])).status).toBe(200);
    expect((await move(id, 'in_production', staff)).status).toBe(200);

    const cancelled = await move(id, 'cancelled', customer, { reason: 'เปลี่ยนใจ' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const after = await db.execute<{ status: string; closed: string | null }>(sql`
      select o.status,
             (select s.closed_at::text from order_payment_schedules s where s.order_id = o.id) as closed
        from orders o where o.id = ${id}::uuid
    `);
    expect(after.rows[0]?.status).toBe('cancelled');
    /* The stamp plan 7.5(ก) asked for, and which had no writer. */
    expect(after.rows[0]?.closed).not.toBeNull();

    /*
     * ⚠️ THE FORFEIT IS PRICED AT THE CANCELLATION, NOT WHEN SOMEBODY ASKS FOR MONEY BACK.
     *
     * It used to be computed inside `RefundsService.request`, and two things followed. An order
     * cancelled by a customer who never argued was **never forfeited at all**, so `forfeited`
     * was structurally empty for most of them. And when the forfeit came to the whole balance,
     * `refundable = held − forfeit` was zero, the request was refused *before* the entry was
     * written, and the money sat in neither party's column for ever — the red team measured
     * ฿19,722.24 in that limbo.
     *
     * Under plan 13's shipped default — 0 bp in every one of the twelve cells — the priced
     * amount is zero and **no entry is written**, because `assertPositiveAmount` refuses a
     * posting for nothing. So "nothing was kept" is recorded by the cancellation event on the
     * spine (which carries the fault) plus the pinned `forfeit_policy_id`, and not by a row of
     * zeroes. `tests/payments/refunds/refunds.pg.test.ts` walks the same path at 5,000 bp,
     * where the entry does land.
     */
    expect(await ledgerKinds(db, id)).not.toContain('forfeited');
    expect(await account(id, 'forfeited')).toBe(0n);
    /* So the whole deposit is still the customer's, on a dead order, visibly. */
    expect((await folds(db, id)).held).toBe(schedule.depositThbMinor);

    const bucket = await db.execute<{ bucket: string }>(
      sql`select order_payment_queue_bucket(${id}::uuid) as bucket`,
    );
    expect(bucket.rows[0]?.bucket).toBe('terminal_holding_money');
  }, 120_000);

  /* ================================================================== *
   * Supersede — plan 7.8's carry
   * ================================================================== */

  /**
   * ⚠️ THE CUSTOMER WAS BILLED TWICE, AND THE CODE THAT PREVENTED IT WAS UNREACHABLE.
   *
   * `superseded` was refused for the same reason `cancelled` was, so `supersedes_order_id` was
   * never set, so `slip_allocations_guard_write()`'s carry branch was dead code. A customer
   * whose quote was revised had their deposit stranded on order A while order B invoiced them
   * the whole contract again.
   *
   * The carry is an **allocation pointing back at the ancestor**, never an instalment row on
   * the revision (plan 7.8): as a row, the old order would go on folding its own slips for
   * ever and one payment would be reported by two orders.
   */
  it('carries the deposit to a revision as an allocation, and the ancestor stops holding it', async () => {
    const { id, grand } = await order('carry');
    const schedule = await writeThirtySeventy(db, app, id, grand);
    const [deposit] = await instalments(id);
    if (!deposit) throw new Error('a 30/70 has two instalments');

    const depositSlip = await slip(id, schedule.depositThbMinor);
    expect((await accept(depositSlip, [{ id: deposit.id, amount: schedule.depositThbMinor }])).status).toBe(200);
    expect((await move(id, 'redesign', staff, { reason: 'ฝ่ายผลิตตีกลับ' })).status).toBe(200);

    const superseded = await move(id, 'superseded', staff, { reason: 'ออกใบใหม่ตามที่แก้ขนาด' });
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(200);

    const successorId = (superseded.body as OrderWire).supersededByOrderId;
    expect(successorId).not.toBeNull();

    /* The revision is a draft: nothing is carried until it is a contract of its own. */
    const submitted = await call('POST', `/orders/${successorId ?? ''}/transitions/awaiting_payment`, {
      token: customer.token,
      body: {
        contact: { email: `lifecycle-carry-${tag}@probe.invalid`, name: `lifecycle probe ${tag}` },
        lines: [line],
      },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    /* 🔒 The money is on the revision and nowhere else. */
    const ancestor = await folds(db, id);
    const revision = await folds(db, successorId ?? '');
    expect(ancestor.held).toBe(0n);
    expect(revision.held).toBe(schedule.depositThbMinor);

    /*
     * ⚠️ And the branch on the revision must be `held`, not `cash`: carrying money has no cash
     * leg — the cash arrived on the ancestor — so a revision's `cash` is ฿0.00 for ever and
     * every "have we been paid?" that asked `cash` would answer no.
     */
    expect(revision.cash).toBe(0n);
    expect(ancestor.cash).toBe(schedule.depositThbMinor);

    /* One payment, one allocation row, moved rather than copied. */
    const allocations = await db.execute<{ n: string; carried: string | null }>(sql`
      select count(*)::text as n, max(a.carried_from_order_id::text) as carried
        from slip_allocations a
        join order_instalments i on i.id = a.instalment_id
       where i.order_id = ${successorId ?? ''}::uuid
    `);
    expect(allocations.rows[0]?.n).toBe('1');
    expect(allocations.rows[0]?.carried).toBe(id);

    const onAncestor = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from slip_allocations a
        join order_instalments i on i.id = a.instalment_id
       where i.order_id = ${id}::uuid
    `);
    expect(onAncestor.rows[0]?.n).toBe('0');

    /* The ledger says the same thing through `credit_clearing`, which nets to zero across both. */
    expect(await account(id, 'credit_clearing')).toBe(-schedule.depositThbMinor);
    expect(await account(successorId ?? '', 'credit_clearing')).toBe(schedule.depositThbMinor);
    expect(await account(successorId ?? '', 'deposit_held')).toBe(-schedule.depositThbMinor);
  }, 120_000);
});
