import { describe, expect, it } from 'vitest';
import type { TaxRule } from '@wewin/core/vat';

import {
  applyOverrides,
  baselineMatches,
  type ChargeLine,
  type ComputedLine,
  type LiveOverride,
} from '../../src/quotes/overrides';
import { measureMargin } from '../../src/quotes/authority/concession';

/**
 * `applyOverrides` — the effective money, and the three layers that are never collapsed.
 *
 * Every figure below is checkable against the plan by hand, which is the point of using its
 * own worked example throughout:
 *
 *     ฿8,791.00 net          =  879,100 satang        (plan 4.3(ก), tests/pricing.test.ts:115)
 *     VAT at 700 bp          =  ฿615.37               (879,100 × 7% exactly)
 *     ฿9,406.37 grand        =  940,637 satang        (plan 7.5(จ)'s own arithmetic)
 *
 * `calcPrice` is not imported here and must never be. Plan 7.9(ก): the three layers exist so
 * that the 219 tests around pricing stay a safety net, and a test file that reached for
 * `calcPrice` to build its input would be re-coupling them from the other end.
 *
 * ⚠️ **The concession is `measureMargin`'s, over the same fixtures.** `applyOverrides` used to
 * return one of its own, computed as a subtraction, and the two disagreed in three ways (see the
 * header of `src/quotes/overrides.ts`). The subtraction is gone; `conceded()` below runs the one
 * remaining function over the identical rows, so this file's worked examples still pin the
 * figure a ceiling is compared against rather than a second opinion about it.
 */

const VAT: TaxRule = { rateBp: 700, treatment: 'standard' };

const line = (over: Partial<ComputedLine> = {}): ComputedLine => ({
  lineId: 'line-1',
  seq: 1,
  qty: 1,
  computedTotalThbMinor: 879_100n,
  isVatApplicable: true,
  ...over,
});

const charge = (over: Partial<ChargeLine> = {}): ChargeLine => ({
  lineId: 'charge-1',
  seq: 2,
  chargeTotalThbMinor: 200_000n,
  isVatApplicable: true,
  ...over,
});

const override = (over: Partial<LiveOverride> = {}): LiveOverride => ({
  id: 'ov-1',
  anchor: 'line_total',
  quoteLineId: 'line-1',
  computedThbMinor: 879_100n,
  overrideThbMinor: 850_000n,
  computedDays: null,
  overrideDays: null,
  ...over,
});

const apply = (input: {
  computed?: ComputedLine[];
  charges?: ChargeLine[];
  overrides?: LiveOverride[];
}) =>
  applyOverrides({
    computed: input.computed ?? [],
    charges: input.charges ?? [],
    overrides: input.overrides ?? [],
    vat: VAT,
    /* Every worked example in this file is Thai domestic — prices quoted before tax, the tax
     * added on top — so the basis is stated rather than defaulted and no expectation below
     * moves. The inclusive branch has its own file: `inclusive-basis.test.ts`. */
    basis: 'exclusive',
    computedLeadTimeDays: 30,
  });

/**
 * The **only** concession measurement, run over the same fixtures `apply` takes.
 *
 * A configured line's fixture becomes a `QuoteLineFacts` with `computedTotalThbMinor`; a charge
 * becomes one with `chargeTotalThbMinor`. That is precisely the shape `AuthorityRepository`
 * reads from `quote_lines`, so the arithmetic pinned here is the arithmetic the submit gate runs.
 */
const conceded = (input: {
  computed?: ComputedLine[];
  charges?: ChargeLine[];
  overrides?: LiveOverride[];
}): bigint =>
  measureMargin({
    vat: VAT,
    lines: [
      ...(input.computed ?? []).map((line) => ({
        id: line.lineId,
        kind: 'catalog' as const,
        isVatApplicable: line.isVatApplicable,
        computedTotalThbMinor: line.computedTotalThbMinor,
        chargeTotalThbMinor: null,
      })),
      ...(input.charges ?? []).map((line) => ({
        id: line.lineId,
        kind: 'freeform' as const,
        isVatApplicable: line.isVatApplicable,
        computedTotalThbMinor: null,
        chargeTotalThbMinor: line.chargeTotalThbMinor,
      })),
    ],
    overrides: (input.overrides ?? []).map((override) => ({
      id: override.id,
      anchor: override.anchor,
      quoteLineId: override.quoteLineId,
      computedThbMinor: override.computedThbMinor,
      overrideThbMinor: override.overrideThbMinor,
      reasonCode: 'price_match' as const,
    })),
  }).concessionThbMinor;

describe('with no overrides at all, the quote is the machine layer', () => {
  it('reproduces the plan’s own figures', () => {
    const quote = apply({ computed: [line()] });

    expect(quote.money.netThbMinor).toBe(879_100n);
    expect(quote.money.vatThbMinor).toBe(61_537n);
    expect(quote.money.grandTotalThbMinor).toBe(940_637n);
    expect(conceded({ computed: [line()] })).toBe(0n);
  });

  /*
   * Plan 13's smoke path has to run with no approval and no authority row, and the reason it
   * can is here: nothing has been conceded, so nothing is measured against a ceiling.
   */
  it('concedes nothing, which is what makes the smoke path possible', () => {
    expect(conceded({ computed: [line()] })).toBe(0n);
  });
});

