import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type {
  OrderLineRequestWire,
  OrderListWire,
  OrderSummaryWire,
  OrderWire,
} from '@wewin/contract/order';
import type { PaymentInstructionsWire } from '@wewin/contract/organisation';

import { PG_POOL } from '../../src/database/database.tokens';
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
import { giveOrderHeldMoney } from '../payments/support/money-fixture';
import { writeThirtySeventy } from '../payments/slips/support/slips-app';

/**
 * `GET /orders` — what each order still owes, and what it is being asked for now.
 *
 * ── What is actually at risk here ────────────────────────────────────────────────
 *
 * Not the shape of the response. Two things, and they are the two the constraints on this
 * feature exist to prevent:
 *
 *   ⓵ **A second implementation.** `outstandingThbMinor` on a list row and
 *     `outstandingThbMinor` from `GET /orders/:id/payment-instructions` are the same question
 *     asked through two code paths, and the day they disagree the customer is looking at one
 *     number on the account page and a different one on the payment screen. So the assertions
 *     here are not against constants the fixture chose — they are against
 *     `paymentInstructions`' own answer for the same order, taken over the same HTTP.
 *
 *   ⓶ **A query per row.** The whole reason these fields did not exist until now is the cost
 *     (`apps/web/src/lib/payment/payable.ts`: *"the fold is a per-order SQL call, and putting
 *     it on a 50-row list turns one query into fifty-one"*). A `Promise.all` over the rows
 *     would produce byte-identical output and pass every other test in this file, so the query
 *     count is asserted directly, off the application's own pool.
 *
 * The fixtures are `writeThirtySeventy` and `giveOrderHeldMoney` — the ones the slips, ledger
 * and payment-instructions suites already use — chosen over inventing a fourth so this file
 * cannot quietly test a different world from theirs.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `list-outstanding-${who}-${tag}@probe.invalid`,
  name: `list outstanding probe ${tag}`,
});

/**
 * Every statement this application sent while `run` was running.
 *
 * ⚠️ Taken off `PG_POOL` — the pool Nest injected into the repositories — and not off a pool
 * this file created. Patching a pool of the test's own would count nothing the application
 * does, and would pass while asserting the opposite of what it claims.
 *
 * Transactions borrow a client from the pool and would not appear here. That is fine and worth
 * saying out loud: `GET /orders` is a plain read on the pool, and if it ever became a
 * transaction this helper would see zero folds and the assertion would fail loudly rather than
 * quietly stop meaning anything.
 */
async function statementsDuring(pool: Pool, run: () => Promise<void>): Promise<readonly string[]> {
  const texts: string[] = [];
  const patched = pool as unknown as { query: (...args: unknown[]) => unknown };
  const original = patched.query.bind(pool);

  patched.query = (...args: unknown[]): unknown => {
    const first = args[0];
    texts.push(typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''));
    return original(...args);
  };

  try {
    await run();
  } finally {
    delete (pool as unknown as { query?: unknown }).query;
  }

  return texts;
}

