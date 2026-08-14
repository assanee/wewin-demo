import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toBigInt } from '@wewin/contract/exact';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import type { MoneyWire } from '@wewin/contract/money';
import { BUSINESS_TIME_ZONE } from '@wewin/i18n/locales';

import { businessMonthStart } from '../../src/overview/business-month';
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
 * ─────────────────────────────────────────────────────────────────────────────
 * The overview, over real HTTP against a real Postgres.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `sections.test.ts` proves the permission table against a fake scope. This file answers the
 * two things a fake cannot:
 *
 *   ⓵ **that an unpermitted count is never fetched**, let alone serialised — asserted on the
 *     response body a real guard produced for a real token, not on a filter's return value;
 *   ⓶ **that the numbers mean what the queues mean.** Every count here is a `WHERE` clause,
 *     and a count that quietly disagrees with the screen it summarises is worse than no
 *     count: two answers to one question, and the wrong one is the one on the dashboard.
 *
 * ── Deltas, not absolutes ────────────────────────────────────────────────────
 *
 * The counts are asserted as *movements* — read, seed, read again, assert the difference.
 * The database this runs against is shared with every other pg suite and carries seed data,
 * so an absolute `toBe(1)` would be a test that passes on one machine. A delta is the same
 * assertion with the shared rows cancelled out of both sides.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** The wire shape, as much of it as an assertion needs to name. */
interface Overview {
  readonly orders?: Record<string, number>;
  readonly slips?: { readonly awaitingReview: number };
  readonly refunds?: { readonly requested: number };
  readonly money?: {
    readonly receivedThisMonth: MoneyWire<'THB'>;
    readonly outstanding: MoneyWire<'THB'>;
  };
  readonly quotes?: { readonly approvalsPending: number };
  readonly reviews?: { readonly awaitingModeration: number };
  readonly notifications?: { readonly dead: number; readonly suppressed: number };
  readonly catalog?: Record<string, number>;
  readonly users?: { readonly active: number; readonly suspended: number };
}

/**
 * The first instant of the current month in Bangkok, computed without asking Postgres.
 *
 * Independent on purpose: comparing the query's boundary against a boundary the same query
 * produced would agree by construction. `Intl` resolves the zone from the ICU database, and
 * the `+07:00` literal is safe because Thailand has held that offset since 1920 and has
 * never observed daylight saving — the one assumption in this file, stated rather than
 * buried.
 */
function bangkokMonthStart(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (year === undefined || month === undefined) throw new Error('Intl gave no year or month');

  return new Date(`${year}-${month}-01T00:00:00+07:00`);
}

const minutesFrom = (from: Date, minutes: number): Date =>
  new Date(from.getTime() + minutes * 60_000);

/** A `MoneyWire` is opaque on purpose; `toBigInt` is the only way in. */
const receivedThisMonth = (body: Overview): bigint =>
  body.money === undefined ? 0n : toBigInt(body.money.receivedThisMonth);

/**
 * The unit as it actually travels.
 *
 * Reached through `JSON.parse(JSON.stringify(...))` rather than a property access, because
 * the type is branded and deliberately has no readable `unit` — which is the property under
 * test: that the number on the wire is never a bare integer somebody can render as baht.
 */
const unitOf = (money: MoneyWire<'THB'> | undefined): string | undefined =>
  (JSON.parse(JSON.stringify(money ?? null)) as { unit?: string } | null)?.unit;

/** For the `?? never()` idiom the payments suites use on nullable wire fields. */
function never(): never {
  throw new Error('the API returned no grand total for a submitted order');
}

