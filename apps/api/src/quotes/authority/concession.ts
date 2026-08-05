import { fromNet, type TaxRule } from '@wewin/core/vat';
import type {
  ApprovalDimension,
  OverrideAnchor,
  OverrideReason,
  QuoteLineKind,
} from '@wewin/db/schema';

import { cashflowConcessionMinor, type PlannedInstalment } from '../../payments/schedule';

/**
 * How much less the customer pays, and how much less arrives before production opens.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────────
 *
 * Plan 7.9 gives up on *"is this total correct?"* — once a human may set any number there is
 * nothing to check it against. What replaces it is *"where did this number come from, and was
 * that person allowed?"*, and the second half of that question needs a **size**: allowed to do
 * *how much*. This file is the size. Everything else in this module is a comparison against a
 * ceiling, and this is the only place the thing being compared is produced.
 *
 * ── One number per dimension, and the reason it is one ───────────────────────────
 *
 * Plan 7.13 found the two-person rule written six times in six places, each with its own hole.
 * The same failure is available here in a subtler shape: a ceiling per *kind* of concession —
 * one for discounts, one for goodwill lines, one for a VAT exemption — is several ceilings, and
 * a concession that fits under none of them individually still leaves the company by the same
 * door. So a `margin` figure is **one sum over four kinds of source**, and there is no second
 * budget for any of them.
 *
 * ── ⚠️ THE ONE KIND THAT WAS REMOVED, AND WHY REMOVING IT WAS THE FIX ────────────
 *
 * There was a fifth: `fx_shortfall`, plan 7.11's *"การยอมรับยอดที่ขาดคือส่วนลด"*. It arrived as a
 * function parameter rather than being read from a table, on the reasoning that nothing produces
 * one yet and inventing the table is how the wrong table gets built. The red team grepped for a
 * producer and found **zero**: every caller passed `[]`, including the submit gate. So the
 * dimension measured ฿0.00 on the day settlement lands — and worse, if whoever wired it threaded
 * shortfalls into `gate` but not into `request`, `covering` requires `>= conceded` and the order
 * would become permanently unsubmittable. Both branches wrong, behind a module header that read
 * as complete.
 *
 * A parameter no caller supplies is not a feature that is ready early; it is a hole with a name.
 * It is deleted. **`gate` and `request` now take no measurement input at all** — every figure is
 * read from rows inside the transaction — so the two cannot be wired asymmetrically, because
 * there is nothing to wire. Plan 13 closes the foreign-currency line entirely; the day it opens,
 * an FX shortfall is a row in whatever table records settlement, and it is added here as a
 * source read from that table, the same way every other source is.
 *
 * ── At the document level, and what that specifically defeats ────────────────────
 *
 * `measureMargin` takes the whole quote and returns one figure. Evaluating per row is the hole
 * plan 7.13 names: ten lines discounted 10% each pass individually, and a 22% document is
 * never reviewed by anybody. The sum is the defence, and `sources` is only the itemisation
 * that lets the approver see *what* added up.
 *
 * ── Nothing here reads a database, and nothing here decides ──────────────────────
 *
 * The same split `payments/schedule/plan.ts` makes. These are the arithmetic; whether the
 * person is allowed is `authority.service.ts`, and the two have to be able to disagree in a
 * test rather than only in production.
 */

/**
 * The four shapes a reduction in what the customer pays can arrive in.
 *
 * The brief lists six actions — line total down, document discount, grand total down, a
 * negative charge, goodwill, an FX adjustment. They are six *verbs* and four *rows*:
 *
 *   `line_total_override`   a line total set below what `calcPrice` produced.
 *   `grand_total_override`  the document total set below the figure it stood at. **This is
 *                           also "document discount"** — plan 7.9(ข) collapses a discount and
 *                           a total into one anchor precisely so that they cannot be counted
 *                           as two different things here.
 *   `negative_charge_line`  a free-form line with a negative amount. **This is also
 *                           "goodwill"** — goodwill is a credit line with a reason code on it,
 *                           not a mechanism of its own.
 *   `vat_exemption`         ⭐ a line marked not taxable. See `measureMargin` for why this is
 *                           here at all, and for the perverse direction it fixes.
 *
 * The fifth kind belongs to the other dimension and is listed here so that one inbox can
 * render one list: `gate_below_floor` is the whole of `cashflow` — a schedule that asks for
 * less before production than the floor requires, which at the extreme is a schedule with no
 * gate at all and is the company extending credit (plan 7.10).
 */
