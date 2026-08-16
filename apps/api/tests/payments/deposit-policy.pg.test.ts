import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import type { OrderLineRequestWire, OrderStatusWire, OrderWire } from '@wewin/contract/order';

import {
  bootPaymentsApp,
  client,
  liveLine,
  makeActor,
  paymentsEnv,
  type Actor,
  type PaymentsApp,
} from './support/payments-app';
import { confirmQuotation } from '../support/confirm-quotation';

/**
 * The company's deposit percentage, once it governs both things it is supposed to govern.
 *
 * `organisation_profile.deposit_bp` has existed since task 4 and nothing read it: the submit
 * planned `payInFullTerms()` unconditionally, and the `cashflow` concession was measured against
 * `GATE_COVERAGE_BP_DEFAULT` — 10 000 bp, hard-coded as `cashflowConcessionMinor`'s default
 * parameter. Two consumers, one setting, and the whole point of this suite is that they cannot be
 * allowed to disagree: a schedule that gates 30% measured against a floor of 100% is a 70%
 * `cashflow` concession, and with `authority_limits` empty — which is how this ships — fail-closed
 * refuses an approval it cannot grant and the entire submit rolls back.
 *
 * ── Why this is a Postgres suite and not three unit tests ────────────────────────
 *
 * Every property here lives between layers. The schedule is planned in
 * `PaymentLifecycleService`, the floor is read through a port `AuthorityService` injects, the
 * setting is one row in `organisation_profile`, and the failure being prevented is a *rollback*
 * — an order, a document, a schedule and a status event that all cease to exist together. None
 * of that is observable from a call to a service holding numbers a test chose.
 *
 * ⚠️ **The first test is the one that must never have gone red.** It is not a new behaviour; it
 * is today's behaviour, restated here so that this file owns the claim that the default
 * configuration did not move. `depositPercentTerms(10 000)` is not *wrong* — it is a gating
 * `percent` row for the whole total plus a `remainder` due ฿0.00 — but it is two rows where
 * submit has always produced one, and `lifecycle/lifecycle.pg.test.ts:188` asserts exactly one.
 * A feature nobody switched on must not reshape the schedule of every order in the system.
 *
 * ── Two tests, and it was four ───────────────────────────────────────────────────
 *
 * Two were removed in review rather than kept for symmetry with the brief that asked for them.
 *
 * *"still measures a real concession below policy"* called `cashflowConcessionMinor` directly with
 * an explicit floor — arithmetic in `payments/schedule` that this task did not touch, reached
 * without passing through `measureCashflow`, which is the function that changed. Both mutations
 * left it green. The same property, routed through the changed code, is
 * `tests/quotes/authority/concession.test.ts`'s *"concedes nothing when the floor is the
 * company's own 30 per cent"*, and that one does redden. A pure assertion paying a Postgres
 * suite's boot cost to be undetectable was worth deleting, not moving.
 *
 * *"does not treat a deposit at policy as a concession, so the submit completes"* was subsumed by
 * the 30% test below: `submit()` throws on any non-200, so a gate that 409s already fails that
 * test before it reaches its first assertion. Its comment moved there, where the assertion
 * actually lives, rather than being asserted twice at the price of a second real submit.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** What the profile ships as, and what this suite has to put back. Plan 13's payment-in-full floor. */
const SEEDED_DEPOSIT_BP = 10_000;

