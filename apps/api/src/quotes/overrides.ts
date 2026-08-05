import { fromGrand, fromNet, type TaxRule } from '@wewin/core/vat';
import type { OverrideAnchorWire } from '@wewin/contract/quote';

/**
 * `applyOverrides` — the single function that produces the money a quote actually says.
 *
 * ── The three layers, and the direction they compose in (plan 7.9(ก)) ────────────
 *
 *   computed   what `calcPrice` said, per line. Arrives here already computed; this module
 *              never prices anything and never imports `pricing.ts`.
 *   override   a row holding both the figure it was taken against and the figure a human
 *              set. Absolute, never a delta.
 *   document   frozen JSONB at submit. Not this module's business either — what this
 *              produces is the *input* to that freeze.
 *
 * **`calcPrice` is not touched, and this function is the reason it does not have to be.**
 * Plan 7.9(ก): folding overrides into it would end 219 tests as a safety net, notably the
 * one asserting the breakdown lines sum to the unit price. The cost of keeping them apart is
 * this file, and this file is a cheaper thing to review than a pricing function with a
 * `humanOverride?` parameter threaded through it.
 *
 * ── The cascade is one-directional, and it has to be ─────────────────────────────
 *
 *     line totals  →  taxable / exempt subtotals  →  VAT  →  grand total  →  grand override
 *
 * Never back up the chain. That is what makes "recompute the baseline and compare" a
 * well-defined operation at submit (plan 7.9(จ)): a `grand_total` override's baseline is the
 * document total *after* the line overrides, so re-verifying the lines first and the document
 * second reproduces exactly the figure that was stored. If the arrows ran both ways there
 * would be no order in which to check them.
 *
 * ── VAT is derived, always, and the grand total is the base ──────────────────────
 *
 * Plan 4.4: the rate, the treatment and per-line applicability are configurable; the VAT
 * *amount* is not. So a `grand_total` override does not "also set the VAT" — it sets what the
 * customer transfers, and `fromGrand` divides the tax back out of it. Editing a net total
 * would be setting the VAT amount by the back door, which is why `net_total` is deliberately
 * not an anchor.
 *
 * One rounding point per layer (plan 4.3(ข)): the tax is taken **once**, over the taxable
 * subtotal, never per line. Rounding the tax on each line and adding those up gives a
 * different figure from taxing the sum, and every instalment, forfeit and refund in this
 * system foots against the single grand total.
 *
 * ── ⚠️ WHAT THIS FILE NO LONGER DOES, AND WHY THAT MATTERED ──────────────────────
 *
 * It used to also return `marginConcessionThbMinor` — the untouched document's grand total less
 * the effective one, clamped at zero — as "the concession", for the editor to render. That was
 * a **second measurement of a quantity `authority/concession.ts` already measures**, which is
 * plan 7.13's opening finding reproduced inside one directory, and the round shipped with a
 * test called `concession-agreement.test.ts` asserting the two agreed.
 *
 * They did not agree. Three cases were found, two by red teams and one by the module's own
 * author, and they disagree in **both directions**:
 *
 *   netting          line A overridden up ฿10,000, line B down ฿10,000.
 *                    subtraction ฿0 · sum ฿10,700. The ฿10,700 promise on B is real, and the
 *                    subtraction hides it behind an unrelated uplift.
 *   a stale document baseline
 *                    subtraction ฿19,628.61 · sum ฿0.00, on plan 7.9's own numbers.
 *   write order      a `grand_total` written before a `line_total`, or a `line_total` revoked
 *                    from under one: ±฿1,070 apart on identical rows.
 *
 * So there is one measurement now, `measureMargin`, and this file produces the money only. The
 * `baseline` below stays because it is a *figure to render* — "what this document would say
 * with nothing negotiated" — and not a number any ceiling is compared against. The other two
 * disagreements are closed at the source: `0018_quote_document_freeze.sql` makes the write order
 * a rule instead of a comment, and `verifyBaselines` now re-verifies the document anchor.
 *
 * ── Why the baseline drops negative charges ──────────────────────────────────────
 *
 * A −฿1,000 goodwill line needs no override to exist, so a baseline that included it would
 * render "before any negotiation" as a figure that already contains the negotiation. It is
 * dropped for display for the same reason `measureMargin` counts it as a source: plan 7.13
 * lists *a negative charge* among the things the `margin` dimension has to catch.
 */

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** A configured line: `calcPrice`'s figure for the whole line, at this quantity. */
export interface ComputedLine {
  readonly lineId: string;
  readonly seq: number;
  readonly qty: number;
  readonly computedTotalThbMinor: bigint;
  readonly isVatApplicable: boolean;
}