export const CONCESSION_SOURCE_KINDS = [
  'line_total_override',
  'grand_total_override',
  'negative_charge_line',
  'vat_exemption',
  'gate_below_floor',
] as const;

export type ConcessionSourceKind = (typeof CONCESSION_SOURCE_KINDS)[number];

/**
 * One reduction, priced in what the customer does not pay.
 *
 * `amountThbMinor` is always **positive and VAT-inclusive** — see `grossUp`. Positive because
 * a signed list would let a caller sum it and get a smaller number than the concession really
 * is; VAT-inclusive because the dimension is *"ทุกอย่างที่ลดยอดที่ลูกค้าจ่าย"* and the amount
 * the customer pays is the grand total.
 */
export interface ConcessionSource {
  readonly kind: ConcessionSourceKind;
  readonly amountThbMinor: bigint;
  /** The line it happened on, or null for a document-level source. */
  readonly quoteLineId: string | null;
  /** The `quote_overrides` row, when a row is what caused it. */
  readonly overrideId: string | null;
  /** Whatever reason the human gave, so the inbox can show it without a second query. */
  readonly reasonCode: OverrideReason | null;
}

/** The columns of `quote_lines` this measurement depends on, and no others. */
export interface QuoteLineFacts {
  readonly id: string;
  readonly kind: QuoteLineKind;
  /** Plan 7.9(ค): the rate is editable per line, so the gross-up is per line too. */
  readonly isVatApplicable: boolean;
  /** ⓵ COMPUTED — `calcPrice`'s figure, net. NULL on a free-form line. */
  readonly computedTotalThbMinor: bigint | null;
  /** The typed amount on a free-form line, net. May be negative — that is a credit. */
  readonly chargeTotalThbMinor: bigint | null;
}

/** A **live** row of `quote_overrides` — superseded rows are history and concede nothing today. */
export interface OverrideFacts {
  readonly id: string;
  readonly anchor: OverrideAnchor;
  readonly quoteLineId: string | null;
  readonly computedThbMinor: bigint | null;
  readonly overrideThbMinor: bigint | null;
  readonly reasonCode: OverrideReason;
}

export interface MarginInput {
  /** The rule the document is pinned to, or the current default before it is pinned. */
  readonly vat: TaxRule;
  readonly lines: readonly QuoteLineFacts[];
  readonly overrides: readonly OverrideFacts[];
}

export interface DimensionMeasurement {
  readonly dimension: ApprovalDimension;
  /** Always ≥ 0. Zero means there is nothing to approve, which is the smoke path. */
  readonly concessionThbMinor: bigint;
  readonly sources: readonly ConcessionSource[];
}

export interface DocumentConcessions {
  readonly margin: DimensionMeasurement;
  readonly cashflow: DimensionMeasurement;
}

/**
 * An override pointing at a line that is not in the live set.
 *
 * Not a 409 and not a validation failure — the same category plan 7.9(จ) creates for a
 * baseline that no longer matches: something that cannot happen has happened.
 * `quote_lines_guard_write()` refuses to remove a line while a live `line_total` override
 * hangs off it, so reaching this means the guard is gone or the two reads were not in one
 * transaction. Both are alarms, and both must not be answered by silently measuring a smaller
 * concession than the document actually grants.
 */
export class ConcessionIntegrityError extends Error {
  readonly overrideId: string;
  readonly quoteLineId: string;

  constructor(overrideId: string, quoteLineId: string) {
    super(
      `override ${overrideId} anchors to quote line ${quoteLineId}, which is not among the live lines`,
    );
    this.name = 'ConcessionIntegrityError';
    this.overrideId = overrideId;
    this.quoteLineId = quoteLineId;
  }
}

