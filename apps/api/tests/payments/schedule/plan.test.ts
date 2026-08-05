import { describe, expect, it } from 'vitest';

import { divRoundHalfUp } from '@wewin/core/money';
import { fromNet } from '@wewin/core/vat';

import { DEFAULT_VAT_RULE } from '../../../src/orders/defaults';
import {
  cashflowConcessionMinor,
  gatedPrefixMinor,
  isLocked,
  planSchedule,
  recomputeSchedule,
  scheduledDepositMinor,
  type PlannedInstalment,
  type ScheduleRow,
} from '../../../src/payments/schedule/plan';
import {
  depositFixedTerms,
  depositPercentTerms,
  payInFullTerms,
  type ScheduleTerm,
} from '../../../src/payments/schedule/terms';
import { FREEZE_GATE_STATUS, MAX_INSTALMENTS } from '../../../src/payments/schedule/defaults';

/**
 * The schedule arithmetic, against the plan's own worked numbers.
 *
 * Every figure here is derived rather than typed where it can be: the VAT-inclusive total
 * comes out of `core`'s `fromNet` and the deposit out of `core`'s `divRoundHalfUp`, so a
 * change to the rounding rule shows up as a failure in this file instead of as two modules
 * that quietly stopped agreeing.
 *
 * ── What each block is evidence for ──────────────────────────────────────────────
 *
 * The pure functions carry four decisions that are not enforced anywhere else, because the
 * database enforces *outcomes* (it foots, the seq is dense, the remainder is last) and these
 * are *policies* about how the outcome is reached:
 *
 *   the last row is the difference and the difference is never silently absorbed;
 *   a locked instalment does not follow the price, and a remainder is never locked;
 *   the deposit obligation is a settled **prefix** and not the gate-holding rows;
 *   a total below money received is a refund and never a negative row.
 *
 * Mutating any one of them turns a block below red — noted per block where the mutation is
 * not obvious.
 */

const VAT_RULE = DEFAULT_VAT_RULE;

/** Plan 7.8's order: ฿18,432 VAT-inclusive, 30% deposit. */
const GRAND_18432 = 1_843_200n;
const DEPOSIT_30 = divRoundHalfUp(GRAND_18432 * 3_000n, 10_000n);

/** Plan 7.5(ก)'s order, read through plan 4.4: ฿8,791 net becomes ฿9,406.37 payable. */
const GRAND_8791 = fromNet(879_100n, VAT_RULE).grandMinor;

const dues = (instalments: readonly PlannedInstalment[]): readonly bigint[] =>
  instalments.map((instalment) => instalment.dueThbMinor);

