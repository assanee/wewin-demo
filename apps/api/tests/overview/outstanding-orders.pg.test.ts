import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toBigInt } from '@wewin/contract/exact';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import type { MoneyWire } from '@wewin/contract/money';
import type { OrderLineRequestWire } from '@wewin/contract/order';

import { OUTSTANDING_ORDERS_CAP } from '../../src/overview/overview.repository';
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

/**
 * `GET /overview` → `money.outstandingOrders` — the aggregate "ยอดค้างชำระ", itemised.
 *
 * ── Why this file asserts invariants and not a roster ────────────────────────────
 *
 * The database is shared with every other pg suite in the run, and several of them leave
 * unpaid orders behind — which is exactly the world this card lives in. So the assertions are
 * the properties that must hold *whatever else is in the table*: the cap, the ordering, the
 * exclusions, and the agreement of each figure with `order_outstanding_thb_minor()` read
 * directly. `overview.pg.test.ts` makes the same argument about deltas for the same reason.
 *
 * The one membership claim is made carefully. A capped list cannot promise that a particular
 * order is in it, so what is asserted is what the cap actually means: an order that owes money
 * is either on the list, or the list is full of orders that owe *more*. That is a truncation;
 * anything else is a dropped debt.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const contactFor = (who: string): { email: string; name: string } => ({
  email: `overview-owing-${who}-${tag}@probe.invalid`,
  name: `overview owing probe ${tag}`,
});

interface OutstandingOrder {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly outstandingThbMinor: MoneyWire<'THB'>;
}

interface Overview {
  readonly money?: {
    readonly receivedThisMonth: MoneyWire<'THB'>;
    readonly outstanding: MoneyWire<'THB'>;
    readonly outstandingOrders: readonly OutstandingOrder[];
  };
}

/** The fold itself, read directly — the number every figure on this card has to equal. */
async function outstandingFold(db: Database, orderId: string): Promise<bigint> {
  const result = await db.execute<{ outstanding: string }>(
    sql`select coalesce(order_outstanding_thb_minor(${orderId}::uuid), 0)::text as outstanding`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fold returned no row');
  return BigInt(row.outstanding);
}

describeWithPg('the overview — which orders owe the money', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;

  let finance: Actor;
  let staff: Actor;
  let customer: Actor;
  let line: OrderLineRequestWire;

  const owing = async (): Promise<{
    readonly total: bigint;
    readonly orders: readonly OutstandingOrder[];
  }> => {
    const response = await call('GET', '/overview', { token: finance.token });
    expect(response.status).toBe(200);
    const money = (response.body as Overview).money;
    if (money === undefined) throw new Error('the money card was not served to a payments.read actor');
    return { total: toBigInt(money.outstanding), orders: money.outstandingOrders };
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    /* `payments.read` is what `OVERVIEW_SECTIONS.money` asks for, and this card is inside it. */
    finance = await makeActor(db, app, `overview owing finance ${tag}`, ['payments.read']);
    staff = await makeActor(db, app, `overview owing staff ${tag}`, ['orders.read']);
    customer = await makeActor(db, app, `overview owing customer ${tag}`, []);
    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('itemises a live debt, at the same figure the fold gives for that order', async () => {
    /*
     * A deliberately large order, so it sits near the top of a list it shares with whatever
     * other suites in this run left unpaid. Its *rank* is still not assumed — see the helper
     * below, and the file header for why a capped list cannot promise membership.
     */
    const order = await submittedOrder(call, customer, { ...line, qty: 60 }, contactFor('big'));
    const expected = await outstandingFold(db, order.id);
    expect(expected).toBeGreaterThan(0n);

    const { orders } = await owing();
    const entry = orders.find((row) => row.id === order.id);

    if (entry === undefined) {
      /*
       * Truncated, which is legal — but only in the one way a cap is allowed to work: the list
       * is full, and everything on it is owed more than this. A missing debt beside a smaller
       * one that made the cut is a sort or a filter that is wrong, not a truncation.
       */
      expect(orders).toHaveLength(OUTSTANDING_ORDERS_CAP);
      const smallest = toBigInt(orders[orders.length - 1]?.outstandingThbMinor ?? never('a full list has a last row'));
      expect(smallest).toBeGreaterThanOrEqual(expected);
      return;
    }

    expect(toBigInt(entry.outstandingThbMinor)).toBe(expected);
    expect(entry.orderNo).toBe(order.orderNo);
    expect(entry.status).toBe('awaiting_payment');
  });

  it('agrees with the order list: one fold, two screens', async () => {
    const { orders } = await owing();
    expect(orders.length).toBeGreaterThan(0);

    for (const entry of orders) {
      /* The card's figure against the function, read here rather than through any API. */
      expect(toBigInt(entry.outstandingThbMinor)).toBe(await outstandingFold(db, entry.id));

      /*
       * …and against `GET /orders`, which staff read for the same order. The two screens are
       * two encoders over one SQL function, and this is the assertion that says so.
       */
      const single = await call('GET', `/orders/${entry.id}`, { token: staff.token });
      expect(single.status).toBe(200);
      const wire = single.body as { readonly outstandingThbMinor: MoneyWire<'THB'> | null };
      expect(wire.outstandingThbMinor).toStrictEqual(entry.outstandingThbMinor);
    }
  });

  it('drops an order the moment it is paid in full, and never lists a cart', async () => {
    const paid = await submittedOrder(call, customer, line, contactFor('settled'));
    const grandTotal = toBigInt(paid.grandTotalThbMinor ?? never('a submitted order has a grand total'));

    const before = await owing();
    expect(before.orders.map((row) => row.id)).toBeDefined();

    await giveOrderHeldMoney(db, {
      orderId: paid.id,
      grandTotalThbMinor: grandTotal,
      paidThbMinor: grandTotal,
      payerName: `payer ${tag}`,
      payerAccountLast4: '5150',
      reviewerUserId: staff.userId,
    });

    expect(await outstandingFold(db, paid.id)).toBe(0n);

    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    expect(created.status).toBe(201);
    const draft = created.body as { readonly id: string };

    const after = await owing();
    const ids = after.orders.map((row) => row.id);

    /* Nothing owed is not a debt… */
    expect(ids).not.toContain(paid.id);
    /* …and a cart is not a commitment, which is the aggregate's own exclusion, borrowed. */
    expect(ids).not.toContain(draft.id);
    for (const entry of after.orders) {
      expect(toBigInt(entry.outstandingThbMinor)).toBeGreaterThan(0n);
      expect(['draft', 'cancelled', 'superseded']).not.toContain(entry.status);
    }
  });

  it('is capped, ordered by amount, and never adds up to the total', async () => {
    /*
     * Nine orders of increasing size, so the cap has more than it can carry whatever else the
     * run has left behind. Distinct quantities rather than nine identical ones: a list sorted by
     * a column where every value is equal would pass a monotonicity check without being sorted.
     */
    for (const qty of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      await submittedOrder(call, customer, { ...line, qty }, contactFor(`cap-${qty}`));
    }

    const { total, orders } = await owing();

    expect(orders).toHaveLength(OUTSTANDING_ORDERS_CAP);

    /* Largest first, without exception — the useful end of a debt list is the money. */
    const amounts = orders.map((row) => toBigInt(row.outstandingThbMinor));
    for (let index = 1; index < amounts.length; index += 1) {
      const previous = amounts[index - 1] ?? never('an index inside the list');
      const current = amounts[index] ?? never('an index inside the list');
      expect(previous).toBeGreaterThanOrEqual(current);
    }

    /*
     * ⚠️ The reason the aggregate is still on the wire. With more than eight orders owing, the
     * sum of this list is *strictly less* than the company's outstanding — a screen that added
     * the rows up would under-report the debt by however much was truncated, and would do it
     * silently. The total is carried beside the list precisely so no screen has to.
     */
    const listed = amounts.reduce((sum, amount) => sum + amount, 0n);
    expect(listed).toBeLessThan(total);
  });

  it('is inside the money card, so the permission that gates the total gates the breakdown', async () => {
    /* `orders.read` holds no `payments.read`: no money card at all, and therefore no breakdown. */
    const response = await call('GET', '/overview', { token: staff.token });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;

    expect(Object.keys(body)).not.toContain('money');
    /*
     * And no key of its own anywhere else on the response. A breakdown beside the card rather
     * than inside it would be a second place for that gate to be got right — `sections.ts` is
     * explicit that a key which is absent is the only honest way to say "not for you".
     */
    expect(JSON.stringify(body)).not.toContain('outstandingOrders');
  });
});

function never(message: string): never {
  throw new Error(message);
}