/** A free-form line: delivery, installation, a survey, a goodwill credit. May be negative. */
export interface ChargeLine {
  readonly lineId: string;
  readonly seq: number;
  readonly chargeTotalThbMinor: bigint;
  readonly isVatApplicable: boolean;
}

/** A live override, as the table holds it. Both halves, always — see `quote_overrides`. */
export interface LiveOverride {
  readonly id: string;
  readonly anchor: OverrideAnchorWire;
  readonly quoteLineId: string | null;
  readonly computedThbMinor: bigint | null;
  readonly overrideThbMinor: bigint | null;
  readonly computedDays: number | null;
  readonly overrideDays: number | null;
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface EffectiveLine {
  readonly lineId: string;
  readonly seq: number;
  /** VAT-exclusive, after this line's own override if it has one. */
  readonly effectiveTotalThbMinor: bigint;
  /** What it would have been with no override: the computed figure, or the typed charge. */
  readonly baselineTotalThbMinor: bigint;
  readonly isVatApplicable: boolean;
  readonly overrideId: string | null;
}

export interface EffectiveMoney {
  readonly netThbMinor: bigint;
  readonly taxableNetThbMinor: bigint;
  readonly exemptNetThbMinor: bigint;
  readonly vatThbMinor: bigint;
  /** Always VAT-inclusive — plan 4.4. The single base (plan 7.13, first seam). */
  readonly grandTotalThbMinor: bigint;
}

export interface EffectiveQuote {
  readonly lines: readonly EffectiveLine[];
  readonly money: EffectiveMoney;
  /**
   * The same document with no overrides and no negative charges — **a figure to render**.
   *
   * "What this quote would say if nothing had been negotiated", shown beside the effective
   * total so a salesperson can see both. Never shown to a customer: it is not a price anybody
   * was quoted. And deliberately **not** the thing a concession is derived from any more —
   * `measureMargin` is, and see this file's header for the three ways the subtraction and the
   * sum were found to disagree.
   */
  readonly baseline: EffectiveMoney;
  readonly computedLeadTimeDays: number;
  readonly effectiveLeadTimeDays: number;
  /**
   * ⚠️ A state that cannot be submitted, reported rather than thrown.
   *
   * Reachable: set a grand total of ฿10,000, then add a ฿12,000 VAT-exempt installation
   * charge. Nothing in the database forbids the pair — the line guard protects lines that
   * carry a promise, and this line carries none — and the arithmetic has no answer, because
   * the exempt charges alone already exceed what the customer is to transfer.
   *
   * `applyOverrides` is total on purpose: a read of a quote in this state must render it and
   * say what is wrong, not 500. The *write* path refuses to leave the quote here
   * (`assertCoherent`), so the only way in is a state that predates that check.
   */
  readonly grandOverrideBelowExemptCharges: boolean;
}

/* ------------------------------------------------------------------ *
 * The function
 * ------------------------------------------------------------------ */

export interface ApplyOverridesInput {
  readonly computed: readonly ComputedLine[];
  readonly charges: readonly ChargeLine[];
  readonly overrides: readonly LiveOverride[];
  readonly vat: TaxRule;
  /** The standard promise, when no `lead_time_days` override replaces it. See `defaults.ts`. */
  readonly computedLeadTimeDays: number;
}

export function applyOverrides(input: ApplyOverridesInput): EffectiveQuote {
  const { computed, charges, overrides, vat } = input;

  const lineOverrides = new Map<string, LiveOverride>();
  let grandOverride: LiveOverride | undefined;
  let leadTimeOverride: LiveOverride | undefined;

  for (const override of overrides) {
    switch (override.anchor) {
      case 'line_total':
        /*
         * `quote_overrides_one_active_per_line` makes this at most one row per line, so a
         * second one arriving here is a state the database says cannot exist. Overwriting
         * silently would make the effective price depend on row order; the map is keyed so
         * that it cannot, and the repository orders by `created_at` so that if the index were
         * ever dropped the *latest* promise would win rather than an arbitrary one.
         */
        if (override.quoteLineId !== null) lineOverrides.set(override.quoteLineId, override);
        break;
      case 'grand_total':
        grandOverride = override;
        break;
      case 'lead_time_days':
        leadTimeOverride = override;
        break;
    }
  }

  const lines: EffectiveLine[] = [];

  for (const line of computed) {
    lines.push(effective(line.lineId, line.seq, line.computedTotalThbMinor, line.isVatApplicable, lineOverrides));
  }
  for (const charge of charges) {
    lines.push(effective(charge.lineId, charge.seq, charge.chargeTotalThbMinor, charge.isVatApplicable, lineOverrides));
  }
  lines.sort((left, right) => left.seq - right.seq);

  /* ── the effective document ────────────────────────────────────────── */

  let taxableNet = 0n;
  let exemptNet = 0n;
  for (const line of lines) {
    if (line.isVatApplicable) taxableNet += line.effectiveTotalThbMinor;
    else exemptNet += line.effectiveTotalThbMinor;
  }

  const taxedFromLines = fromNet(taxableNet, vat);
  let money: EffectiveMoney = {
    netThbMinor: taxedFromLines.netMinor + exemptNet,
    taxableNetThbMinor: taxedFromLines.netMinor,
    exemptNetThbMinor: exemptNet,
    vatThbMinor: taxedFromLines.vatMinor,
    grandTotalThbMinor: taxedFromLines.grandMinor + exemptNet,
  };

  let belowExempt = false;

  if (grandOverride?.overrideThbMinor !== undefined && grandOverride.overrideThbMinor !== null) {
    const promised = grandOverride.overrideThbMinor;
    /*
     * The exempt charges pass through untouched and the taxable portion absorbs the whole
     * adjustment. Any other split would be deciding, on the customer's behalf, that part of
     * their concession applies to a charge that carries no tax — and it is the taxable half
     * whose VAT has to come back out by division, so the half that moves has to be that one.
     */
    const taxableGrand = promised - exemptNet;
    belowExempt = taxableGrand < 0n;

    const taxed = fromGrand(belowExempt ? 0n : taxableGrand, vat);
    money = {
      netThbMinor: taxed.netMinor + exemptNet,
      taxableNetThbMinor: taxed.netMinor,
      exemptNetThbMinor: exemptNet,
      vatThbMinor: taxed.vatMinor,
      grandTotalThbMinor: promised,
    };
  }

  /* ── the baseline the concession is measured from ──────────────────── */

  let baseTaxable = 0n;
  let baseExempt = 0n;
  for (const line of lines) {
    /* A negative charge is a concession, not a price. It is absent from the baseline so that
     * `baseline − effective` scores it. */
    if (line.baselineTotalThbMinor < 0n) continue;
    if (line.isVatApplicable) baseTaxable += line.baselineTotalThbMinor;
    else baseExempt += line.baselineTotalThbMinor;
  }

  const baseTaxed = fromNet(baseTaxable, vat);
  const baseline: EffectiveMoney = {
    netThbMinor: baseTaxed.netMinor + baseExempt,
    taxableNetThbMinor: baseTaxed.netMinor,
    exemptNetThbMinor: baseExempt,
    vatThbMinor: baseTaxed.vatMinor,
    grandTotalThbMinor: baseTaxed.grandMinor + baseExempt,
  };

  const effectiveDays = leadTimeOverride?.overrideDays ?? input.computedLeadTimeDays;

  return {
    lines,
    money,
    baseline,
    computedLeadTimeDays: input.computedLeadTimeDays,
    effectiveLeadTimeDays: effectiveDays,
    grandOverrideBelowExemptCharges: belowExempt,
  };
}

function effective(
  lineId: string,
  seq: number,
  baselineMinor: bigint,
  isVatApplicable: boolean,
  lineOverrides: ReadonlyMap<string, LiveOverride>,
): EffectiveLine {
  const override = lineOverrides.get(lineId);
  const promised = override?.overrideThbMinor;

  return {
    lineId,
    seq,
    effectiveTotalThbMinor: promised ?? baselineMinor,
    baselineTotalThbMinor: baselineMinor,
    isVatApplicable,
    overrideId: override?.id ?? null,
  };
}

/**
 * Whether an override's stored baseline still agrees with today's computed figure.
 *
 * Plan 7.9(จ)'s comparison, isolated so the submit path and the editor's read cannot each
 * grow their own version of it. It answers *equal or not*; what a mismatch **means** is the
 * caller's decision and the two possible meanings are very different — see
 * `verification.ts`.
 */
export const baselineMatches = (override: LiveOverride, computedNow: bigint): boolean =>
  override.computedThbMinor === computedNow;
