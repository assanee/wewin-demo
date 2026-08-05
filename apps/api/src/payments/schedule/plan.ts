import { divRoundHalfUp } from '@wewin/core/money';
import type { InstalmentBasis, OrderStatus } from '@wewin/db/schema';

import { BP_DENOMINATOR, FREEZE_GATE_STATUS, GATE_COVERAGE_BP_DEFAULT, MAX_INSTALMENTS } from './defaults';
import type { ScheduleTerm } from './terms';

/**
 * The instalment schedule as arithmetic: authoring it, and recomputing it when the total
 * moves. Nothing in this file touches a database, and that is deliberate — every rule below
 * is also a constraint in `0011_payment_guards.sql`, and the two have to be able to disagree
 * *in a test* rather than only in production.
 *
 * ── Why there are two layers of the same rules ───────────────────────────────────
 *
 * `assert_order_schedule()` refuses a schedule that does not foot, that is not dense from 1,
 * or whose remainder is not last. This module refuses the same things earlier, with the
 * numbers in the message. That is not redundancy in the sense that one of them could go: the
 * database's job is that no path can write a bad schedule, and this module's job is to
 * answer *which figure is wrong by how much* — ฿8,792 against a total of ฿8,791, delta ฿1 —
 * because "restrict_violation" is not something a salesperson can act on.
 *
 * The rule that is only here is the recompute policy, because it is a decision and not an
 * invariant: which rows are frozen, which are re-derived, and what happens when the answer
 * comes out negative.
 *
 * ── The rounding, stated once ────────────────────────────────────────────────────
 *
 * A `percent` instalment is `divRoundHalfUp(total × bp, 10000)` — core's half_up, which is
 * away from zero and therefore defined for the negatives `Math.round` gets wrong — at **one
 * satang**, not at one baht.
 *
 * Plan 7.5(ก) works its ฿8,791 example at whole baht, and that is the plan writing prose
 * about a pre-VAT figure. The number a schedule actually foots to is `grand_total_thb_minor`,
 * which includes VAT and therefore is not a whole baht at all: ฿8,791 net at 7% is
 * ฿9,406.37. Rounding instalments to whole baht on top of that would invent a business rule
 * nobody asked for and leave the remainder carrying the crumbs. So the trap the plan
 * describes is real and lands one decimal place further down — 50/50 of ฿9,406.37 is
 * ฿4,703.185 twice, which rounds to ฿9,406.38 — and `tests/payments/schedule/plan.test.ts`
 * pins exactly that figure.
 */

export interface PlannedInstalment {
  readonly seq: number;
  readonly basis: InstalmentBasis;
  readonly percentBp: number | null;
  readonly fixedThbMinor: bigint | null;
  readonly gatesEntryTo: OrderStatus | null;
  readonly dueThbMinor: bigint;
}

/** An instalment as it stands, with the one fact the slip module owns folded onto it. */
export interface ScheduleRow extends PlannedInstalment {
  /**
   * What accepted slips have settled against this row.
   *
   * Folded over **all** allocations and not only those on accepted slips, matching
   * `order_instalments_guard_write()` — the guard that will refuse the UPDATE this module is
   * about to issue. `assert_slip_allocations()` makes the two identical at every commit
   * boundary (a slip that is not accepted may hold no allocations at all), so the difference
   * can only appear mid-transaction, and there the stricter reading is the one that agrees
   * with the guard.
   */
  readonly allocatedThbMinor: bigint;
}

/**
 * Why a schedule could not be produced. Every case carries the numbers, not just a name.
 *
 * A discriminated union because the caller does genuinely different things with them: three
 * of these are "fix the schedule", one is "open a refund", and one is "this order is not
 * editable". Collapsing them into one error is how a refund becomes a 409 nobody follows up.
 */
