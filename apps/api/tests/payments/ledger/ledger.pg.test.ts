import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

import { LedgerRepository } from '../../../src/payments/ledger/ledger.repository';
import { LedgerService } from '../../../src/payments/ledger/ledger.service';
import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  submittedOrder,
  type Actor,
  type PaymentsApp,
} from '../support/payments-app';
import { accountBalance, expectRejection, giveOrderHeldMoney } from '../support/money-fixture';

/**
 * The postings, against a real Postgres, with the real triggers refusing.
 *
 * Nothing here is asserted through a stub, because every property this file is about lives in
 * the database: the balance rule is a DEFERRED constraint trigger, append-only is a BEFORE
 * trigger, and every balance is a SQL function that this module is forbidden from
 * reimplementing. A mock has no COMMIT.
 *
 * ── What is deliberately not cleaned up ─────────────────────────────────────────
 *
 * Everything. `ledger_entries` and `ledger_postings` refuse DELETE by trigger, submitted orders
 * refuse deletion because they are accounting records, and a teardown that could remove either
 * would be a teardown contradicting the schema under test. `tests/globalSetup.ts` drops and
 * recreates the database on every run, which is what makes that affordable.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('the ledger', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let customer: Actor;
  let staff: Actor;
  let line: OrderLineRequestWire;

  let ledger: LedgerService;
  let repository: LedgerRepository;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `ledger customer ${tag}`, []);
    staff = await makeActor(db, app, `ledger staff ${tag}`, ['orders.read', 'orders.write']);
    line = await liveLine(call);

    ledger = app.app.get(LedgerService);
    repository = app.app.get(LedgerRepository);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const anOrder = async (who: string): Promise<OrderWire> =>
    submittedOrder(call, customer, line, {
      email: `ledger-${who}-${tag}@probe.invalid`,
      name: `ledger probe ${tag}`,
    });

  /* ---------------------------------------------------------------- *
   * The rule that makes it a ledger
   * ---------------------------------------------------------------- */

  it('refuses a one-legged entry at COMMIT, whatever this process believed', async () => {
    const order = await anOrder('one-leg');
    const entryId = randomUUID();

    /*
     * Written with raw SQL rather than through `LedgerRepository.post`, deliberately.
     * `assertBalanced` would refuse this in TypeScript, which is the fast diagnosis and not
     * the guarantee — the guarantee has to hold for a writer that never calls this module, and
     * that is what is being exercised here.
     */
    await expectRejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into ledger_entries (id, order_id, kind, memo_th)
          values (${entryId}::uuid, ${order.id}::uuid, 'revenue_recognised', 'ทดสอบขาเดียว')
        `);
        await tx.execute(sql`
          insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
          values (${entryId}::uuid, ${order.id}::uuid, 1, 'revenue', -100)
        `);
      }),
      /has 1 leg\(s\); a movement of money has two ends/u,
    );
  });

  it('refuses an entry whose legs do not sum to zero', async () => {
    const order = await anOrder('unbalanced');
    const entryId = randomUUID();

    await expectRejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into ledger_entries (id, order_id, kind, memo_th)
          values (${entryId}::uuid, ${order.id}::uuid, 'revenue_recognised', 'ทดสอบไม่สมดุล')
        `);
        await tx.execute(sql`
          insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
          values (${entryId}::uuid, ${order.id}::uuid, 1, 'deposit_held', 100),
                 (${entryId}::uuid, ${order.id}::uuid, 2, 'revenue', -99)
        `);
      }),
      /is out of balance by 1/u,
    );
  });

  it('is append-only: a posted entry can be neither edited nor deleted', async () => {
    const order = await anOrder('append-only');
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    const entryId = await repository.transaction((tx) =>
      ledger.recordRevenueRecognised(tx, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        heldThbMinor: grandTotal,
      }),
    );

    await expectRejection(
      db.execute(sql`update ledger_entries set memo_th = 'แก้ไข' where id = ${entryId}::uuid`),
      /ledger_entries is append-only; correct it with a reversing entry/u,
    );

    await expectRejection(
      db.execute(sql`delete from ledger_postings where entry_id = ${entryId}::uuid`),
      /ledger_postings is append-only; correct it with a reversing entry/u,
    );
  });

  /* ---------------------------------------------------------------- *
   * The folds — the numbers plan 7.13 insists are named apart
   * ---------------------------------------------------------------- */

  it('separates cash from held from settled, and a bank fee is what pulls them apart', async () => {
    const order = await anOrder('three-numbers');
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    /*
     * The customer transferred the full contract amount; the bank credited 3,000 satang less.
     * The reviewer settles the instalment in full — so `settled` is the contract amount, `cash`
     * is what arrived, and `settlement_variance` carries the difference. All three are right,
     * and a system with one number for them is wrong about two.
     */
    const fee = 3_000n;
    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      cashThbMinor: grandTotal - fee,
      payerName: `payer ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: staff.userId,
    });

    /* The company absorbs the fee (plan 13's default), so the customer is credited in full. */
    await repository.transaction((tx) =>
      ledger.recordVariance(tx, {
        orderId: order.id,
        amountThbMinor: fee,
        varianceKind: 'bank_fee',
        shortfall: true,
        memoTh: 'ค่าธรรมเนียมธนาคาร',
      }),
    );

    const money = await repository.money(order.id);

    expect(money.settledThbMinor).toBe(grandTotal);
    expect(money.heldThbMinor).toBe(grandTotal);
    expect(money.cashThbMinor).toBe(grandTotal - fee);
    expect(money.outstandingThbMinor).toBe(0n);
    expect(await accountBalance(db, order.id, 'settlement_variance')).toBe(fee);
  });

  /*
   * Plan 7.8's ⚠️, as an executable statement: a revision order carrying its ancestor's money
   * has NO cash leg and its `bank_thb` fold is zero forever. Every "have we been paid?" that
   * reads cash answers wrongly on every superseded contract in the system — and answers it
   * consistently, which is the hard kind of wrong to find.
   */
  it('carries money between orders through `credit_clearing`, with no cash on either side', async () => {
    const ancestor = await anOrder('carry-from');
    const grandTotal = toBigInt(ancestor.grandTotalThbMinor ?? never());

    /*
     * ⚠️ THE RELATIONSHIP HAS TO BE REAL, AND UNTIL THE CLOSING ROUND IT DID NOT.
     *
     * This test used to carry ฿19,722.24 between two orders with no connection whatever and pass:
     * every entry balanced, `assert_ledger_entry_balances` was satisfied, both orders looked
     * internally consistent, and one payment was settled on one while another held it. The red
     * team did exactly that on purpose. `slip_allocations_guard_write()` walked
     * `order_is_ancestor_of` before it would let the *allocation* move; the ledger half of the
     * same act checked nothing — two halves of one thing, guarded to completely different
     * standards, and only the half that was unreachable was the guarded one.
     *
     * So the chain is written here, and the refusal is asserted separately below.
     */
    /*
     * The ancestor has to be frozen before it can have a revision at all —
     * `orders_guard_insert()`: *"order X was never frozen; a revision of it is an edit, not a new
     * order"*. Superseding is the post-freeze mechanism (plan 7.2); before the freeze the quote is
     * edited in place.
     */
    const confirmed = await call('POST', `/orders/${ancestor.id}/transitions/production_confirmed`, {
      token: staff.token,
      body: {},
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const revisionId = await createRevision(db, ancestor.id, customer.userId);

    await giveOrderHeldMoney(db, {
      orderId: ancestor.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `payer ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: staff.userId,
    });

    await repository.transaction((tx) =>
      ledger.recordCarriedForward(tx, {
        fromOrderId: ancestor.id,
        toOrderId: revisionId,
        amountThbMinor: grandTotal,
      }),
    );

    const ancestorMoney = await repository.money(ancestor.id);
    const revisionMoney = await repository.money(revisionId);

    expect(ancestorMoney.heldThbMinor).toBe(0n);
    expect(ancestorMoney.cashThbMinor).toBe(grandTotal);

    expect(revisionMoney.heldThbMinor).toBe(grandTotal);
    /* ⚠️ The whole point of the test. */
    expect(revisionMoney.cashThbMinor).toBe(0n);

    /* `credit_clearing` nets to zero across the pair — an unfinished carry is visible. */
    const clearing =
      (await accountBalance(db, ancestor.id, 'credit_clearing')) +
      (await accountBalance(db, revisionId, 'credit_clearing'));
    expect(clearing).toBe(0n);
  });

  /**
   * 🔒 The refusal the paragraph above is about, on its own, with the numbers.
   *
   * Two orders that are strangers. Every constraint in `0010`/`0011` is satisfied by the pair of
   * entries — which is exactly why the check has to be somewhere, and why the somewhere is the
   * chain and not the balance.
   */
  it('refuses to carry money between two orders that are not on one supersedes chain', async () => {
    const left = await anOrder('carry-stranger-a');
    const right = await anOrder('carry-stranger-b');

    await expectRejection(
      repository.transaction((tx) =>
        ledger.recordCarriedForward(tx, {
          fromOrderId: left.id,
          toOrderId: right.id,
          amountThbMinor: 591_667n,
        }),
      ),
      /is not a revision of order/u,
    );

    expect(await accountBalance(db, right.id, 'deposit_held')).toBe(0n);
    expect(await accountBalance(db, left.id, 'credit_clearing')).toBe(0n);
  });

  /**
   * And the schema's own half of it, with the service removed from the picture.
   *
   * `assert_carry_is_between_relatives` sees one entry and therefore one order, so what it can
   * state is that the giving order has a revision and the receiving order supersedes something.
   * That is deliberately weaker than the service's check and deliberately not skippable: a
   * second caller assembling the legs by hand meets it anyway.
   */
  it('refuses a hand-written carry posting on an order with no revision at all', async () => {
    const orphan = await anOrder('carry-orphan');

    await expectRejection(
      db.transaction(async (tx) => {
        const entryId = randomUUID();
        await tx.execute(sql`
          insert into ledger_entries (id, order_id, kind, memo_th)
          values (${entryId}::uuid, ${orphan.id}::uuid, 'carried_forward', 'ทดสอบ')
        `);
        await tx.execute(sql`
          insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
          values (${entryId}::uuid, ${orphan.id}::uuid, 1, 'deposit_held', 591667),
                 (${entryId}::uuid, ${orphan.id}::uuid, 2, 'credit_clearing', -591667)
        `);
      }),
      /has no revision to carry money to/u,
    );
  });

  it('refuses to carry money from an order to itself', async () => {
    const order = await anOrder('carry-self');

    await expectRejection(
      repository.transaction((tx) =>
        ledger.recordCarriedForward(tx, {
          fromOrderId: order.id,
          toOrderId: order.id,
          amountThbMinor: 100n,
        }),
      ),
      /carried from an order to itself/u,
    );
  });

  /*
   * Plan 7.11: an accepted slip for a cross-border wire is not money in the bank for one to two
   * working days. The account exists so that a refund cannot be paid out against it, and this
   * pins the half the ledger owns: the money is held, and none of it is cash.
   */
  it('holds a cross-border wire in `remittance_in_transit` until it lands', async () => {
    const order = await anOrder('in-transit');
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

    const held = await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `payer ${tag}`,
      payerAccountLast4: '4821',
      reviewerUserId: staff.userId,
      landed: false,
    });

    const before = await repository.money(order.id);
    expect(before.heldThbMinor).toBe(grandTotal);
    expect(before.cashThbMinor).toBe(0n);
    expect(before.remittanceInTransitThbMinor).toBe(grandTotal);

    await repository.transaction((tx) =>
      ledger.recordRemittanceLanded(tx, {
        orderId: order.id,
        slipId: held.slipId,
        amountThbMinor: grandTotal,
      }),
    );

    const after = await repository.money(order.id);
    expect(after.cashThbMinor).toBe(grandTotal);
    expect(after.remittanceInTransitThbMinor).toBe(0n);
    expect(after.heldThbMinor).toBe(grandTotal);
  });

  /*
   * `ledger_entries_slip_required`. An acceptance with no slip is an unsourced credit — money
   * that arrived because somebody said so.
   */
  it('refuses a slip-shaped entry that names no slip', async () => {
    const order = await anOrder('unsourced');
    const entryId = randomUUID();

    await expectRejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into ledger_entries (id, order_id, kind, memo_th)
          values (${entryId}::uuid, ${order.id}::uuid, 'slip_accepted', 'ไม่มีสลิป')
        `);
        await tx.execute(sql`
          insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
          values (${entryId}::uuid, ${order.id}::uuid, 1, 'bank_thb', 100),
                 (${entryId}::uuid, ${order.id}::uuid, 2, 'deposit_held', -100)
        `);
      }),
      /ledger_entries_slip_required/u,
    );
  });
});

/** Reached only if the API served an order with no total, which the schema forbids after submit. */
function never(): never {
  throw new Error('a submitted order has a grand total');
}

/**
 * Create the revision of an order — the only way the schema permits the link to exist.
 *
 * `orders_guard_update()` makes `supersedes_order_id` **immutable**, deliberately: a pointer set
 * later on a row the target already supersedes is the one way to build a cycle, and a cycle hangs
 * the ancestor walk every carry depends on. So the link cannot be added to an existing row and
 * the revision has to be created carrying it, which is exactly what `OrderRepository.createDraft`
 * does inside a supersede.
 *
 * A bare draft is enough here: the carry's ledger half folds `ledger_postings` and nothing else,
 * and giving it a schedule would be inventing a contract this test never signs.
 */
async function createRevision(db: Database, ancestorId: string, ownerUserId: string): Promise<string> {
  const id = randomUUID();
  const eventId = randomUUID();

  /*
   * Order first, event second, in one transaction — plan 7.4 trap 1 exactly as it was written:
   * `orders.status_event_id` is NOT NULL and `order_events.order_id` is NOT NULL, so neither row
   * can be inserted first unless both foreign keys are DEFERRABLE, and they are. Every order in
   * this system is created this way.
   */
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into orders (id, customer_user_id, supersedes_order_id, status_event_id)
      values (${id}::uuid, ${ownerUserId}::uuid, ${ancestorId}::uuid, ${eventId}::uuid)
    `);

    await tx.execute(sql`
      insert into order_events
        (id, order_id, event_type, from_status, to_status, actor_kind, actor_user_id, payload)
      values (${eventId}::uuid, ${id}::uuid, 'created', null, 'draft', 'customer',
              ${ownerUserId}::uuid, '{}'::jsonb)
    `);
  });

  return id;
}