describe('a line override replaces that line and nothing else', () => {
  const quote = apply({ computed: [line()], overrides: [override()] });

  it('uses the promise, not the computed figure', () => {
    expect(quote.lines[0]?.effectiveTotalThbMinor).toBe(850_000n);
    expect(quote.lines[0]?.baselineTotalThbMinor).toBe(879_100n);
  });

  it('re-derives the VAT from the promise', () => {
    expect(quote.money.netThbMinor).toBe(850_000n);
    expect(quote.money.vatThbMinor).toBe(59_500n);
    expect(quote.money.grandTotalThbMinor).toBe(909_500n);
  });

  /*
   * ⭐ ฿311.37 and not ฿291.00, and the difference is the whole of plan 4.4: the concession is
   * what the *customer pays* less, and what a customer pays is VAT-inclusive. A concession
   * measured on the net would understate every ceiling in the system by 7%.
   */
  it('measures the concession VAT-inclusive', () => {
    expect(conceded({ computed: [line()], overrides: [override()] })).toBe(31_137n);
    expect(quote.baseline.grandTotalThbMinor).toBe(940_637n);
  });
});

describe('a document override sets what the customer transfers', () => {
  it('divides the VAT back out of it rather than adding tax on top', () => {
    const quote = apply({
      computed: [line()],
      overrides: [
        override({ id: 'ov-g', anchor: 'grand_total', quoteLineId: null, overrideThbMinor: 900_000n }),
      ],
    });

    expect(quote.money.grandTotalThbMinor).toBe(900_000n);
    expect(quote.money.netThbMinor + quote.money.vatThbMinor).toBe(900_000n);
    /* ฿9,000.00 inclusive of 7% is ฿8,411.21 + ฿588.79. */
    expect(quote.money.netThbMinor).toBe(841_121n);
    expect(quote.money.vatThbMinor).toBe(58_879n);
  });

  /*
   * ⭐ The cascade runs one way. A line override then a document override is ONE concession,
   * and the two are not additive — adding them would count ฿311.37 twice and, under a ceiling,
   * would be the difference between an approval that was needed and one that was not.
   */
  it('does not double-count a line override underneath it', () => {
    /*
     * The document promise's baseline is the total *after* the line promise — ฿9,095.00 — so the
     * two telescope: ฿311.37 conceded on the line, then ฿950.00 more on the document, and the
     * pair sum to exactly what the customer stopped paying against the untouched ฿9,406.37.
     *
     * That used to be a comment in `concession.ts` and nothing enforced the write order; a red
     * team wrote the document promise first and made the same rows measure ฿1,070 too much, then
     * revoked the line promise from underneath and made them measure ฿1,070 too little.
     * `0018_quote_document_freeze.sql` refuses both writes, which is what makes this arithmetic
     * a property of the system rather than of the order the fixture happens to list rows in.
     */
    const both = {
      computed: [line()],
      overrides: [
        override(),
        override({
          id: 'ov-g',
          anchor: 'grand_total',
          quoteLineId: null,
          computedThbMinor: 909_500n,
          overrideThbMinor: 900_000n,
        }),
      ],
    };

    expect(apply(both).money.grandTotalThbMinor).toBe(900_000n);
    expect(conceded(both)).toBe(940_637n - 900_000n);
  });

  it('leaves the untaxed charges alone and moves only the taxable half', () => {
    const quote = apply({
      computed: [line()],
      charges: [charge({ isVatApplicable: false })],
      overrides: [
        override({
          id: 'ov-g',
          anchor: 'grand_total',
          quoteLineId: null,
          overrideThbMinor: 1_000_000n,
        }),
      ],
    });

    expect(quote.money.exemptNetThbMinor).toBe(200_000n);
    expect(quote.money.taxableNetThbMinor).toBe(747_664n);
    expect(quote.money.vatThbMinor).toBe(52_336n);
    expect(quote.money.grandTotalThbMinor).toBe(1_000_000n);
    expect(quote.grandOverrideBelowExemptCharges).toBe(false);
  });

  /*
   * Reachable and total: set a grand total, then add an exempt charge larger than it. The read
   * path must render this and say what is wrong; only the write path refuses it.
   */
  it('reports rather than throws when the exempt charges alone exceed the promise', () => {
    const quote = apply({
      computed: [line()],
      charges: [charge({ chargeTotalThbMinor: 1_200_000n, isVatApplicable: false })],
      overrides: [
        override({
          id: 'ov-g',
          anchor: 'grand_total',
          quoteLineId: null,
          overrideThbMinor: 1_000_000n,
        }),
      ],
    });

    expect(quote.grandOverrideBelowExemptCharges).toBe(true);
    expect(quote.money.grandTotalThbMinor).toBe(1_000_000n);
  });
});