export type SchedulePlanFailure =
  | { readonly reason: 'no_terms' }
  | { readonly reason: 'too_many_instalments'; readonly count: number; readonly maxCount: number }
  | { readonly reason: 'bad_percent'; readonly seq: number; readonly percentBp: number }
  | { readonly reason: 'negative_fixed'; readonly seq: number; readonly fixedThbMinor: bigint }
  | { readonly reason: 'multiple_remainders'; readonly seqs: readonly number[] }
  | { readonly reason: 'remainder_not_last'; readonly seq: number; readonly lastSeq: number }
  | { readonly reason: 'seq_not_dense'; readonly seqs: readonly number[] }
  | {
      /** No remainder to absorb the difference, and the stated rows do not add up. */
      readonly reason: 'does_not_foot';
      readonly scheduledMinor: bigint;
      readonly totalMinor: bigint;
      /** Positive when the schedule asks for more than the order is worth. */
      readonly deltaMinor: bigint;
    }
  | {
      /** The fixed and percent rows alone already exceed the total, so the remainder is negative. */
      readonly reason: 'exceeds_total';
      readonly scheduledMinor: bigint;
      readonly totalMinor: bigint;
    }
  | {
      /**
       * The new total is below money already received. Plan 7.5(ง)(4): that is a refund, and
       * it is never a negative instalment.
       */
      readonly reason: 'refund_required';
      readonly receivedMinor: bigint;
      readonly totalMinor: bigint;
      readonly overpaidMinor: bigint;
    }
  | {
      /**
       * The locked rows alone exceed the new total, but less money has arrived than the new
       * total — so nothing is owed back and yet the schedule cannot be made to foot.
       *
       * Distinct from `refund_required` on purpose. It is the case where a partially-paid
       * fixed instalment is frozen above what the order is now worth, and the resolution is
       * a human one (re-cut the schedule, which needs the lock to be released by moving the
       * money) rather than a payment out.
       */
      readonly reason: 'locked_exceeds_total';
      readonly committedMinor: bigint;
      readonly totalMinor: bigint;
      readonly receivedMinor: bigint;
    }
  | {
      /**
       * The remainder would fall below what has already been allocated *to it*.
       *
       * The mirror of `order_instalments_guard_write()`'s "reducing it to X is a refund, not
       * a schedule edit". Reported separately from `refund_required` because the totals can
       * still cover the money received while one row cannot — the money is in the wrong
       * bucket, which is a reallocation and not a payment out.
       */
      readonly reason: 'remainder_below_allocated';
      readonly seq: number;
      readonly dueMinor: bigint;
      readonly allocatedMinor: bigint;
    };

export type SchedulePlan =
  | { readonly ok: true; readonly instalments: readonly PlannedInstalment[] }
  | { readonly ok: false; readonly failure: SchedulePlanFailure };

const failed = (failure: SchedulePlanFailure): SchedulePlan => ({ ok: false, failure });

/**
 * A row without the allocation folded onto it.
 *
 * A plan is what the schedule *should* be, and carrying `allocatedThbMinor` through it would
 * hand the caller a plan and a settlement in one object — which is the first step towards
 * something writing the settlement back.
 */
const bare = (row: ScheduleRow): PlannedInstalment => ({
  seq: row.seq,
  basis: row.basis,
  percentBp: row.percentBp,
  fixedThbMinor: row.fixedThbMinor,
  gatesEntryTo: row.gatesEntryTo,
  dueThbMinor: row.dueThbMinor,
});

/** `total × bp / 10000`, half up and away from zero. The only place a percentage is applied. */
export const percentOf = (totalMinor: bigint, percentBp: number): bigint =>
  divRoundHalfUp(totalMinor * BigInt(percentBp), BP_DENOMINATOR);

/* ------------------------------------------------------------------ *
 * Authoring
 * ------------------------------------------------------------------ */

/**
 * Evaluate a list of terms against a total.
 *
 * The shape rules are checked before any arithmetic, so a schedule with two remainders is
 * reported as having two remainders rather than as not footing — the second message is true
 * and useless.
 */