const planned = (totalMinor: bigint, terms: readonly ScheduleTerm[]): readonly PlannedInstalment[] => {
  const plan = planSchedule(totalMinor, terms);
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.failure.reason}`);
  return plan.instalments;
};

const row = (
  instalment: PlannedInstalment,
  allocatedThbMinor: bigint = 0n,
): ScheduleRow => ({ ...instalment, allocatedThbMinor });

describe('the plan numbers this phase is built on', () => {
  it('reads plan 7.5(ก) through plan 4.4: ฿8,791 net is ฿9,406.37 payable', () => {
    expect(GRAND_8791).toBe(940_637n);
  });

  it('reads plan 7.8 the same way: 30% of ฿18,432 is ฿5,529.60, not ฿18,432', () => {
    expect(DEPOSIT_30).toBe(552_960n);
  });
});

describe('authoring a schedule', () => {
  it('payment in full is ONE instalment, not the absence of a schedule', () => {
    const instalments = planned(GRAND_8791, payInFullTerms());

    expect(instalments).toHaveLength(1);
    expect(instalments[0]?.basis).toBe('remainder');
    expect(instalments[0]?.dueThbMinor).toBe(GRAND_8791);
    expect(instalments[0]?.gatesEntryTo).toBe(FREEZE_GATE_STATUS);
  });

  it('30/70 foots, and the deposit is the plan’s ฿5,529.60', () => {
    const instalments = planned(GRAND_18432, depositPercentTerms(3_000));

    expect(dues(instalments)).toEqual([DEPOSIT_30, GRAND_18432 - DEPOSIT_30]);
    expect(dues(instalments).reduce((sum, due) => sum + due, 0n)).toBe(GRAND_18432);
  });

  /**
   * Plan 7.5(ก)'s ฿1, one decimal place further down.
   *
   * The plan writes the trap at whole baht against a pre-VAT figure. The number a schedule
   * foots to is VAT-inclusive and is not a whole baht, so the same trap lands at one satang:
   * half of ฿9,406.37 is ฿4,703.185, and two of those rounded up are ฿9,406.38.
   *
   * The decision this pins is that the ฿0.01 is **reported, not absorbed**. A planner that
   * quietly made the last row the difference would pass a test that only checked the sum,
   * and would leave a `percent 5000` row whose amount is not 50% — unreconstructible a year
   * later, when somebody asks what was agreed.
   */
  it('refuses a 50/50 written as two percent rows, and says by how much', () => {
    const half: ScheduleTerm = { basis: 'percent', percentBp: 5_000, gatesEntryTo: null };
    const plan = planSchedule(GRAND_8791, [{ ...half, gatesEntryTo: FREEZE_GATE_STATUS }, half]);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toEqual({
      reason: 'does_not_foot',
      scheduledMinor: 940_638n,
      totalMinor: 940_637n,
      deltaMinor: 1n,
    });
  });

  it('accepts the same 50/50 when the last row is the remainder, and it foots', () => {
    const instalments = planned(GRAND_8791, [
      { basis: 'percent', percentBp: 5_000, gatesEntryTo: FREEZE_GATE_STATUS },
      { basis: 'remainder', gatesEntryTo: null },
    ]);

    expect(dues(instalments)).toEqual([470_319n, 470_318n]);
    expect(470_319n + 470_318n).toBe(GRAND_8791);
  });

  /** Plan 7.10's amendment: a remainder is required only when the stated rows do not foot. */
  it('accepts exact fixed rows with no remainder at all', () => {
    const instalments = planned(GRAND_18432, [
      { basis: 'fixed', fixedThbMinor: 843_200n, gatesEntryTo: FREEZE_GATE_STATUS },
      { basis: 'fixed', fixedThbMinor: 1_000_000n, gatesEntryTo: null },
    ]);

    expect(dues(instalments)).toEqual([843_200n, 1_000_000n]);
  });

  it('refuses fixed rows that exceed the total instead of making the remainder negative', () => {
    const plan = planSchedule(GRAND_18432, depositFixedTerms(GRAND_18432 + 1n));

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure.reason).toBe('exceeds_total');
  });

  it('refuses a remainder that is not last, and two remainders, and an empty schedule', () => {
    const notLast = planSchedule(GRAND_18432, [
      { basis: 'remainder', gatesEntryTo: FREEZE_GATE_STATUS },
      { basis: 'percent', percentBp: 3_000, gatesEntryTo: null },
    ]);
    const twice = planSchedule(GRAND_18432, [
      { basis: 'remainder', gatesEntryTo: FREEZE_GATE_STATUS },
      { basis: 'remainder', gatesEntryTo: null },
    ]);
    const empty = planSchedule(GRAND_18432, []);

    expect(notLast.ok).toBe(false);
    expect(twice.ok).toBe(false);
    expect(empty.ok).toBe(false);
    if (!notLast.ok) expect(notLast.failure).toEqual({ reason: 'remainder_not_last', seq: 1, lastSeq: 2 });
    if (!twice.ok) expect(twice.failure).toEqual({ reason: 'multiple_remainders', seqs: [1, 2] });
    if (!empty.ok) expect(empty.failure.reason).toBe('no_terms');
  });

  it('refuses a percentage outside 1..10000 bp and a negative amount', () => {
    const zero = planSchedule(GRAND_18432, depositPercentTerms(0));
    const over = planSchedule(GRAND_18432, depositPercentTerms(10_001));
    const negative = planSchedule(GRAND_18432, depositFixedTerms(-1n));

    expect([zero.ok, over.ok, negative.ok]).toEqual([false, false, false]);
  });

  it('refuses more instalments than the module’s own ceiling', () => {
    const terms: ScheduleTerm[] = Array.from({ length: MAX_INSTALMENTS + 1 }, () => ({
      basis: 'fixed' as const,
      fixedThbMinor: 100n,
      gatesEntryTo: null,
    }));

    const plan = planSchedule(GRAND_18432, terms);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.failure.reason).toBe('too_many_instalments');
  });
});

describe('the deposit obligation is a prefix, not the gated rows', () => {
  it('is the whole total when one remainder gates the freeze', () => {
    expect(scheduledDepositMinor(planned(GRAND_8791, payInFullTerms()))).toBe(GRAND_8791);
  });

  it('is the 30 of a 30/70 — plan 7.8’s ฿5,529.60 and not ฿18,432', () => {
    expect(scheduledDepositMinor(planned(GRAND_18432, depositPercentTerms(3_000)))).toBe(DEPOSIT_30);
  });

  /**
   * The finding that a filter would get wrong.
   *
   * On 20/10/70 with the gate on the *second* row, the gate opens when the settled prefix
   * reaches seq 2 — so the first instalment is just as required, and the obligation is 30%.
   * Summing only rows that carry the gate answers 10%, which looks obviously right and
   * understates the ceiling on a forfeit by two thirds.
   */
  it('counts the ungated instalment sitting in front of the gating one', () => {
    const instalments = planned(GRAND_18432, [
      { basis: 'percent', percentBp: 2_000, gatesEntryTo: null },
      { basis: 'percent', percentBp: 1_000, gatesEntryTo: FREEZE_GATE_STATUS },
      { basis: 'remainder', gatesEntryTo: null },
    ]);

    const twenty = divRoundHalfUp(GRAND_18432 * 2_000n, 10_000n);
    const ten = divRoundHalfUp(GRAND_18432 * 1_000n, 10_000n);

    expect(scheduledDepositMinor(instalments)).toBe(twenty + ten);
    expect(scheduledDepositMinor(instalments)).not.toBe(ten);
  });

  it('is zero when nothing gates the freeze — which is the company extending credit', () => {
    const instalments = planned(GRAND_18432, [{ basis: 'remainder', gatesEntryTo: null }]);

    expect(scheduledDepositMinor(instalments)).toBe(0n);
    expect(gatedPrefixMinor(instalments, 'awaiting_installation')).toBe(0n);
    /* And the whole total is then a `cashflow` concession somebody has to approve. */
    expect(cashflowConcessionMinor(GRAND_18432, instalments)).toBe(GRAND_18432);
  });

  it('measures the concession a 30/70 asks for, against plan 13’s payment-in-full floor', () => {
    const full = planned(GRAND_18432, payInFullTerms());
    const split = planned(GRAND_18432, depositPercentTerms(3_000));

    expect(cashflowConcessionMinor(GRAND_18432, full)).toBe(0n);
    expect(cashflowConcessionMinor(GRAND_18432, split)).toBe(GRAND_18432 - DEPOSIT_30);
  });
});

describe('recomputing when the total moves — plan 7.5(ง)', () => {
  const thirtySeventy = (): readonly PlannedInstalment[] =>
    planned(GRAND_18432, depositPercentTerms(3_000));

  it('moves both rows while no money has arrived', () => {
    const raised = GRAND_18432 + 500_000n;
    const plan = recomputeSchedule(raised, thirtySeventy().map((instalment) => row(instalment)));

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(dues(plan.instalments)).toEqual([
      divRoundHalfUp(raised * 3_000n, 10_000n),
      raised - divRoundHalfUp(raised * 3_000n, 10_000n),
    ]);
  });

  /**
   * The one that separates a lock from a recalculation.
   *
   * The deposit has been paid, so instalment 1 is frozen at ฿5,529.60 even though 30% of the
   * new total is more. The remainder takes the entire increase. Mutation: dropping the
   * `isLocked` branch in `recomputeSchedule` re-derives instalment 1 from its percentage and
   * this expectation goes red — and in Postgres the same mutation is refused outright by
   * `order_instalments_guard_write()`, which is the pair of defences working as designed.
   */
  it('freezes a paid percent instalment and lets the remainder absorb the rise', () => {
    const raised = GRAND_18432 + 500_000n;
    const current = thirtySeventy().map((instalment, index) =>
      row(instalment, index === 0 ? DEPOSIT_30 : 0n),
    );

    const plan = recomputeSchedule(raised, current);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(dues(plan.instalments)).toEqual([DEPOSIT_30, raised - DEPOSIT_30]);
    expect(dues(plan.instalments).reduce((sum, due) => sum + due, 0n)).toBe(raised);
  });

  /** Plan 7.10: a `fixed` deposit stays put while the price moves; the remainder absorbs. */
  it('leaves a fixed instalment alone whether or not it has been paid', () => {
    const current = planned(GRAND_18432, depositFixedTerms(263_700n)).map((instalment) =>
      row(instalment),
    );
    const raised = GRAND_18432 + 100_000n;

    const plan = recomputeSchedule(raised, current);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(dues(plan.instalments)).toEqual([263_700n, raised - 263_700n]);
  });

  /**
   * A remainder cannot be locked, and that is why a gate can close again.
   *
   * The order was paid in full, the price rises, and the remainder — which holds all the
   * money — is recomputed upward regardless. `isLocked` says false for it, so the settled
   * prefix in the database moves *backwards* and `order_gate_is_open()` has to fall back to
   * the event spine. Nothing here computes that; this pins the half that makes it necessary.
   */
  it('recomputes a remainder that has already been paid in full', () => {
    const current = planned(GRAND_18432, payInFullTerms()).map((instalment) =>
      row(instalment, GRAND_18432),
    );
    const raised = GRAND_18432 + 1n;

    expect(isLocked(current[0] as ScheduleRow)).toBe(false);

    const plan = recomputeSchedule(raised, current);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(dues(plan.instalments)).toEqual([raised]);
  });

  /**
   * Plan 7.5(ง)(4): below what has been received is a refund, and never a negative row.
   *
   * Checked before the shape of the schedule is even considered, so it cannot be reported as
   * "does not foot" — a refund that presents as a validation error is a refund nobody opens.
   */
  it('reports a refund when the new total is below money already received', () => {
    const current = planned(GRAND_18432, payInFullTerms()).map((instalment) =>
      row(instalment, GRAND_18432),
    );

    const plan = recomputeSchedule(GRAND_18432 - 100_000n, current);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toEqual({
      reason: 'refund_required',
      receivedMinor: GRAND_18432,
      totalMinor: GRAND_18432 - 100_000n,
      overpaidMinor: 100_000n,
    });
  });

  /**
   * Money in the wrong bucket, which is not the same as money owed back.
   *
   * Reaching this at all took working out when it is even possible, and the answer is worth
   * writing down: it needs a locked instalment that is only **partly** paid. If every locked
   * row is settled to the satang, "the remainder falls below its allocation" and "more money
   * arrived than the order is worth" are the same inequality, and the refund branch — which
   * is tested first — always wins.
   *
   * Here instalment 1 is fixed at ฿9,000, only ฿1,000 of it has arrived, and the balance has
   * been paid ฿7,000. The new total of ฿10,000 covers the ฿8,000 received, so nothing is owed
   * back; the remainder would still have to shrink to ฿1,000 against ฿7,000 sitting on it.
   * The database refuses that UPDATE ("reducing it to X is a refund, not a schedule edit"),
   * and reporting it as `refund_required` would send somebody to pay out money that is not
   * owed. Two names, because they are two different jobs for a human.
   */
  it('separates a remainder below its own allocation from an actual overpayment', () => {
    const current = planned(1_500_000n, depositFixedTerms(900_000n)).map((instalment, index) =>
      row(instalment, index === 0 ? 100_000n : 700_000n),
    );

    const plan = recomputeSchedule(1_000_000n, current);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toEqual({
      reason: 'remainder_below_allocated',
      seq: 2,
      dueMinor: 100_000n,
      allocatedMinor: 700_000n,
    });
  });

  /** A frozen row above the new total, with less money received than the total is worth. */
  it('separates locked rows exceeding the total from an overpayment', () => {
    const current = planned(GRAND_18432, depositFixedTerms(1_500_000n)).map((instalment, index) =>
      row(instalment, index === 0 ? 100_000n : 0n),
    );

    const plan = recomputeSchedule(1_000_000n, current);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure).toEqual({
      reason: 'locked_exceeds_total',
      committedMinor: 1_500_000n,
      totalMinor: 1_000_000n,
      receivedMinor: 100_000n,
    });
  });

  it('refuses a stored schedule whose seq has a hole in it', () => {
    const [first, second] = thirtySeventy();
    if (first === undefined || second === undefined) throw new Error('bad fixture');

    const plan = recomputeSchedule(GRAND_18432, [row(first), row({ ...second, seq: 3 })]);

    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.failure).toEqual({ reason: 'seq_not_dense', seqs: [1, 3] });
  });
});