describeWithPg('GET /orders — the per-order outstanding and next-due figures', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;

  let customerA: Actor;
  let customerB: Actor;
  let staff: Actor;
  let line: OrderLineRequestWire;

  /**
   * The list as one actor sees it, optionally with a query.
   *
   * `query` is appended verbatim rather than assembled from an object, because half of what the
   * filter section below is testing *is* the query string — a repeatable `status` and a
   * single-valued `payment` beside it — and a helper that took `{status, payment}` would decide
   * the encoding the tests are meant to be checking.
   */
  const listFor = async (who: Actor, query = ''): Promise<readonly OrderSummaryWire[]> => {
    const answer = await call('GET', `/orders${query}`, { token: who.token });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return (answer.body as OrderListWire).orders;
  };

  const idsOf = (rows: readonly OrderSummaryWire[]): readonly string[] => rows.map((row) => row.id);

  const summaryOf = async (who: Actor, orderId: string): Promise<OrderSummaryWire> => {
    const found = (await listFor(who)).find((order) => order.id === orderId);
    if (found === undefined) throw new Error(`the list did not carry order ${orderId}`);
    return found;
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customerA = await makeActor(db, app, `list outstanding customer A ${tag}`, []);
    customerB = await makeActor(db, app, `list outstanding customer B ${tag}`, []);
    staff = await makeActor(db, app, `list outstanding staff ${tag}`, ['orders.read']);
    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * The three states the owner asked about
   * ---------------------------------------------------------------- */

  it('on a 30/70 order with nothing paid, states the whole total and asks for the deposit', async () => {
    const order = await submittedOrder(db, call, customerA, line, contactFor('unpaid'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
    const schedule = await writeThirtySeventy(db, app, order.id, grandTotal);

    const summary = await summaryOf(customerA, order.id);

    /* Nothing has been settled, so everything is still owed… */
    expect(toBigInt(summary.outstandingThbMinor ?? never('a submitted order has an outstanding'))).toBe(grandTotal);
    /* …and the amount field opens on the deposit, which is the owner's ruling and not the total. */
    expect(toBigInt(summary.nextDueThbMinor ?? never('a submitted order has a next due'))).toBe(
      schedule.depositThbMinor,
    );
    expect(schedule.depositThbMinor).not.toBe(grandTotal);
  });

  it(
    'after the deposit is accepted on a 30/70 order, both figures become the balance — ' +
      'not zero, and not the deposit again',
    async () => {
      const order = await submittedOrder(db, call, customerA, line, contactFor('deposit-paid'));
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
      const schedule = await writeThirtySeventy(db, app, order.id, grandTotal);

      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: schedule.depositThbMinor,
        payerName: `payer ${tag}`,
        payerAccountLast4: '4821',
        reviewerUserId: staff.userId,
      });

      const summary = await summaryOf(customerA, order.id);

      /*
       * The gate instalment is settled, so the frontier has moved to the balance: what is still
       * owed and what is asked for next are the same number now, and it is neither ฿0.00 (which
       * is "the gate is open" mistaken for "nothing is owed") nor the deposit again (which is a
       * next-due that never advances).
       */
      expect(toBigInt(summary.outstandingThbMinor ?? never('outstanding'))).toBe(schedule.balanceThbMinor);
      expect(toBigInt(summary.nextDueThbMinor ?? never('next due'))).toBe(schedule.balanceThbMinor);
      expect(schedule.balanceThbMinor).not.toBe(0n);
      expect(schedule.balanceThbMinor).not.toBe(schedule.depositThbMinor);
    },
  );

  it('on an order paid in full, both figures are ฿0.00 — present, and zero', async () => {
    const order = await submittedOrder(db, call, customerA, line, contactFor('paid-in-full'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));

    /* The submit's own schedule: one `remainder` instalment for the whole total. */
    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `payer ${tag}`,
      payerAccountLast4: '1199',
      reviewerUserId: staff.userId,
    });

    const summary = await summaryOf(customerA, order.id);

    expect(summary.outstandingThbMinor).not.toBeNull();
    expect(summary.nextDueThbMinor).not.toBeNull();
    expect(toBigInt(summary.outstandingThbMinor ?? never('outstanding'))).toBe(0n);
    expect(toBigInt(summary.nextDueThbMinor ?? never('next due'))).toBe(0n);
  });

  /* ---------------------------------------------------------------- *
   * The nullability decision, stated as a test
   * ---------------------------------------------------------------- */

  it('leaves both figures null on a cart, exactly where the grand total is null', async () => {
    const created = await call('POST', '/orders', { token: customerA.token, body: {} });
    expect(created.status).toBe(201);
    const draft = created.body as OrderWire;

    /*
     * The folds answer ฿0.00 for a cart, and ฿0.00 on a queue reads as *settled*. A draft has
     * settled nothing, has no contract and has no total — so all three money fields say the same
     * thing, and they say it together. This is the whole of the "are they nullable" decision.
     */
    expect(draft.grandTotalThbMinor).toBeNull();
    expect(draft.outstandingThbMinor).toBeNull();
    expect(draft.nextDueThbMinor).toBeNull();

    const summary = await summaryOf(customerA, draft.id);
    expect(summary.grandTotalThbMinor).toBeNull();
    expect(summary.outstandingThbMinor).toBeNull();
    expect(summary.nextDueThbMinor).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * ⭐ A finished contract is not a debt — the customer-facing regression
   * ---------------------------------------------------------------- */

  it('stops reporting a live debt the moment the order is cancelled', async () => {
    /*
     * ⭐ THE ASSERTION THIS FIX TURNS ON.
     *
     * `order_outstanding_thb_minor()` is total: it answers the whole unpaid remainder for an
     * order in any status, cancelled included. That is the right answer to the question the
     * function asks and a bill nobody owes. Folded onto every row of `GET /orders` with no
     * live-order predicate, it printed ฿14,791.68 in the ค้างชำระ column of a cancelled row —
     * and, worse, "ยอดคงค้าง" to the *customer* on `/account`, for an order they cancelled and
     * on which the company may owe them a refund. `GET /overview`, which filters with
     * `LIVE_ORDERS`, said ฿0 about the same order at the same moment.
     */
    const order = await submittedOrder(db, call, customerA, line, contactFor('cancelled'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));

    /* While it is live, the whole contract is owed — otherwise this proves nothing. */
    const live = await summaryOf(customerA, order.id);
    expect(toBigInt(live.outstandingThbMinor ?? never('a live order has an outstanding'))).toBe(grandTotal);

    const cancelled = await call('POST', `/orders/${order.id}/transitions/cancelled`, {
      token: customerA.token,
      body: { reason: 'เปลี่ยนใจ ยังไม่พร้อมติดตั้ง' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const after = await summaryOf(customerA, order.id);
    expect(after.status).toBe('cancelled');

    /*
     * Neither owing nor settled, because the order is neither. ฿0.00 in this column is how a
     * screen says *settled*, so answering zero would trade one false sentence for another —
     * and `expect(...).toBeNull()` fails on both `{digits:'1479168'}` and `{digits:'0'}`.
     */
    expect(after.outstandingThbMinor).toBeNull();
    expect(after.nextDueThbMinor).toBeNull();

    /* The contract is still stated. The order did cost this much; it is only not owed. */
    expect(after.grandTotalThbMinor).toStrictEqual(order.grandTotalThbMinor);

    /* And the single-order read, which shares the encoder, says the same. */
    const single = await call('GET', `/orders/${order.id}`, { token: customerA.token });
    expect(single.status).toBe(200);
    expect((single.body as OrderWire).outstandingThbMinor).toBeNull();
    expect((single.body as OrderWire).nextDueThbMinor).toBeNull();

    /*
     * ⚠️ And the residue has NOT been erased — which is the difference between withholding a
     * figure and losing one. Postgres still folds the full remainder on this order, because a
     * refund is priced from exactly that number (`src/payments/refunds`). What changed is who
     * is told it is a debt, and the fold is asked here directly so that a future "fix" that
     * nulled the column in `ORDER_COLUMNS` instead would fail this line.
     */
    const fold = await db.execute<{ residue: string }>(sql`
      select order_outstanding_thb_minor(${order.id}::uuid)::text as residue
    `);
    expect(BigInt(fold.rows[0]?.residue ?? '0')).toBe(grandTotal);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ The divergence this whole constraint exists to prevent
   * ---------------------------------------------------------------- */

  it('agrees, figure for figure, with what `payment-instructions` answers for the same order', async () => {
    const order = await submittedOrder(db, call, customerA, line, contactFor('agreement'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
    const schedule = await writeThirtySeventy(db, app, order.id, grandTotal);

    await giveOrderHeldMoney(db, {
      orderId: order.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: schedule.depositThbMinor,
      payerName: `payer ${tag}`,
      payerAccountLast4: '7734',
      reviewerUserId: staff.userId,
    });

    const instructions = await call('GET', `/orders/${order.id}/payment-instructions`, {
      token: customerA.token,
    });
    expect(instructions.status).toBe(200);
    const paid = instructions.body as PaymentInstructionsWire;

    const summary = await summaryOf(customerA, order.id);

    /*
     * Compared as encoded wire objects and not as bigints: the unit tag travels with the number,
     * and a list that shipped satang as baht would still pass a comparison of the digits alone.
     */
    expect(summary.outstandingThbMinor).toStrictEqual(paid.outstandingThbMinor);
    expect(summary.nextDueThbMinor).toStrictEqual(paid.nextDueThbMinor);

    /* And the single-order read, which shares the encoder, agrees with both. */
    const single = await call('GET', `/orders/${order.id}`, { token: customerA.token });
    expect(single.status).toBe(200);
    const wire = single.body as OrderWire;
    expect(wire.outstandingThbMinor).toStrictEqual(paid.outstandingThbMinor);
    expect(wire.nextDueThbMinor).toStrictEqual(paid.nextDueThbMinor);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ One query, whatever the page size
   * ---------------------------------------------------------------- */

  it('folds every row of the list in one statement, not one statement per row', async () => {
    /* Enough rows that a per-order fold would be unmistakable in the count. */
    const rows = await listFor(customerA);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const pool = app.app.get<Pool>(PG_POOL);

    let served: readonly OrderSummaryWire[] = [];
    const statements = await statementsDuring(pool, async () => {
      served = await listFor(customerA);
    });

    const folds = statements.filter((text) => text.includes('order_outstanding_thb_minor'));

    /*
     * One statement carries the fold, and it is the list's own select. `served.length` is in the
     * message because the number that matters is the ratio: N rows, one fold.
     */
    expect(folds).toHaveLength(1);
    expect(served.length).toBeGreaterThanOrEqual(3);

    /* The same statement answers the second question, so next-due costs no query of its own. */
    expect(folds[0]).toContain('order_next_due_thb_minor');
  });

  /* ---------------------------------------------------------------- *
   * Scope — the figures are computed per returned row, and the rows were already filtered
   * ---------------------------------------------------------------- */

  it("never carries another customer's order, and so never carries their balance", async () => {
    const order = await submittedOrder(db, call, customerA, line, contactFor('scope'));
    const grandTotal = toBigInt(order.grandTotalThbMinor ?? never('a submitted order has a grand total'));
    await writeThirtySeventy(db, app, order.id, grandTotal);

    /* The owner sees it, with money on it. */
    const mine = await summaryOf(customerA, order.id);
    expect(mine.outstandingThbMinor).not.toBeNull();

    /*
     * The stranger's list does not contain the row at all — which is the point. The figures are
     * expressions in the target list of a query whose WHERE is `ownershipFilter(reach)`, so there
     * is no row of somebody else's on which they could be evaluated; there is nothing to withhold
     * afterwards, and therefore nothing anybody can forget to withhold.
     */
    const theirs = await listFor(customerB);
    expect(theirs.map((row) => row.id)).not.toContain(order.id);

    /* Staff hold `orders.read` over the whole table, and get the same figures the owner does. */
    const asStaff = await summaryOf(staff, order.id);
    expect(asStaff.outstandingThbMinor).toStrictEqual(mine.outstandingThbMinor);
    expect(asStaff.nextDueThbMinor).toStrictEqual(mine.nextDueThbMinor);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ `?payment=outstanding` — which orders come back
   * ---------------------------------------------------------------- */

  /**
   * The figures above were covered before this filter existed; the filter itself was not. A
   * predicate that compiles and a suite that passes prove only that nothing else broke — the
   * one question worth asking of a filter is *which rows it returns*, and none of the eight
   * tests above asks it.
   *
   * ⚠️ The filter shares its expression with the column: `OWING_ORDERS` and the row's
   * `outstandingThbMinor` are both built from `OUTSTANDING_FOLD` in `scoped-order.ts`. That is
   * what makes "the list says ค้างชำระ ฿0 on a row the ค้างชำระ filter returned" unrepresentable
   * rather than merely unlikely, and these tests are what would catch the two being pulled apart.
   */
  describe('the outstanding filter', () => {
    it('⭐ returns the orders that owe money, and only those', async () => {
      /*
       * Four orders, one per way of not owing, all owned by the same customer so the ownership
       * term cannot be what separates them:
       *
       *   owing        submitted, nothing paid — the only one that should come back
       *   settled      paid in full
       *   cancelled    a real balance, and a dead contract; `isLiveOrder` excludes it
       *   cart         never submitted, so both figures are null rather than zero
       */
      const owing = await submittedOrder(db, call, customerA, line, contactFor('filter-owing'));
      const settled = await submittedOrder(db, call, customerA, line, contactFor('filter-settled'));
      const cancelled = await submittedOrder(db, call, customerA, line, contactFor('filter-cancelled'));

      await giveOrderHeldMoney(db, {
        orderId: settled.id,
        grandTotalThbMinor: toBigInt(settled.grandTotalThbMinor ?? never('a submitted order has a grand total')),
        paidThbMinor: toBigInt(settled.grandTotalThbMinor ?? never('a submitted order has a grand total')),
        payerName: `payer ${tag}`,
        payerAccountLast4: '2255',
        reviewerUserId: staff.userId,
      });

      const killed = await call('POST', `/orders/${cancelled.id}/transitions/cancelled`, {
        token: customerA.token,
        body: { reason: 'ยกเลิกเพื่อทดสอบตัวกรอง' },
      });
      expect(killed.status, JSON.stringify(killed.body)).toBe(200);

      const returned = idsOf(await listFor(customerA, '?payment=outstanding&limit=100'));

      expect(returned).toContain(owing.id);
      expect(returned).not.toContain(settled.id);
      expect(returned).not.toContain(cancelled.id);

      /* And every row that did come back really is owing — no false positives, whoever they are. */
      const rows = await listFor(customerA, '?payment=outstanding&limit=100');
      for (const row of rows) {
        expect(row.outstandingThbMinor, `order ${row.id} was returned as owing`).not.toBeNull();
        expect(
          toBigInt(row.outstandingThbMinor ?? never('a returned row has an outstanding')),
          `order ${row.id} was returned as owing`,
        ).toBeGreaterThan(0n);
      }
    });

    it('⭐ narrows the status filter rather than widening it — the two are ANDed', async () => {
      /*
       * THE ASSERTION THE PARAMETER'S SHAPE TURNS ON, and the whole reason owing is not a ninth
       * `status` value. `status` is repeatable and its values are alternatives, so an `owing`
       * member would have made "in production **and** owing" — the question a production manager
       * actually asks — unaskable. Two parameters compose; one parameter cannot.
       */
      const owing = await submittedOrder(db, call, customerA, line, contactFor('filter-and'));

      const both = idsOf(await listFor(customerA, '?status=awaiting_payment&payment=outstanding&limit=100'));
      expect(both).toContain(owing.id);

      /*
       * The same order, asked for under a status it does not hold. If the terms were ORed this
       * would still return it — which is exactly the bug this test exists to make impossible.
       */
      const wrongStatus = idsOf(await listFor(customerA, '?status=delivered&payment=outstanding&limit=100'));
      expect(wrongStatus).not.toContain(owing.id);
    });

    it('puts the biggest debt first, so the money is reachable rather than merely present', async () => {
      /*
       * The owner's reason for wanting the filter at all was to chase what is owed. A page of
       * owing orders in arrival order buries the ฿90,000 behind forty rows of ฿400.
       *
       * Two orders of the same product differ only by quantity, so the larger is deterministically
       * the larger debt — no fixture arithmetic here, and nothing to keep in step with pricing.
       */
      const small = await submittedOrder(db, call, customerB, line, contactFor('filter-small'));
      const large = await submittedOrder(
        db,
        call,
        customerB,
        { ...line, qty: 5 },
        contactFor('filter-large'),
      );

      const smallOwed = toBigInt(small.grandTotalThbMinor ?? never('a submitted order has a grand total'));
      const largeOwed = toBigInt(large.grandTotalThbMinor ?? never('a submitted order has a grand total'));
      expect(largeOwed).toBeGreaterThan(smallOwed);

      const returned = idsOf(await listFor(customerB, '?payment=outstanding&limit=100'));
      expect(returned.indexOf(large.id)).toBeLessThan(returned.indexOf(small.id));
    });

    it("cannot reach another customer's debt, filter or no filter", async () => {
      /*
       * The filter is one more `and` term inside a query whose `where` already carries the
       * ownership term, so it can only ever narrow what that term admitted. Asserted rather than
       * argued, because "a new filter widened the scope" is the shape of defect that reads as a
       * feature working.
       */
      const theirs = await submittedOrder(db, call, customerA, line, contactFor('filter-not-yours'));

      const asOwner = idsOf(await listFor(customerA, '?payment=outstanding&limit=100'));
      expect(asOwner).toContain(theirs.id);

      const asStranger = idsOf(await listFor(customerB, '?payment=outstanding&limit=100'));
      expect(asStranger).not.toContain(theirs.id);
    });
  });
});

function never(message: string): never {
  throw new Error(message);
}