/**
 * A net reduction, expressed as the money the customer does not transfer.
 *
 * Line figures are net — `quote_lines.is_vat_applicable` exists precisely because VAT is
 * applied over the taxable subset — and the grand total is VAT-inclusive by plan 4.4. So a
 * ฿1,000 concession on a taxable line is ฿1,070 the customer does not pay, and a ceiling
 * compared against ฿1,000 is a ceiling 7% higher than whoever set it believes.
 *
 * ⚠️ Rounding is per source, at one satang, using core's `fromNet` — the same function the
 * document itself is built with, so there is no second VAT implementation here. Summing
 * grossed-up lines can therefore differ from grossing up the sum by a satang per source. That
 * is accepted, and it is safe **because this number is never posted anywhere**: it is
 * compared against a ceiling and written into `approvals.concession_thb_minor`, which is a
 * record of what was asked for. Nothing derives cash from it.
 */
function grossUp(netMinor: bigint, taxable: boolean, vat: TaxRule): bigint {
  return taxable ? fromNet(netMinor, vat).grandMinor : netMinor;
}

/**
 * Everything that reduces what the customer pays, added up once.
 *
 * ── Reductions add; increases do not subtract ────────────────────────────────────
 *
 * An override that puts a line *up* is not a negative concession and does not offset one
 * elsewhere. Netting is the attack: raise line A by ฿100,000 as a "rush charge", drop line B
 * by ฿100,000, and a netted measurement sees a document that concedes nothing while the
 * promise on line B is real, unreviewed, and the one the customer will hold the company to.
 *
 * The price of refusing to net is stated rather than hidden: a quote that genuinely reprices
 * one line up and another down asks for an approval covering the *downward* half even though
 * the total did not move. That is the fail-closed direction, it is visible in `sources`, and
 * the approver can read both halves.
 *
 * ── Why the two override anchors cannot double-count ─────────────────────────────
 *
 * `quote_overrides.computed_thb_minor` on a `grand_total` row is, by the schema's own
 * definition, *"the figure the document showed immediately before this override"* — which is
 * **after** the line overrides. So the grand-total delta is the incremental document-level
 * reduction and adding the two is not counting the same baht twice.
 *
 * ⚠️ That used to be a *comment*, and a red team walked through it: nothing constrained the
 * order of the two writes, so a `grand_total` written first and a `line_total` written second
 * over-counted by ฿1,070 on the fixture, and revoking the line promise from underneath a live
 * document promise **under**-counted by the same — the fail-open direction, on the number the
 * submit gate reads. `0018_quote_document_freeze.sql` now refuses both writes, so the
 * dependency this function has always declared is a rule the database keeps.
 *
 * ── ⭐ Why a VAT exemption is a concession ────────────────────────────────────────
 *
 * Plan 7.9(ค) puts the VAT *amount* in the "not editable" box and per-line taxability in the
 * "editable" one, which is right — an export sale really is zero-rated and somebody has to be
 * able to say so. But one `PATCH …/presentation` flipping `is_vat_applicable` moved ฿897.68 of
 * the customer's money on the red team's fixture, and because `grossUp` reads the flag *at
 * measurement time*, granting that ฿897.68 made the measured concession **smaller** by ฿70. The
 * single largest one-click money move on the screen moved the ceiling comparison the wrong way.
 *
 * So the baseline for taxability is plan 13's documented default — *"ทุกบรรทัดและทุกค่าบริการ
 * `is_vat_applicable = true`"* — and a line that departs from it concedes the tax it would
 * otherwise have carried, on its **effective** amount. The direction is now right: exempting a
 * line increases what has to be approved, by exactly the money the customer stops paying.
 *
 * The cost, stated: the day the owner answers plan 13's open question and says installation is
 * not taxable, every installation line will measure a concession until the *default* moves with
 * the answer. That is one constant in `orders/defaults.ts` and a fail-closed direction to be
 * wrong in.
 */
