import { describe, expect, it } from 'vitest';
import { fromNet, type TaxRule } from '@wewin/core/vat';

import {
  ConcessionIntegrityError,
  measureCashflow,
  measureMargin,
  type OverrideFacts,
  type QuoteLineFacts,
} from '../../../src/quotes/authority/concession';
import type { PlannedInstalment } from '../../../src/payments/schedule';

/**
 * How much less the customer pays — the arithmetic, with no database anywhere near it.
 *
 * Every property here is about a *decision*, not about SQL: whether ten small discounts add up,
 * whether an increase cancels a decrease, whether a credit line counts, whether the FX
 * concession gets a budget of its own. All four are things a reviewer can be wrong about
 * without any statement failing, which is exactly the class of bug a Postgres suite cannot see.
 *
 * The figures are plan 7.9's own: ฿8,791 net, VAT 7%, and the ฿18,432 line the plan uses when
 * it works the "which number wins" example.
 */

const VAT_7: TaxRule = { rateBp: 700, treatment: 'standard' };
const VAT_NONE: TaxRule = { rateBp: 0, treatment: 'zero_rated' };

/** ฿8,791.00 in satang — the plan's spec case 6, and exactly divisible by the 7% grid. */
const NET_8791 = 879_100n;
/** ฿18,432.00 in satang — plan 7.9(ข)'s worked example. */
const NET_18432 = 1_843_200n;

const catalogLine = (id: string, computed: bigint, taxable = true): QuoteLineFacts => ({
  id,
  kind: 'catalog',
  isVatApplicable: taxable,
  computedTotalThbMinor: computed,
  chargeTotalThbMinor: null,
});

const freeformLine = (id: string, charge: bigint, taxable = true): QuoteLineFacts => ({
  id,
  kind: 'freeform',
  isVatApplicable: taxable,
  computedTotalThbMinor: null,
  chargeTotalThbMinor: charge,
});

const lineOverride = (
  id: string,
  quoteLineId: string,
  computed: bigint,
  value: bigint,
): OverrideFacts => ({
  id,
  anchor: 'line_total',
  quoteLineId,
  computedThbMinor: computed,
  overrideThbMinor: value,
  reasonCode: 'volume',
});

const grandOverride = (id: string, computed: bigint, value: bigint): OverrideFacts => ({
  id,
  anchor: 'grand_total',
  quoteLineId: null,
  computedThbMinor: computed,
  overrideThbMinor: value,
  reasonCode: 'relationship',
});

const margin = (input: {
  lines?: readonly QuoteLineFacts[];
  overrides?: readonly OverrideFacts[];
  vat?: TaxRule;
}) =>
  measureMargin({
    vat: input.vat ?? VAT_7,
    lines: input.lines ?? [],
    overrides: input.overrides ?? [],
  });

