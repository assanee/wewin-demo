import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import type { OrderLineRequestWire, OrderWire } from '@wewin/contract/order';

/* The files, not `src/quotes/authority` — a sibling `src/quotes/authority.ts` shadows the directory. */
import { AuthorityService } from '../../../src/quotes/authority/authority.service';
import {
  client,
  liveLine,
  makeActor,
  submittedOrder,
  type Actor,
  type Json,
} from '../../payments/support/payments-app';
import { authorityEnv, bootAuthorityApp, type AuthorityApp } from './support/authority-app';

/**
 * The `cashflow` floor is a term of the contract, so a historical order is measured against the
 * floor it was submitted under and not against today's setting.
 *
 * ── The defect this file owns ────────────────────────────────────────────────────
 *
 * `AuthorityService.measureFor` read `organisation_profile.deposit_bp` **live**, through
 * `DEPOSIT_POLICY`, on every measurement. So an order submitted while the company's deposit
 * policy was 30% — a schedule gating exactly what the policy asked for, conceding nothing, gated
 * through with no approval — reported a **70% `cashflow` concession** the moment the owner moved
 * the policy to payment in full. Nobody conceded anything; the question had changed.
 *
 * Enforcement was never affected. `gate` has exactly one production caller — `OrdersService` at
 * submit — and it runs inside that transaction, before any later setting exists. What was
 * affected is `GET /quotes/authority/orders/:orderId` and the `live` figure on the approval
 * detail, which are the audit surfaces: an audit trail that re-interprets a historical order
 * against today's policy answers a different question each time it is asked.
 *
 * `orders.deposit_floor_bp` (migration `0034`) is the pin, and `approvals.decided_ceiling_thb_minor`
 * is the precedent — the same retroactive re-interpretation on the ceiling side, closed the same
 * way: record the *input* the comparison was made with.
 *
 * ── ⚠️ Why every assertion here is behind a real submit ──────────────────────────
 *
 * The pin is written by `applySubmission`, in the statement that pins the document totals and the
 * deposit, and read by `AuthorityRepository` in a different module through a different select.
 * A test that handed `measureCashflow` two floors would be testing arithmetic that was never
 * wrong. What was wrong is *which floor arrives*, and that is only observable across the submit.
 *
 * ── The number that makes this test non-vacuous ──────────────────────────────────
 *
 * `liveFloorConcession` below is what the endpoint reported before this change, computed the way
 * a reader would compute it by hand. Every assertion that the pinned answer is ฿0.00 is paired
 * with an assertion that this figure is **not** ฿0.00 — so a fixture that accidentally stopped
 * discriminating (a policy that failed to move, a schedule that gated the whole total anyway)
 * fails loudly rather than passing for the wrong reason. The last test then asserts that same
 * figure is exactly what a row with **no** pin still reports, which is the honest handling of
 * every order that predates the column and the only assertion here that would survive deleting
 * the column altogether.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** What `0029_tax_countries.sql:113` seeds, and what this suite must put back. Payment in full. */
const SEEDED_DEPOSIT_BP = 10_000;
/** The policy the contract below is made under: the company holds 30% before production opens. */
const CONTRACT_FLOOR_BP = 3_000;