export function measureMargin(input: MarginInput): DimensionMeasurement {
  const linesById = new Map(input.lines.map((line) => [line.id, line]));
  const sources: ConcessionSource[] = [];

  for (const override of input.overrides) {
    /* `lead_time_days` is a promise and not money; it has no ceiling in either dimension. */
    if (override.anchor === 'lead_time_days') continue;

    const computed = override.computedThbMinor;
    const value = override.overrideThbMinor;
    /* `quote_overrides_value_shape` makes both non-null together on a money anchor; a row that
     * arrived any other way is not one this function should guess about. */
    if (computed === null || value === null) continue;

    const reduction = computed - value;
    if (reduction <= 0n) continue;

    if (override.anchor === 'grand_total') {
      sources.push({
        kind: 'grand_total_override',
        amountThbMinor: reduction,
        quoteLineId: null,
        overrideId: override.id,
        reasonCode: override.reasonCode,
      });
      continue;
    }

    const lineId = override.quoteLineId;
    /* `quote_overrides_scope_shape` makes a `line_total` row carry a line. */
    if (lineId === null) continue;

    const line = linesById.get(lineId);
    if (line === undefined) throw new ConcessionIntegrityError(override.id, lineId);

    sources.push({
      kind: 'line_total_override',
      amountThbMinor: grossUp(reduction, line.isVatApplicable, input.vat),
      quoteLineId: line.id,
      overrideId: override.id,
      reasonCode: override.reasonCode,
    });
  }

  /*
   * A negative free-form line is a discount wearing a different hat — the brief says so, and
   * so does `quote_lines.charge_total_thb_minor`'s own comment. It is counted here and not by
   * a baseline subtraction because a negative charge is its own baseline: there is no computed
   * figure it was taken against, so nothing else in this file can see it.
   */
  for (const line of input.lines) {
    const charge = line.chargeTotalThbMinor;
    if (charge === null || charge >= 0n) continue;

    sources.push({
      kind: 'negative_charge_line',
      amountThbMinor: grossUp(-charge, line.isVatApplicable, input.vat),
      quoteLineId: line.id,
      overrideId: null,
      reasonCode: null,
    });
  }

  /*
   * ⭐ A line the company has decided not to charge tax on.
   *
   * Measured on the line's **list** figure and not its effective one, so that each source in
   * this list is individually a sentence an approver can read: the override row above says
   * *"this promise costs ฿X"*, and this one says *"this line is not taxed; on its list price
   * that is ฿Y of VAT"*. The two add to exactly the right total — for a line computed at C,
   * promised at E and exempt, the customer pays `1.07·C − E` less than plan 13's baseline, and
   * `(C − E) + 0.07·C` is that number.
   *
   * A credit line is skipped rather than counted negative: it has no list price to be exempt
   * *from*, and the whole of what it removes is already in `negative_charge_line` at its own
   * taxability. A `sources` list with a negative row could be summed to a smaller figure than
   * the concession really is, which is the reason every amount here is positive.
   */
  for (const line of input.lines) {
    if (line.isVatApplicable) continue;

    const listed = line.computedTotalThbMinor ?? line.chargeTotalThbMinor ?? 0n;
    if (listed <= 0n) continue;

    sources.push({
      kind: 'vat_exemption',
      amountThbMinor: fromNet(listed, input.vat).vatMinor,
      quoteLineId: line.id,
      overrideId: null,
      reasonCode: null,
    });
  }

  return {
    dimension: 'margin',
    concessionThbMinor: sources.reduce((total, source) => total + source.amountThbMinor, 0n),
    sources,
  };
}

/**
 * How much less arrives before production opens.
 *
 * ⚠️ **The arithmetic is `payments/schedule`'s, not this module's.** `cashflowConcessionMinor`
 * already exists, is already tested, and is already the one definition of the gated prefix —
 * plan 7.13's ฿5,530-versus-฿18,432 seam. A second implementation here would be that seam
 * reopened by the module whose whole job is to stop mechanisms being written twice.
 *
 * All this adds is the shape the ceiling comparison needs, and one source row so that the
 * approver's inbox can say what the schedule actually gates.
 *
 * The floor it measures against is plan 13's documented default (`GATE_COVERAGE_BP_DEFAULT`,
 * payment in full) and **the owner has not answered it**. The consequence is stated where it
 * bites, in `authority.service.ts`.
 */
export function measureCashflow(
  grandTotalThbMinor: bigint,
  instalments: readonly PlannedInstalment[],
): DimensionMeasurement {
  const concession = cashflowConcessionMinor(grandTotalThbMinor, instalments);

  return {
    dimension: 'cashflow',
    concessionThbMinor: concession,
    /* One source or none, so that "nothing to approve" is an empty list in both dimensions. */
    sources:
      concession > 0n
        ? [
            {
              kind: 'gate_below_floor' as const,
              amountThbMinor: concession,
              quoteLineId: null,
              overrideId: null,
              reasonCode: null,
            },
          ]
        : [],
  };
}