describe('margin — the document level, which is the whole point', () => {
  /**
   * The attack plan 7.13 names, run.
   *
   * Ten lines discounted 10% each. Every single one is small; the document is not. A per-row
   * evaluation asks ten questions and answers "fine" ten times, and nobody ever sees the
   * twenty-two thousand baht.
   */
  it('sums ten lines discounted 10% each, instead of asking about each one', () => {
    const lines = Array.from({ length: 10 }, (_, index) => catalogLine(`line-${index}`, NET_18432));
    const overrides = lines.map((line, index) =>
      lineOverride(`ov-${index}`, line.id, NET_18432, (NET_18432 * 9n) / 10n),
    );

    const measured = margin({ lines, overrides });

    /* One tenth of ฿18,432, ten times, grossed to what the customer does not transfer. */
    const perLineNet = NET_18432 / 10n;
    const perLineGrand = fromNet(perLineNet, VAT_7).grandMinor;

    expect(measured.sources).toHaveLength(10);
    expect(measured.concessionThbMinor).toBe(perLineGrand * 10n);
    /*
     * ฿19,722.20 — an order of magnitude above the largest single concession on the document.
     *
     * And it is not ฿19,722.24: ฿1,843.20 grossed at 7% is ฿1,972.224, which half_up puts at
     * ฿1,972.22 *per line*, ten times. That four-satang difference from grossing up the sum is
     * the per-source rounding `grossUp` documents, pinned here so that changing where the
     * rounding happens fails a test rather than moving a ceiling comparison silently.
     */
    expect(measured.concessionThbMinor).toBe(1_972_220n);
    expect(measured.concessionThbMinor).toBeGreaterThan(perLineGrand);
  });

  it('is zero when nobody has conceded anything — the smoke path', () => {
    const measured = margin({ lines: [catalogLine('a', NET_8791), freeformLine('b', 200_000n)] });

    expect(measured.concessionThbMinor).toBe(0n);
    expect(measured.sources).toEqual([]);
  });

  /**
   * An increase is not a negative concession.
   *
   * The netting attack: raise line A by ฿100,000 as a "rush charge", drop line B by ฿100,000.
   * A netted measurement sees a document that concedes nothing, while the promise on line B is
   * real, unreviewed, and the one the customer will hold the company to.
   */
  it('does not let an override upwards pay for an override downwards', () => {
    const lines = [catalogLine('a', NET_18432), catalogLine('b', NET_18432)];
    const overrides = [
      lineOverride('up', 'a', NET_18432, NET_18432 + 1_000_000n),
      lineOverride('down', 'b', NET_18432, NET_18432 - 1_000_000n),
    ];

    const measured = margin({ lines, overrides });

    expect(measured.sources).toHaveLength(1);
    expect(measured.sources[0]?.kind).toBe('line_total_override');
    expect(measured.concessionThbMinor).toBe(fromNet(1_000_000n, VAT_7).grandMinor);
  });

  it('counts a negative free-form line, which is a discount wearing a different hat', () => {
    const measured = margin({
      lines: [catalogLine('a', NET_8791), freeformLine('goodwill', -100_000n)],
    });

    expect(measured.sources).toHaveLength(1);
    expect(measured.sources[0]?.kind).toBe('negative_charge_line');
    expect(measured.concessionThbMinor).toBe(fromNet(100_000n, VAT_7).grandMinor);
  });

  it('does not count an ordinary positive charge as a concession', () => {
    const measured = margin({ lines: [freeformLine('delivery', 200_000n)] });

    expect(measured.concessionThbMinor).toBe(0n);
  });

  /**
   * ⚠️ THE FX SOURCE IS GONE, AND ITS ABSENCE IS THE ASSERTION.
   *
   * Plan 7.11 is right that accepting a short bank credit is a discount and must not get a
   * ceiling of its own. What shipped was a `settlementShortfalls` **parameter** on this
   * function, on the reasoning that nothing produces one yet. Nothing did: a grep for a
   * producer returned zero, every caller passed `[]`, and the submit gate therefore measured
   * ฿0.00 on the day settlement lands — while a future caller threading shortfalls into `gate`
   * but not into `request` would have made the order permanently unsubmittable, because
   * `covering` requires `>= conceded`.
   *
   * A parameter no caller supplies is not a feature that arrived early; it is a hole with a
   * name on it. `measureMargin` now takes lines, overrides and a VAT rule — nothing a caller
   * can use to change the figure — and this test is what fails if one comes back.
   */
  it('takes no input a caller could use to make the concession smaller', () => {
    const keys = Object.keys({
      vat: VAT_7,
      lines: [] as readonly QuoteLineFacts[],
      overrides: [] as readonly OverrideFacts[],
    } satisfies Parameters<typeof measureMargin>[0]);

    expect(keys.toSorted()).toStrictEqual(['lines', 'overrides', 'vat']);
  });

  it('leaves a lead-time override out of both dimensions — it is a promise, not money', () => {
    const measured = margin({
      lines: [catalogLine('a', NET_8791)],
      overrides: [
        {
          id: 'lead',
          anchor: 'lead_time_days',
          quoteLineId: null,
          computedThbMinor: null,
          overrideThbMinor: null,
          reasonCode: 'correction',
        },
      ],
    });

    expect(measured.concessionThbMinor).toBe(0n);
  });
});

describe('VAT — the concession is what the customer does not transfer', () => {
  it('grosses a taxable line concession up to the amount that leaves the invoice', () => {
    const measured = margin({
      lines: [catalogLine('a', NET_8791, true)],
      overrides: [lineOverride('ov', 'a', NET_8791, NET_8791 - 100_000n)],
    });

    /* ฿1,000 off a taxable line is ฿1,070 the customer does not pay. */
    expect(measured.concessionThbMinor).toBe(107_000n);
  });

  /**
   * ⭐ An exempt line concedes the promise **and** the tax it is not carrying.
   *
   * Plan 13's documented default is that every line and every service charge is taxable, so a
   * line that departs from it is conceding the VAT on its list price — and it concedes that on
   * top of any promise made on the line itself. ฿1,000 off is ฿1,000 (the line carries no tax
   * to gross up with), plus ฿615.37 of VAT on the ฿8,791.00 the line lists at.
   *
   * The direction is what matters and it used to run the wrong way. `grossUp` reads
   * `is_vat_applicable` at measurement time, so flipping a line to exempt — one request, worth
   * ฿897.68 to the customer on the red team's fixture — made the *measured* concession
   * ฿70 **smaller**. The largest one-click money move on the screen moved the ceiling
   * comparison in the customer's favour and the company's against.
   */
  it('counts the tax an exempt line is not charging, on top of the promise', () => {
    const measured = margin({
      lines: [catalogLine('a', NET_8791, false)],
      overrides: [lineOverride('ov', 'a', NET_8791, NET_8791 - 100_000n)],
    });

    expect(measured.concessionThbMinor).toBe(100_000n + 61_537n);
    expect(measured.sources.map((source) => source.kind).toSorted()).toStrictEqual([
      'line_total_override',
      'vat_exemption',
    ]);
  });

  it('makes exempting a line concede more than not exempting it', () => {
    const taxed = margin({ lines: [catalogLine('a', NET_8791, true)] });
    const exempt = margin({ lines: [catalogLine('a', NET_8791, false)] });

    expect(taxed.concessionThbMinor).toBe(0n);
    expect(exempt.concessionThbMinor).toBe(61_537n);
  });

  /* A credit line has no list price to be exempt *from*, and a negative source could be summed
   * to a smaller figure than the concession really is. */
  it('does not score a VAT exemption on a credit line', () => {
    const measured = margin({
      lines: [{ id: 'c', kind: 'freeform', isVatApplicable: false, computedTotalThbMinor: null, chargeTotalThbMinor: -100_000n }],
    });

    expect(measured.concessionThbMinor).toBe(100_000n);
    expect(measured.sources.map((source) => source.kind)).toStrictEqual(['negative_charge_line']);
  });

  it('does not gross up a grand-total override, which already includes VAT', () => {
    const grand = fromNet(NET_8791, VAT_7).grandMinor;
    const measured = margin({
      lines: [catalogLine('a', NET_8791)],
      overrides: [grandOverride('ov', grand, grand - 100_000n)],
    });

    expect(measured.concessionThbMinor).toBe(100_000n);
  });

  it('measures a zero-rated document in net terms, because there is no VAT to lose', () => {
    const measured = margin({
      vat: VAT_NONE,
      lines: [catalogLine('a', NET_8791, true)],
      overrides: [lineOverride('ov', 'a', NET_8791, NET_8791 - 100_000n)],
    });

    expect(measured.concessionThbMinor).toBe(100_000n);
  });
});