describeWithPg('the overview', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;

  /** Holds every code any card asks for. */
  let everything: Actor;
  /** `catalog.read` and nothing else — the narrowest useful staff account. */
  let catalogue: Actor;
  /** `payments.read` alone: opens refunds and the ledger, not the slip queue. */
  let finance: Actor;
  /** A customer, for putting real orders and real money into the tables. */
  let customer: Actor;
  let reviewer: Actor;

  const overview = async (actor: Actor): Promise<Overview> => {
    const response = await call('GET', '/overview', { token: actor.token });
    expect(response.status).toBe(200);
    return response.body as Overview;
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    everything = await makeActor(db, app, `overview all ${tag}`, [
      'orders.read',
      'payments.read',
      'quotes.read',
      /*
       * ⭐ Added when the pending-approvals card moved behind `quotes.read` + `quotes.approve` —
       * the pair `/approvals` and its queue endpoint ask for. Without it this actor stops seeing
       * eight cards, which is what the count below asserts, and the honest reading of "an
       * administrator" is somebody who holds the decision code too.
       */
      'quotes.approve',
      'reviews.moderate',
      'catalog.read',
      'users.read',
    ]);
    catalogue = await makeActor(db, app, `overview catalogue ${tag}`, ['catalog.read']);
    finance = await makeActor(db, app, `overview finance ${tag}`, ['payments.read']);
    customer = await makeActor(db, app, `overview customer ${tag}`, []);
    reviewer = await makeActor(db, app, `overview reviewer ${tag}`, [
      'payments.read',
      'payments.verify',
      'orders.read',
    ]);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * ⭐ A count you may not see is absent, never zero
   * ---------------------------------------------------------------- */

  describe('⭐ a card you may not see is a missing key', () => {
    it('gives a catalogue editor the catalogue card and no other', async () => {
      const body = await overview(catalogue);

      expect(Object.keys(body)).toStrictEqual(['catalog']);
    });

    it('⚠️ does not answer an unpermitted card with zero', async () => {
      /*
       * The mistake this exists to make impossible. A response of `{"orders": {...zeros}}`
       * passes any test that checks a *number*, renders as a clean dashboard, and is two
       * separate failures at once: it tells the reader the company has no orders, and it
       * tells them that orders — with these statuses, under this name — are a thing this
       * system has. Absence says neither.
       *
       * Asserted on the serialised text, not the parsed object: `toStrictEqual` on keys
       * would still pass if a section arrived as `undefined`, which `JSON.stringify` drops
       * on the way out but a future `JSON.parse`-free consumer would see.
       */
      const response = await call('GET', '/overview', { token: catalogue.token });
      const text = JSON.stringify(response.body);

      for (const forbidden of ['orders', 'slips', 'refunds', 'money', 'quotes', 'reviews', 'notifications', 'users']) {
        expect(text, `an unpermitted card leaked into the body as "${forbidden}"`).not.toContain(
          `"${forbidden}"`,
        );
      }
    });

    it('⚠️ refuses the slip card to payments.read alone, over HTTP', async () => {
      /*
       * The same assertion `sections.test.ts` makes against a fake scope, made again against
       * a token a real guard resolved. The two are not redundant: the unit test proves the
       * table, this proves the table is what the handler consults.
       */
      const body = await overview(finance);

      expect(Object.keys(body)).toStrictEqual(['refunds', 'money']);
    });

    it('turns away a caller with no session at all', async () => {
      expect((await call('GET', '/overview')).status).toBe(401);
    });
  });

  /* ---------------------------------------------------------------- *
   * The numbers mean what the queues mean
   * ---------------------------------------------------------------- */

  describe('the counts follow the tables', () => {
    it('moves awaitingPayment by exactly one when one order is submitted', async () => {
      const before = (await overview(everything)).orders?.['awaitingPayment'] ?? -1;

      const line = await liveLine(call);
      await submittedOrder(call, customer, line, {
        email: `overview-${tag}@probe.invalid`,
        name: `overview probe ${tag}`,
      });

      const after = (await overview(everything)).orders?.['awaitingPayment'] ?? -1;

      expect(after).toBe(before + 1);
    });

    it('⭐ agrees with the slip queue it summarises', async () => {
      /*
       * The anti-drift assertion, and the reason the card borrows the queue's exact
       * predicate rather than an equivalent-looking one. Two `WHERE` clauses that mean the
       * same thing today are two clauses; the overview's is the one nobody opens, so it is
       * the one that rots. Comparing against the queue's own response is the only check that
       * keeps failing after they diverge.
       *
       * ⚠️ The seeding below is not scenery — it is what makes this test able to fail.
       *
       * The first draft compared the two numbers on an empty table and asserted `0 === 0`.
       * Swapping the card's predicate from `submitted` to `accepted` left it green, because
       * there was nothing of either kind to count: a test that agreed with the queue about
       * nothing, and would have gone on agreeing after the two stopped meaning the same
       * thing. Seeding a submitted slip is what puts a number on both sides.
       */
      const line = await liveLine(call);
      const order = await submittedOrder(call, customer, line, {
        email: `overview-slip-${tag}@probe.invalid`,
        name: `overview slip ${tag}`,
      });

      const before = (await overview(reviewer)).slips?.awaitingReview ?? -1;

      /*
       * Inserted rather than posted: `POST /payments/slips` wants an image in object storage
       * and this test is about a `WHERE` clause. Legal on its own — `payment_slips_guard_write`
       * freezes a slip only once it has *left* `submitted`, and a submitted slip carries no
       * allocations for `assert_slip_allocations` to object to.
       */
      await db.execute(sql`
        insert into payment_slips (order_id, status, amount_thb_minor, transferred_at, storage_key)
        values (${order.id}::uuid, 'submitted', 100000::bigint, now(),
                -- A customer slip, so it has an image: payment_slips_evidence_exists (0047).
                ${`test/overview-${order.id}.png`})
      `);

      const counted = (await overview(reviewer)).slips?.awaitingReview ?? -1;

      expect(counted, 'a submitted slip did not move the card').toBe(before + 1);

      /*
       * ⚠️ `?limit=200` — the queue's ceiling, and the reason this assertion is two
       * assertions rather than one.
       *
       * `GET /payments/slips` pages: 50 by default, 200 at most. The overview does not page,
       * because "how much is waiting" is the question it exists to answer and a capped total
       * would answer it wrongly in exactly the situation that matters — a backlog. So the two
       * numbers are allowed to differ, in one direction only, and only past the ceiling.
       * Below it they must agree exactly or the predicates have drifted.
       */
      const queue = await call('GET', '/payments/slips?limit=200', { token: reviewer.token });
      expect(queue.status).toBe(200);
      const listed = (queue.body as { readonly entries: readonly unknown[] }).entries.length;

      expect(counted).toBeGreaterThanOrEqual(listed);
      if (listed < 200) expect(counted).toBe(listed);
    });

    it('⚠️ answers with numbers, not with the strings Postgres sends back', async () => {
      /*
       * ⭐ The bug this codebase has already paid for once, in `users.repository.ts`.
       *
       * `db.execute` is raw SQL: it goes through node-postgres alone and **bypasses
       * Drizzle's type parsers**. node-postgres returns `int8` as a *string*, and `count(*)`
       * is `int8` — so a query written without `::int` hands back `{ n: "3" }` while the
       * declared generic says `number`. It type-checks. It serialises. The dashboard renders
       * "3". And then somebody adds two cards together and gets `"30"`.
       *
       * `typeof` is the only assertion that sees it, because every comparison a normal test
       * makes — `toBe(3)` against a delta, `toBeGreaterThan(0)` — is either coerced or
       * already string-safe. This walks every count on every card, so a tenth card added
       * without its cast fails here rather than in a browser.
       */
      const body = await overview(everything);
      const cards = Object.entries(body).filter(([name]) => name !== 'money');

      expect(cards.length, 'the administrator should see eight counting cards').toBe(8);

      for (const [card, counts] of cards) {
        for (const [name, value] of Object.entries(counts as Record<string, unknown>)) {
          expect(typeof value, `${card}.${name} came back as ${typeof value}`).toBe('number');
          expect(Number.isInteger(value), `${card}.${name} is not a whole number`).toBe(true);
          expect(value as number, `${card}.${name} is negative`).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('counts the catalogue the catalogue screen lists', async () => {
      const body = await overview(catalogue);
      const products = await call('GET', '/admin/catalog/products', { token: catalogue.token });

      expect(products.status).toBe(200);
      const listed = (products.body as { readonly products: readonly unknown[] }).products.length;

      expect(body.catalog?.['products']).toBe(listed);
    });
  });

  /* ---------------------------------------------------------------- *
   * ⚠️ Money, and which month it belongs to
   * ---------------------------------------------------------------- */

  describe('⚠️ the month is Bangkok’s, not the server’s', () => {
    it('starts the month where the company is', async () => {
      /*
       * ⭐ The discriminating case. Bangkok is UTC+7, so the first seven hours of every
       * Thai month are still last month in UTC: a boundary computed as
       * `date_trunc('month', now())` lands seven hours late and silently drops every payment
       * taken on the 1st before lunchtime out of the month it belongs to.
       *
       * Compared against a boundary this process computed from ICU, so the two sides have no
       * common cause. Postgres's clock decides *when* — the phase-7 lesson about two
       * containers holding two clocks — and this asserts only *which boundary* it produces.
       */
      const rows = await db.execute<{ start: Date }>(
        sql`select ${businessMonthStart} as start`,
      );
      const start = rows.rows[0]?.start;
      if (start === undefined) throw new Error('no boundary came back');

      expect(new Date(start).toISOString()).toBe(bangkokMonthStart().toISOString());
    });

    it('⭐ counts a payment accepted 30 minutes into the Thai month', async () => {
      /*
       * The boundary being right is not the same as the query using it. This seeds the one
       * timestamp the two implementations disagree about — 00:30 on the 1st in Bangkok,
       * which is 17:30 on the last of last month in UTC — and asserts the money is counted.
       * Under a UTC boundary the row falls before the month starts and this number does not
       * move at all.
       */
      const line = await liveLine(call);
      const order = await submittedOrder(call, customer, line, {
        email: `overview-money-${tag}@probe.invalid`,
        name: `overview money ${tag}`,
      });
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

      const before = receivedThisMonth(await overview(everything));

      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: grandTotal,
        payerName: `overview payer ${tag}`,
        payerAccountLast4: '4242',
        reviewerUserId: reviewer.userId,
        /* The half hour the two calendars disagree about. */
        reviewedAt: minutesFrom(bangkokMonthStart(), 30),
      });

      const after = receivedThisMonth(await overview(everything));

      expect(after - before).toBe(grandTotal);
    });

    it('leaves out a payment accepted 30 minutes before the Thai month began', async () => {
      const line = await liveLine(call);
      const order = await submittedOrder(call, customer, line, {
        email: `overview-lastmonth-${tag}@probe.invalid`,
        name: `overview last month ${tag}`,
      });
      const grandTotal = toBigInt(order.grandTotalThbMinor ?? never());

      const before = receivedThisMonth(await overview(everything));

      await giveOrderHeldMoney(db, {
        orderId: order.id,
        grandTotalThbMinor: grandTotal,
        paidThbMinor: grandTotal,
        payerName: `overview payer ${tag}`,
        payerAccountLast4: '4242',
        reviewerUserId: reviewer.userId,
        /* Thirty minutes the other side of the same boundary. */
        reviewedAt: minutesFrom(bangkokMonthStart(), -30),
      });

      const after = receivedThisMonth(await overview(everything));

      expect(after).toBe(before);
    });

    it('states its unit, so a number is never a bare integer', async () => {
      const money = (await overview(everything)).money;

      expect(unitOf(money?.receivedThisMonth)).toBe('THB.satang');
      expect(unitOf(money?.outstanding)).toBe('THB.satang');
    });
  });
});