describeWithPg('the deposit percentage governs the schedule and the approval floor', () => {
  let pool: Pool;
  let db: Database;
  let app: PaymentsApp;
  let call: ReturnType<typeof client>;
  let line: OrderLineRequestWire;
  let customer: Actor;
  /** False until `db` is assigned, so the teardown can tell "nothing ran" from "restore me". */
  let connected = false;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    connected = true;

    app = await bootPaymentsApp(paymentsEnv(url ?? ''));
    call = client(app.baseUrl);

    customer = await makeActor(db, app, `deposit policy customer ${tag}`, []);
    line = await liveLine(call);
  }, 120_000);

  afterAll(async () => {
    /*
     * ⚠️ Put the singleton back before anything else runs. `organisation_profile` is one row for
     * the whole database and every Postgres suite shares it (`vitest.config.ts` runs one fork,
     * one file at a time, which is what makes leaving it at 3 000 bp a problem for the *next*
     * file rather than a race inside this one). A suite that submits an order and expects a
     * single instalment would fail for a reason that has nothing to do with what it tests.
     *
     * ⚠️ `try`/`finally`, and the restore is inside the `try`. The `?.` on the two closes says
     * this hook expects to run after a `beforeAll` that may have failed part-way — and an
     * unguarded `setDeposit` ahead of them would throw on exactly that path (`db` still
     * undefined), leaking the app and the pool and hanging the worker on a run that was already
     * failing for another reason.
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

  /** A real cart, submitted through the real route. Returns what the application answered. */
  const submit = async (): Promise<{
    readonly orderId: string;
    readonly grand: bigint;
    readonly status: OrderStatusWire;
  }> => {
    const created = await call('POST', '/orders', { token: customer.token, body: {} });
    if (created.status !== 201) throw new Error(`could not start a cart: ${JSON.stringify(created.body)}`);

    const draft = created.body as OrderWire;
    const submitted = await call('POST', `/orders/${draft.id}/transitions/awaiting_payment`, {
      token: customer.token,
      body: {
        contact: { email: `deposit-${tag}@example.com`, name: 'ลูกค้าเงินมัดจำ' },
        lines: [line],
      },
    });

    if (submitted.status !== 200) throw new Error(`could not submit: ${JSON.stringify(submitted.body)}`);

    /* Confirmed, because this suite measures what the customer is asked to pay. */
    await confirmQuotation(db, draft.id);

    const order = submitted.body as OrderWire;
    const [row] = (
      await db.execute<{ grand: string }>(
        sql`select grand_total_thb_minor::text as grand from orders where id = ${order.id}::uuid`,
      )
    ).rows;

    /*
     * ⚠️ The status is re-read rather than taken off the submit's response body: that one
     * describes the order one status ago, before the confirmation above.
     */
    const [now] = (
      await db.execute<{ status: OrderWire['status'] }>(
        sql`select status from orders where id = ${order.id}::uuid`,
      )
    ).rows;

    return { orderId: order.id, grand: BigInt(row?.grand ?? '0'), status: now?.status ?? order.status };
  };

  const instalmentsOf = async (
    orderId: string,
  ): Promise<readonly { readonly due: bigint; readonly gatesStatus: string | null }[]> => {
    const rows = await db.execute<{ due: string; gates: string | null }>(sql`
      select due_thb_minor::text as due, gates_entry_to as gates
        from order_instalments where order_id = ${orderId}::uuid order by seq
    `);
    return rows.rows.map((row) => ({ due: BigInt(row.due), gatesStatus: row.gates }));
  };

  /* ================================================================== *
   * The default configuration, unmoved
   * ================================================================== */

  it("keeps today's single-instalment schedule when the policy is payment in full", async () => {
    await setDeposit(SEEDED_DEPOSIT_BP);

    const { orderId, grand } = await submit();
    const rows = await instalmentsOf(orderId);

    /*
     * Exactly one row, due the whole amount. `depositPercentTerms(10 000)` would give two — a
     * `percent` row plus a `remainder` due ฿0.00 — and would redden
     * `lifecycle/lifecycle.pg.test.ts:188` on a feature nobody switched on.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0]?.due).toBe(grand);
    expect(rows[0]?.gatesStatus).toBe('production_confirmed');
  }, 60_000);

  /* ================================================================== *
   * The setting, switched on
   * ================================================================== */

  /**
   * ⭐ The schedule follows the setting **and** the submit survives its own gate.
   *
   * ⚠️ The second half is not a separate test, because it cannot be. `submit()` throws on any
   * non-200, so a gate that refuses this order fails this test at its first line — which is
   * exactly the failure the whole task exists to prevent, and the one Step 7's mutation
   * reproduces: the gate runs inside the submit transaction, a below-floor schedule measures as a
   * `cashflow` concession, `authority_limits` has zero rows, so fail-closed refuses an approval it
   * cannot grant and the entire submit rolls back — document, order, schedule and status event.
   * Asserting it again in a test of its own bought a second real submit and no second way to fail.
   *
   * `awaiting_payment` and not `submitted`: that is what the transition this route names moves the
   * order to, and there is no `submitted` status in `ORDER_STATUSES`.
   */
  it('gates production on the configured share when the policy is 30 per cent', async () => {
    await setDeposit(3_000);

    const { orderId, grand, status } = await submit();
    const rows = await instalmentsOf(orderId);

    /* Confirmed by the fixture above — the deposit is what the customer is asked for. */
    expect(status).toBe('awaiting_payment');
    expect(rows).toHaveLength(2);
    /*
     * `percentOf` is `divRoundHalfUp`, not truncation. The two agree on this fixture and the
     * assertion is written as the arithmetic a reader would do by hand rather than as a call to
     * the function under test — a test that re-runs the implementation asserts nothing.
     */
    expect(rows[0]?.due).toBe((grand * 3_000n) / 10_000n);
    expect(rows[0]?.gatesStatus).toBe('production_confirmed');
    /* The balance is a `remainder` and gates nothing — plan 7.5(ข), and it foots to the total. */
    expect(rows[1]?.gatesStatus).toBeNull();
    expect((rows[0]?.due ?? 0n) + (rows[1]?.due ?? 0n)).toBe(grand);
  }, 60_000);
});