describe('the two anchors do not count the same baht twice', () => {
  /**
   * `quote_overrides.computed_thb_minor` on a `grand_total` row is the figure the document
   * showed **immediately before that override**, which is after the line overrides. So the
   * grand-total delta is the incremental document-level reduction and the two add.
   *
   * The cross-check is the identity that has to hold when nothing was overridden upwards:
   * the sum of the sources equals what the customer stops paying between the fully-computed
   * document and the final one.
   */
  it('adds a line discount and a document discount, and foots against the two totals', () => {
    const lines = [catalogLine('a', NET_18432), catalogLine('b', NET_8791)];

    const lineDiscountNet = 100_000n;
    const afterLines = fromNet(NET_18432 - lineDiscountNet + NET_8791, VAT_7).grandMinor;
    const documentDiscount = 50_000n;

    const measured = margin({
      lines,
      overrides: [
        lineOverride('ov-line', 'a', NET_18432, NET_18432 - lineDiscountNet),
        grandOverride('ov-doc', afterLines, afterLines - documentDiscount),
      ],
    });

    const baselineGrand = fromNet(NET_18432 + NET_8791, VAT_7).grandMinor;
    const finalGrand = afterLines - documentDiscount;

    expect(measured.concessionThbMinor).toBe(baselineGrand - finalGrand);
    expect(measured.sources.map((source) => source.kind)).toEqual([
      'line_total_override',
      'grand_total_override',
    ]);
  });
});

describe('an override whose line is not live', () => {
  /**
   * `quote_lines_guard_write()` refuses to remove a line while a live `line_total` override
   * hangs off it, so this cannot happen. If it does, the honest answer is an alarm and not a
   * smaller concession measured quietly — plan 7.9(จ)'s category for a baseline that stopped
   * matching.
   */
  it('raises an integrity alarm rather than measuring a smaller concession', () => {
    expect(() =>
      margin({
        lines: [catalogLine('a', NET_8791)],
        overrides: [lineOverride('ov', 'ghost', NET_8791, NET_8791 - 100_000n)],
      }),
    ).toThrow(ConcessionIntegrityError);
  });
});

describe('cashflow — delegated, not re-implemented', () => {
  const instalment = (
    seq: number,
    dueThbMinor: bigint,
    gatesEntryTo: PlannedInstalment['gatesEntryTo'],
  ): PlannedInstalment => ({
    seq,
    basis: 'fixed',
    percentBp: null,
    fixedThbMinor: dueThbMinor,
    gatesEntryTo,
    dueThbMinor,
  });

  const GRAND = fromNet(NET_18432, VAT_7).grandMinor;

  it('is zero when the whole total is gated behind production — plan 13’s floor', () => {
    const measured = measureCashflow(GRAND, [instalment(1, GRAND, 'production_confirmed')]);

    expect(measured.dimension).toBe('cashflow');
    expect(measured.concessionThbMinor).toBe(0n);
    expect(measured.sources).toEqual([]);
  });

  it('is the whole total when nothing gates production — the company extending credit', () => {
    const measured = measureCashflow(GRAND, [instalment(1, GRAND, null)]);

    expect(measured.concessionThbMinor).toBe(GRAND);
    expect(measured.sources[0]?.kind).toBe('gate_below_floor');
  });

  it('measures a 30/70 against the floor the plan documents', () => {
    const deposit = (GRAND * 3n) / 10n;
    const measured = measureCashflow(GRAND, [
      instalment(1, deposit, 'production_confirmed'),
      instalment(2, GRAND - deposit, null),
    ]);

    expect(measured.concessionThbMinor).toBe(GRAND - deposit);
  });
});