export function planSchedule(totalMinor: bigint, terms: readonly ScheduleTerm[]): SchedulePlan {
  if (terms.length === 0) return failed({ reason: 'no_terms' });
  if (terms.length > MAX_INSTALMENTS) {
    return failed({ reason: 'too_many_instalments', count: terms.length, maxCount: MAX_INSTALMENTS });
  }

  const remainderSeqs = terms.flatMap((term, index) => (term.basis === 'remainder' ? [index + 1] : []));
  if (remainderSeqs.length > 1) return failed({ reason: 'multiple_remainders', seqs: remainderSeqs });

  const lastSeq = terms.length;
  const remainderSeq = remainderSeqs[0];
  if (remainderSeq !== undefined && remainderSeq !== lastSeq) {
    return failed({ reason: 'remainder_not_last', seq: remainderSeq, lastSeq });
  }

  const stated: PlannedInstalment[] = [];
  let statedTotal = 0n;

  for (const [index, term] of terms.entries()) {
    const seq = index + 1;

    if (term.basis === 'percent') {
      if (!Number.isInteger(term.percentBp) || term.percentBp < 1 || term.percentBp > 10_000) {
        return failed({ reason: 'bad_percent', seq, percentBp: term.percentBp });
      }

      const dueThbMinor = percentOf(totalMinor, term.percentBp);
      statedTotal += dueThbMinor;
      stated.push({
        seq,
        basis: 'percent',
        percentBp: term.percentBp,
        fixedThbMinor: null,
        gatesEntryTo: term.gatesEntryTo,
        dueThbMinor,
      });
      continue;
    }

    if (term.basis === 'fixed') {
      if (term.fixedThbMinor < 0n) {
        return failed({ reason: 'negative_fixed', seq, fixedThbMinor: term.fixedThbMinor });
      }

      statedTotal += term.fixedThbMinor;
      stated.push({
        seq,
        basis: 'fixed',
        percentBp: null,
        fixedThbMinor: term.fixedThbMinor,
        gatesEntryTo: term.gatesEntryTo,
        dueThbMinor: term.fixedThbMinor,
      });
      continue;
    }

    stated.push({
      seq,
      basis: 'remainder',
      percentBp: null,
      fixedThbMinor: null,
      gatesEntryTo: term.gatesEntryTo,
      dueThbMinor: 0n,
    });
  }

  if (remainderSeq === undefined) {
    /*
     * Plan 7.10 amends 7.5(ก) here, and the amendment is the reason this branch exists at
     * all: a remainder is required *unless the stated rows foot exactly*, because a schedule
     * sales typed as three exact amounts is a legitimate schedule and demanding a remainder
     * row would block it.
     *
     * When they do not foot, this is the ฿1. It is reported and never silently absorbed: the
     * difference has to have a named home, and "the last row quietly stopped being 50%" is
     * how a schedule becomes unreconstructible a year later.
     */
    if (statedTotal !== totalMinor) {
      return failed({
        reason: 'does_not_foot',
        scheduledMinor: statedTotal,
        totalMinor,
        deltaMinor: statedTotal - totalMinor,
      });
    }

    return { ok: true, instalments: stated };
  }

  const remainderDue = totalMinor - statedTotal;
  if (remainderDue < 0n) {
    return failed({ reason: 'exceeds_total', scheduledMinor: statedTotal, totalMinor });
  }

  return {
    ok: true,
    instalments: stated.map((instalment) =>
      instalment.seq === remainderSeq ? { ...instalment, dueThbMinor: remainderDue } : instalment,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Recomputation — plan 7.5(ง)
 * ------------------------------------------------------------------ */

/**
 * Whether a recompute may still move this row.
 *
 * `allocated > 0` **and not a remainder**. The second half is not an exception bolted on: a
 * remainder is *defined* as the absorber, so locking it would mean the price may never
 * change after the first payment — on orders that spend weeks in `redesign`, where plan 7.2
 * says the fix is usually more expensive than what it replaced.
 *
 * Which is also why "a gate, once open, never closes" is false, and why the database's
 * `order_gate_is_open()` asks the event spine first. Nothing in this module tries to
 * recompute that; it is the one frontier question and it has one implementation, in SQL.
 */
export const isLocked = (row: ScheduleRow): boolean =>
  row.basis !== 'remainder' && row.allocatedThbMinor > 0n;

/**
 * Re-derive a schedule for a new total: locked rows stand, the rest come from their basis,
 * the remainder absorbs the difference.
 *
 * The order of the failure checks is a decision. `refund_required` is tested **first**,
 * before the shape of the schedule is even considered, because "the customer has paid more
 * than this order is now worth" is true regardless of how the rows are arranged and it is
 * the one outcome that must never be reported as a schedule problem — a refund that presents
 * as a validation error is a refund nobody opens.
 */
export function recomputeSchedule(
  totalMinor: bigint,
  current: readonly ScheduleRow[],
): SchedulePlan {
  if (current.length === 0) return failed({ reason: 'no_terms' });

  const rows = [...current].sort((left, right) => left.seq - right.seq);
  const seqs = rows.map((row) => row.seq);
  if (seqs.some((seq, index) => seq !== index + 1)) return failed({ reason: 'seq_not_dense', seqs });

  const remainderSeqs = rows.flatMap((row) => (row.basis === 'remainder' ? [row.seq] : []));
  if (remainderSeqs.length > 1) return failed({ reason: 'multiple_remainders', seqs: remainderSeqs });

  const lastSeq = rows.length;
  const remainderSeq = remainderSeqs[0];
  if (remainderSeq !== undefined && remainderSeq !== lastSeq) {
    return failed({ reason: 'remainder_not_last', seq: remainderSeq, lastSeq });
  }

  const receivedMinor = rows.reduce((sum, row) => sum + row.allocatedThbMinor, 0n);
  if (receivedMinor > totalMinor) {
    return failed({
      reason: 'refund_required',
      receivedMinor,
      totalMinor,
      overpaidMinor: receivedMinor - totalMinor,
    });
  }

  const recomputed = rows.map((row): PlannedInstalment => {
    const stated = bare(row);
    if (row.basis === 'remainder' || isLocked(row)) return stated;

    if (row.basis === 'percent' && row.percentBp !== null) {
      return { ...stated, dueThbMinor: percentOf(totalMinor, row.percentBp) };
    }

    /* `fixed` stands still while the price moves — plan 7.10, and it is the point of `fixed`. */
    if (row.basis === 'fixed' && row.fixedThbMinor !== null) {
      return { ...stated, dueThbMinor: row.fixedThbMinor };
    }

    return stated;
  });

  const committedMinor = recomputed
    .filter((row) => row.basis !== 'remainder')
    .reduce((sum, row) => sum + row.dueThbMinor, 0n);

  if (remainderSeq === undefined) {
    if (committedMinor !== totalMinor) {
      return failed({
        reason: 'does_not_foot',
        scheduledMinor: committedMinor,
        totalMinor,
        deltaMinor: committedMinor - totalMinor,
      });
    }

    return { ok: true, instalments: recomputed };
  }

  const remainderDue = totalMinor - committedMinor;
  if (remainderDue < 0n) {
    return failed({ reason: 'locked_exceeds_total', committedMinor, totalMinor, receivedMinor });
  }

  const remainderRow = rows[remainderSeq - 1];
  if (remainderRow !== undefined && remainderDue < remainderRow.allocatedThbMinor) {
    return failed({
      reason: 'remainder_below_allocated',
      seq: remainderSeq,
      dueMinor: remainderDue,
      allocatedMinor: remainderRow.allocatedThbMinor,
    });
  }

  return {
    ok: true,
    instalments: recomputed.map((row) =>
      row.seq === remainderSeq ? { ...row, dueThbMinor: remainderDue } : row,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * The folds
 * ------------------------------------------------------------------ */

/**
 * The prefix that must be settled before the order may enter `status`.
 *
 * **A prefix, not a filter.** The frontier is `MAX(seq)` over the settled *prefix*
 * (plan 7.5(ค)), so an ungated instalment sitting in front of the gating one is just as
 * required: on a 20/10/70 whose gate is on the second row, ฿30 of every ฿100 must arrive
 * before production, not ฿10. Summing only the rows that carry the gate is the reading that
 * looks obviously right and quietly understates the obligation — and the obligation is the
 * ceiling on a forfeit.
 *
 * Zero when nothing gates the status. That is a real answer and it means production opens
 * with no money in hand, which plan 7.10 calls extending credit and puts behind an approval.
 */
export function gatedPrefixMinor(
  rows: readonly PlannedInstalment[],
  status: OrderStatus,
): bigint {
  const gateSeq = rows.reduce(
    (highest, row) => (row.gatesEntryTo === status && row.seq > highest ? row.seq : highest),
    0,
  );

  if (gateSeq === 0) return 0n;

  return rows.reduce((sum, row) => (row.seq <= gateSeq ? sum + row.dueThbMinor : sum), 0n);
}

/**
 * `scheduledDepositMinor` — plan 7.13's seam, as a fold over the schedule.
 *
 * The seam exists because three designs produced ฿5,530 and ฿18,432 for the same 30/70
 * order, a difference of ฿12,902 in what a customer gets back. There is one definition here
 * and it is the gated prefix into the freeze point.
 *
 * ⚠️ THIS IS NOT THE NUMBER A FORFEIT READS. Plan 7.13 pins the deposit onto `orders` at
 * submit, because it is a term of the contract and not a figure recomputed at cancellation
 * time, when the schedule may since have been edited. This function produces the figure to
 * *pin*; `orders.scheduled_deposit_thb_minor` is the figure to *use*.
 */
export const scheduledDepositMinor = (rows: readonly PlannedInstalment[]): bigint =>
  gatedPrefixMinor(rows, FREEZE_GATE_STATUS);

/**
 * How far below the gate floor a schedule sits — the `cashflow` concession, in THB minor.
 *
 * Plan 7.13 collapsed six two-person rules into one `approvals` table with two dimensions,
 * of which `cashflow` is "anything that reduces the money in hand before production opens".
 * This is that amount: the floor (plan 13's default is payment in full) minus what the
 * schedule actually gates. Zero means no concession and therefore nothing to approve.
 *
 * It is measured here and enforced nowhere in 5b. Authoring is 5c, and 5b has no route that
 * can produce a schedule below the floor — the presets are the only authors, and the default
 * preset *is* the floor.
 */
export function cashflowConcessionMinor(
  totalMinor: bigint,
  rows: readonly PlannedInstalment[],
  floorBp: number = GATE_COVERAGE_BP_DEFAULT,
): bigint {
  const floorMinor = percentOf(totalMinor, floorBp);
  const gatedMinor = scheduledDepositMinor(rows);
  return gatedMinor >= floorMinor ? 0n : floorMinor - gatedMinor;
}