describe('a negative charge is a concession with no override behind it — plan 7.13', () => {
  const quote = apply({
    computed: [line()],
    charges: [charge({ chargeTotalThbMinor: -100_000n })],
  });

  it('lowers what the customer pays', () => {
    expect(quote.money.grandTotalThbMinor).toBe(833_637n);
  });

  /* ฿1,000 off, VAT-inclusive, is ฿1,070 — and the baseline drops the credit rather than
   * scoring it, which is the only way `margin` ever sees a goodwill line at all. */
  it('is scored as one', () => {
    expect(quote.baseline.grandTotalThbMinor).toBe(940_637n);
    expect(conceded({ computed: [line()], charges: [charge({ chargeTotalThbMinor: -100_000n })] })).toBe(
      107_000n,
    );
  });

  it('and a positive charge is not', () => {
    expect(conceded({ computed: [line()], charges: [charge()] })).toBe(0n);
  });
});

describe('per-line taxability splits the base, and the tax is still taken once', () => {
  it('taxes the taxable subtotal and passes the rest through', () => {
    const quote = apply({
      computed: [line(), line({ lineId: 'line-2', seq: 2, isVatApplicable: false })],
    });

    expect(quote.money.taxableNetThbMinor).toBe(879_100n);
    expect(quote.money.exemptNetThbMinor).toBe(879_100n);
    expect(quote.money.vatThbMinor).toBe(61_537n);
    expect(quote.money.netThbMinor).toBe(1_758_200n);
    expect(quote.money.grandTotalThbMinor).toBe(1_819_737n);
  });

  /*
   * Plan 4.3(ข)'s rule, demonstrated rather than asserted: three lines of ฿8,791.00 taxed
   * together are not three lines taxed separately — per-line rounding would give 3 × ฿615.37 =
   * ฿1,846.11 against ฿1,846.11 here, so the case is chosen to differ: ฿0.07 lines.
   */
  it('rounds the tax once over the sum, not once per line', () => {
    const pennies = [1, 2, 3].map((seq) =>
      line({ lineId: `line-${String(seq)}`, seq, computedTotalThbMinor: 7n }),
    );

    /* 21 satang × 7% = 1.47 → 1 satang. Per line it would be 3 × round(0.49) = 0. */
    expect(apply({ computed: pennies }).money.vatThbMinor).toBe(1n);
  });
});

describe('the anchor that is not money', () => {
  it('falls back to the computed promise', () => {
    expect(apply({ computed: [line()] }).effectiveLeadTimeDays).toBe(30);
  });

  it('takes the override when there is one, and does not touch the money', () => {
    const quote = apply({
      computed: [line()],
      overrides: [
        override({
          id: 'ov-d',
          anchor: 'lead_time_days',
          quoteLineId: null,
          computedThbMinor: null,
          overrideThbMinor: null,
          computedDays: 30,
          overrideDays: 45,
        }),
      ],
    });

    expect(quote.effectiveLeadTimeDays).toBe(45);
    expect(quote.money.grandTotalThbMinor).toBe(940_637n);
    expect(conceded({ computed: [line()] })).toBe(0n);
  });
});

describe('a quote priced above its baseline concedes nothing', () => {
  /* There is no such thing as negative authority: a surcharge must not buy headroom under the
   * ceiling for the next real discount. */
  it('clamps at zero rather than banking the difference', () => {
    const raised = { computed: [line()], overrides: [override({ overrideThbMinor: 1_200_000n })] };
    const quote = apply(raised);

    expect(quote.money.grandTotalThbMinor).toBeGreaterThan(quote.baseline.grandTotalThbMinor);
    expect(conceded(raised)).toBe(0n);
  });

  /*
   * ⭐ And the reason it is a sum of reductions rather than a subtraction: netting is the attack.
   * Raise line A by ฿10,000 as a "rush charge", drop line B by ฿10,000, and a document-level
   * subtraction sees a quote that concedes nothing — while the ฿10,700 promise on B is real,
   * unreviewed, and the one the customer will hold the company to.
   */
  it('does not let an uplift on one line pay for a discount on another', () => {
    const netted = {
      computed: [line(), line({ lineId: 'line-2', seq: 2 })],
      overrides: [
        override({ id: 'ov-up', quoteLineId: 'line-1', overrideThbMinor: 879_100n + 1_000_000n }),
        override({
          id: 'ov-down',
          quoteLineId: 'line-2',
          overrideThbMinor: 879_100n - 1_000_000n < 0n ? 0n : 879_100n - 1_000_000n,
        }),
      ],
    };

    /* Line B is dropped to ฿0.00 from ฿8,791.00: ฿9,406.37 VAT-inclusive, conceded. */
    expect(conceded(netted)).toBe(940_637n);
  });
});

describe('baselineMatches', () => {
  it('is equality, and says nothing about what a mismatch means', () => {
    expect(baselineMatches(override(), 879_100n)).toBe(true);
    expect(baselineMatches(override(), 2_000_000n)).toBe(false);
  });
});
