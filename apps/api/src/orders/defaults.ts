import { VAT_RATE_BP_DEFAULT } from '@wewin/db/schema';
import type { TaxRule } from '@wewin/core/vat';

/**
 * ⚠️ THE NUMBERS ON THIS PAGE ARE DEFAULTS, NOT DECISIONS — plan section 13.
 *
 * Plan 13 exists because the "sales can edit anything" design round produced more than
 * thirty numbers that agents had invented and that read like answers. Its rule is that every
 * unanswered question must still have *defined behaviour on day one*, and that the behaviour
 * must be recognisable as a placeholder rather than as somebody's decision.
 *
 * So each constant here carries the plan's own default and the question it is standing in
 * for. None of them is a column default in Postgres: a `DEFAULT 700` in a migration is
 * exactly how a placeholder becomes a fact nobody remembers choosing, which is why
 * `packages/db` deliberately has none and the API passes and pins the value instead.
 *
 * Changing any of these is a configuration change, not a migration — that is the whole
 * point of pinning them per document.
 */

/**
 * VAT — plan 13 row 1, plan 4.4.
 *
 * 700 bp and `standard` — Thailand's own rate, and the fallback for an order naming no
 * destination or one `tax_countries` has no row for. Of the two questions this constant used
 * to stand in for, migration 0029 answered the first: whether an overseas customer is
 * zero-rated is now a per-destination fact in `tax_countries`, resolved by
 * `TaxCountryService.resolveDestination` and no longer this one rate for everybody. Whether
 * delivery and installation are taxable is still open; until somebody answers it, every line
 * on every destination is taxable at that destination's own rate, which is the conservative
 * direction for a filing (a business that over-declares owes nothing; one that under-declares
 * owes interest).
 *
 * The rate is *pinned per document* at submit, so answering the remaining question later
 * changes new quotes and cannot change what an old invoice reprints as.
 */
export const DEFAULT_VAT_RULE: TaxRule = {
  rateBp: VAT_RATE_BP_DEFAULT,
  treatment: 'standard',
};

/**
 * The deposit obligation — plan 13 row 3.
 *
 * The plan's default is **the whole amount** ("ประตูขั้นต่ำ = เต็มจำนวน (ปลอดภัยที่สุด)"), and it
 * is safest for a specific reason rather than out of caution: `scheduled_deposit_thb_minor`
 * is the ceiling on what may be forfeited if the customer walks away, and 5b's
 * `forfeitBase = min(receivedMinor, scheduledDepositMinor)` reads it. A too-low placeholder
 * would silently cap the company's protection; a too-high one cannot cause an over-charge,
 * because the forfeit is clamped a second time by cash actually received.
 *
 * SEAM 5b closed this constant's own role: `payments/schedule` now plans a real schedule of
 * basis + gate rows, and `scheduledDepositMinor` (`payments/schedule/plan.ts`) is the one
 * function, per plan 7.13, that folds the gate-holding instalments into the obligation —
 * three earlier implementations of it differed by ฿12,902 on the same 30/70 shape. This
 * constant is no longer read by that arithmetic; it is `payments/schedule/defaults.ts`'s
 * `GATE_COVERAGE_BP_DEFAULT` that plans the schedule now, and it carries the identical
 * value and the identical plan-13 default for the same reason.
 */
export const SCHEDULED_DEPOSIT_BP_DEFAULT = 10_000;

/** Basis points, as everywhere else: 10,000 bp is 100%. */
export const BP_DENOMINATOR = 10_000n;

/**
 * How many times one order may carry a customer objection — plan 13, and **not in it**.
 *
 * Stated plainly: the plan does not ask this question, so this is not even a plan default —
 * it is this module's own floor under a hole that the plan's own design opens. Plan 10.4
 * gives the customer a button that blocks entry to `production_confirmed` until somebody
 * answers it, and nothing anywhere caps the cycle open → rejected → open. Five rounds were
 * demonstrated against the running API; the order can be held out of production for ever,
 * by design, with every individual step legitimate.
 *
 * Ten is chosen to be far above any real negotiation (two or three rounds for a
 * made-to-measure window) and far below "for ever", so that hitting it is evidence of
 * something other than a customer with a question. The number the business actually wants —
 * and whether the right answer is a cap at all rather than an escalation to a human — is
 * theirs; this is what happens until they say.
 */
export const MAX_CHANGE_REQUESTS_PER_ORDER_DEFAULT = 10;

/**
 * The language a document is pinned in when the customer has expressed no preference.
 *
 * Plan 10.6 splits this from the notification language on purpose: a *notification* goes out
 * in the recipient's language at the time of sending, a *document* is frozen in the language
 * it was agreed in. A quote reprinted in a different language is a quote nobody can cite.
 */
export const DEFAULT_LOCALE = 'th';