describeWithPg('the cashflow floor is pinned to the contract, not read from today’s policy', () => {
  let pool: Pool;
  let db: Database;
  let app: AuthorityApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;
  let service: AuthorityService;

  let customer: Actor;
  /** Reads the assessment. `quotes.read` is all that endpoint asks for. */
  let sales: Actor;

  /** False until `db` exists, so a half-failed `beforeAll` does not throw a second time in teardown. */
  let connected = false;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    connected = true;

    app = await bootAuthorityApp(authorityEnv(url ?? ''));
    call = client(app.baseUrl);
    service = app.app.get(AuthorityService);

    customer = await makeActor(db, app, `pinned floor customer ${tag}`, []);
    sales = await makeActor(db, app, `pinned floor sales ${tag}`, ['quotes.read', 'quotes.write']);

    line = await liveLine(call);
  }, 120_000);

  afterAll(async () => {
    /*
     * ⚠️ The singleton goes back first. `organisation_profile` is one row for the whole database
     * and every Postgres suite here shares it — `tests/setup/seeded-singletons.ts` fails this file
     * by name if it is left anywhere but 10 000, which is the alarm that exists because a suite
     * that left it at 3 000 once cost 38 failures in a file forty places away.
     */
    try {
      if (connected) await setDeposit(SEEDED_DEPOSIT_BP);
    } finally {
      await app?.close();
      await pool?.end();
    }
  });

  /** The company setting, written where the admin screen writes it. */
  const setDeposit = async (bp: number): Promise<void> => {
    await db.execute(sql`update organisation_profile set deposit_bp = ${bp} where id = 1`);
  };

  /** The two figures the submit pinned onto the row, plus the floor it was judged against. */
  const pinsOf = async (
    orderId: string,
  ): Promise<{ readonly grand: bigint; readonly deposit: bigint; readonly floorBp: number | null }> => {
    const rows = await db.execute<{ grand: string; deposit: string; floor: number | null }>(sql`
      select grand_total_thb_minor::text as grand,
             scheduled_deposit_thb_minor::text as deposit,
             deposit_floor_bp as floor
        from orders where id = ${orderId}::uuid
    `);

    const row = rows.rows[0];
    if (row === undefined) throw new Error('the order this suite just submitted cannot be read back');
    return { grand: BigInt(row.grand), deposit: BigInt(row.deposit), floorBp: row.floor };
  };

  /**
   * What the assessment endpoint says this quote concedes in `cashflow`, over real HTTP.
   *
   * Through the route and not through the service, because the route is the audit surface the
   * defect was visible on and it is a different code path from `gate` — same `measureFor`, no
   * transaction, a scope built by the guard rather than by this file.
   */
  const reportedCashflow = async (orderId: string): Promise<string> => {
    const assessed = await call('GET', `/quotes/authority/orders/${orderId}`, { token: sales.token });
    expect(assessed.status).toBe(200);

    const wire = (assessed as Json).body as { cashflow: { concessionThbMinor: string } };
    return wire.cashflow.concessionThbMinor;
  };

  /**
   * The concession a *live* read of today's 100% policy produces on this contract.
   *
   * `percentOf(grand, 10 000) − gatedPrefix`, and the gated prefix into the freeze point is
   * exactly `scheduled_deposit_thb_minor` — pinned by the same submit, from the same schedule.
   * Written as the arithmetic rather than as a call to `cashflowConcessionMinor`: a test that
   * re-runs the implementation asserts nothing.
   */
  const liveFloorConcession = (grand: bigint, deposit: bigint): bigint => grand - deposit;

  /* ================================================================== *
   * The contract, made at 30 per cent
   * ================================================================== */

  it('measures a historical order against the floor it was submitted under, not today’s', async () => {
    await setDeposit(CONTRACT_FLOOR_BP);

    const order: OrderWire = await submittedOrder(call, customer, line, {
      email: `pinned-floor-${tag}@probe.invalid`,
      name: `ลูกค้าเพดานมัดจำ ${tag}`,
    });

    /*
     * The pin is on the row, beside the deposit it will be compared against — written by
     * `applySubmission`, which is the only statement that may write it.
     */
    const pinned = await pinsOf(order.id);
    expect(pinned.floorBp).toBe(CONTRACT_FLOOR_BP);
    /* The schedule gates exactly what the policy asked for: 30% of the total, so nothing is conceded. */
    expect(pinned.deposit).toBe((pinned.grand * BigInt(CONTRACT_FLOOR_BP)) / 10_000n);
    expect(await reportedCashflow(order.id)).toBe('0');

    /* ── and now the owner changes the company's mind ────────────────────────── */
    await setDeposit(SEEDED_DEPOSIT_BP);

    /*
     * ⭐ The assertion. The contract did not move, so neither did what it concedes.
     *
     * Read after the policy has already changed, so a `measureFor` that consulted
     * `DepositPolicyPort` here would see 10 000 bp and report `liveFloorConcession` — which is
     * asserted non-zero immediately below, so this ฿0.00 cannot be passing by accident.
     */
    expect(await reportedCashflow(order.id)).toBe('0');
    expect(liveFloorConcession(pinned.grand, pinned.deposit)).toBeGreaterThan(0n);

    /*
     * The same question asked the way the approval detail asks it. `AuthorityService.approval`
     * builds its `live` figure from `measure`, on no transaction at all, and that is the second
     * surface the defect was visible on — so it is asserted through `measure` rather than
     * through a fabricated `approvals` row that this order has no concession to justify.
     */
    const live = await service.measure(order.id);
    expect(live.cashflow.concessionThbMinor).toBe(0n);
    expect(live.cashflow.sources).toEqual([]);

    /* ================================================================ *
     * The orders that predate the column, handled honestly
     * ================================================================ */

    /*
     * ⚠️ Not a separate `it`. It is the same contract with its pin removed, which is precisely
     * what every order submitted before `0034` looks like — and re-submitting is impossible
     * (`orders_guard_update` refuses a second `submitted_at`), so the only way to produce that
     * row is to take the pin off this one.
     *
     * `0034` deliberately backfilled nothing: 10 000 is the *shipping default* of `deposit_bp`,
     * not a fact anybody recorded about any historical contract, and no column says which orders
     * predate the setting becoming live. So a NULL pin falls back to the live policy — today's
     * behaviour, unchanged, for exactly the rows that already have it — and this asserts that
     * fallback rather than leaving it to be discovered.
     */
    await db.execute(
      sql`update orders set deposit_floor_bp = null where id = ${order.id}::uuid`,
    );

    expect(await reportedCashflow(order.id)).toBe(
      liveFloorConcession(pinned.grand, pinned.deposit).toString(),
    );
  }, 120_000);
});
