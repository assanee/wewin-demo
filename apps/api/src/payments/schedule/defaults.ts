import type { OrderStatus } from '@wewin/db/schema';

/**
 * ⚠️ DEFAULTS, NOT DECISIONS — plan section 13, row "มัดจำ".
 *
 * Plan 13 asks the owner three things about deposits and none of them has been answered:
 * the floor under a gate-holding instalment, the maximum number of instalments, and who may
 * approve a schedule with no gate at all (which is the company extending credit). Its own
 * documented default for the first is **payment in full** — "ประตูขั้นต่ำ = เต็มจำนวน
 * (ปลอดภัยที่สุด)" — and that is what is here.
 *
 * Each constant says which of the three it stands in for and what happens until somebody
 * answers, because plan 13's rule is that an unanswered question must still have defined
 * behaviour on day one and that the behaviour must be recognisable as a placeholder.
 */

/**
 * The status a deposit opens. Not configurable, and it did not move.
 *
 * Plan 7.5(ข): the deposit changed the *condition* on the freeze point, not the freeze point
 * itself. The freeze is still entry to `production_confirmed`, and accepting the slip that
 * closes the gating instalment is that transition. Later slips are payment-level events that
 * move no order — which is why there is no `awaiting_balance` anywhere in this module.
 */
export const FREEZE_GATE_STATUS: OrderStatus = 'production_confirmed';

/**
 * How much of the total must be gated behind the freeze, in basis points — plan 13.
 *
 * 10,000 bp is payment in full, which is the plan's default and is safe in a specific
 * direction rather than out of caution: the gated prefix is the deposit obligation, and the
 * deposit obligation is the ceiling on what may be forfeited if the customer walks away
 * (plan 7.8, `forfeitBase = min(received, scheduledDeposit)`). A placeholder that is too low
 * silently caps the company's protection; one that is too high cannot over-charge anybody,
 * because the forfeit is clamped a second time by money actually held.
 *
 * ⚠️ No longer what production measures against. Task 12 (plan 7.10) answered the authoring
 * question this constant used to stand in for: the floor `cashflowConcessionMinor` measures
 * a proposed schedule against is `organisation_profile.deposit_bp`, one row, read through
 * `DepositPolicyPort` on every measurement — `AuthorityService.measureFor` requires the
 * caller to pass it rather than falling back here. This constant survives only as
 * `cashflowConcessionMinor`'s own default parameter (reachable from `plan.test.ts` and from
 * nowhere else in `src`) and as the value migration 0029 seeded that column with, so the two
 * cannot disagree on day one.
 */
export const GATE_COVERAGE_BP_DEFAULT = 10_000;

/**
 * A ceiling on instalment count — **this module's own floor under a hole, not a plan number**.
 *
 * Plan 13 asks for "จำนวนงวดสูงสุด" and offers no default, so there is none to quote. Left
 * unbounded, a 5c authoring route inserts as many rows per order as the caller lists, and
 * every one of them is a row the recompute walks and a line the reviewer's screen renders.
 * Twenty-four is far above any real payment plan for a made-to-measure window and far below
 * "unbounded", so hitting it is evidence of something other than a payment plan.
 */
export const MAX_INSTALMENTS = 24;

/**
 * The statuses whose schedule may still be written — plan 7.5(ง), and it is three, not one.
 *
 * `redesign` is the one that gets forgotten. Work bounced by the factory always lands there,
 * plan 7.2 says the fix is usually *more* expensive than what it replaced, and the money for
 * the original quote is already in hand — so `redesign` is precisely the status where a
 * recompute has to work. `order_instalments_live_orders_only` in the guards migration carries
 * the same list, and `contract-drift.pg.test.ts` compares the two.
 */
export const SCHEDULE_EDITABLE_STATUSES: readonly OrderStatus[] = [
  'draft',
  'awaiting_payment',
  'redesign',
];

/** Basis points, as everywhere else: 10,000 bp is 100%. */
export const BP_DENOMINATOR = 10_000n;
