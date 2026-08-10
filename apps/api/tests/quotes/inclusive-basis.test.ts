import { describe, expect, it } from 'vitest';
import type { TaxRule } from '@wewin/core/vat';

import {
  applyOverrides,
  type ChargeLine,
  type ComputedLine,
  type LiveOverride,
} from '../../src/quotes/overrides';

/**
 * ⭐ Task 10: `applyOverrides` takes a basis, and both `fromNet` sites honour it.
 *
 * ── What "inclusive" means arithmetically, in one sentence ───────────────────────
 *
 * The catalogue figures already contain the tax. So the taxable subtotal is the **gross**, the
 * grand total is that subtotal unchanged, and the VAT is divided back out of it — not added on
 * top. Exclusive is the other way round and is what every other test in this directory pins.
 *
 * ── Why a rate of 900 and not 700 ────────────────────────────────────────────────
 *
 * `DEFAULT_VAT_RULE` is 700 bp. A rate the rest of the suite already uses cannot distinguish
 * "the destination's rule arrived" from "the default was used and happened to match", and
 * `overrides.test.ts` is written entirely at 700. Every figure here is checkable by hand:
 *
 *     grand ฿30,000.00  =  3 000 000 satang   (two lines, ฿20,000.00 and ฿10,000.00)
 *     net              =  3 000 000 × 10 000 ÷ 10 900  =  2 752 294  (half away from zero)
 *     VAT              =  3 000 000 − 2 752 294        =    247 706
 *
 * ── Why this file is a unit test and not another `.pg.test.ts` ───────────────────
 *
 * `applyOverrides` is a function over numbers with no database, no Nest graph and no HTTP in
 * it. The end-to-end claim — that the *screen* and the *document* both reach this branch — is
 * `inclusive-quote-screen.pg.test.ts`'s, and it is a different claim: this file pins the
 * arithmetic, that one pins the wiring.
 */

const RULE: TaxRule = { rateBp: 900, treatment: 'standard' };

const line = (lineId: string, seq: number, totalMinor: bigint): ComputedLine => ({
  lineId,
  seq,
  qty: 1,
  computedTotalThbMinor: totalMinor,
  isVatApplicable: true,
});

const input = (basis: 'inclusive' | 'exclusive', over: {
  charges?: readonly ChargeLine[];
  overrides?: readonly LiveOverride[];
} = {}) => ({
  computed: [line('line-1', 1, 2_000_000n), line('line-2', 2, 1_000_000n)],
  charges: over.charges ?? [],
  overrides: over.overrides ?? [],
  vat: RULE,
  basis,
  computedLeadTimeDays: 30,
});

describe('inclusive basis', () => {
  it('treats the catalogue sum as the grand total and derives net from it', () => {
    const { money } = applyOverrides(input('inclusive'));

    /* The quoted gross *is* the catalogue sum. Nothing was added to it. */
    expect(money.grandTotalThbMinor).toBe(3_000_000n);
    expect(money.netThbMinor).toBe(2_752_294n);
    expect(money.vatThbMinor).toBe(247_706n);

    /* Backed **out**, not added on: `grand × rateBp ÷ (10 000 + rateBp)`. */
    expect(money.vatThbMinor).toBe((3_000_000n * 900n + 5_450n) / 10_900n);
    /* An invoice whose three numbers do not add up is one nobody can sign. */
    expect(money.netThbMinor + money.vatThbMinor).toBe(money.grandTotalThbMinor);
    expect(money.taxableNetThbMinor).toBe(money.netThbMinor);
    expect(money.exemptNetThbMinor).toBe(0n);
  });

  it('leaves exclusive exactly as it was', () => {
    const { money } = applyOverrides(input('exclusive'));

    expect(money.netThbMinor).toBe(3_000_000n);
    expect(money.vatThbMinor).toBe(270_000n);
    expect(money.grandTotalThbMinor).toBe(3_270_000n);
  });

  /**
   * ⭐ The assertion that catches the baseline site being left on `fromNet`.
   *
   * `baseline` is *"what this quote would say with nothing negotiated"*, and nothing here has
   * been negotiated — so it must equal the effective money to the satang. Left unbranched it
   * lands ~9% above, and the dashboard shows staff a "before negotiation" figure **higher than
   * what the customer is charged**, on every inclusive quote.
   *
   * No gate assertion can substitute for this one. `measureMargin`'s input is
   * `{ vat, lines, overrides }` and `AuthorityService.measureFor` never calls `applyOverrides`,
   * so the authority module cannot see this field at all; its only consumer is the display
   * field `baselineGrandTotalThbMinor` (`src/quotes/encode.ts:96`).
   */
  it('reports no phantom concession when nothing was negotiated', () => {
    const { money, baseline } = applyOverrides(input('inclusive'));

    expect(baseline.grandTotalThbMinor).toBe(money.grandTotalThbMinor);
    expect(baseline.netThbMinor).toBe(money.netThbMinor);
    expect(baseline.vatThbMinor).toBe(money.vatThbMinor);
  });

  /**
   * A VAT-exempt charge is outside the taxable subtotal on either basis, so it passes through
   * whole — and the taxable half alone is what the basis decides. ฿30,000 of taxed goods plus a
   * ฿5,000 untaxed survey is ฿35,000 the customer transfers, whichever way the tax was quoted.
   */
  it('leaves an exempt charge outside the division', () => {
    const survey: ChargeLine = {
      lineId: 'charge-1',
      seq: 3,
      chargeTotalThbMinor: 500_000n,
      isVatApplicable: false,
    };

    const { money } = applyOverrides(input('inclusive', { charges: [survey] }));

    expect(money.exemptNetThbMinor).toBe(500_000n);
    expect(money.taxableNetThbMinor).toBe(2_752_294n);
    expect(money.vatThbMinor).toBe(247_706n);
    expect(money.netThbMinor).toBe(3_252_294n);
    expect(money.grandTotalThbMinor).toBe(3_500_000n);
  });

  /**
   * ⭐ A `grand_total` override is gross on every destination, and is **not** re-divided.
   *
   * The figure is a human's, typed into a box labelled "the total the customer transfers".
   * `fromGrand` already divides the tax out of it, which is the same operation the inclusive
   * branch performs on the line subtotal — so applying the basis switch here would either
   * divide it twice or, on an exclusive destination, multiply a promise of ฿25,000 into a
   * demand for ฿26,750. The two bases agree on this figure, which is the property asserted.
   */
  it('composes a document promise unchanged, on either basis', () => {
    const promise: LiveOverride = {
      id: 'ov-1',
      anchor: 'grand_total',
      quoteLineId: null,
      computedThbMinor: 3_000_000n,
      overrideThbMinor: 2_500_000n,
      computedDays: null,
      overrideDays: null,
    };

    const inclusive = applyOverrides(input('inclusive', { overrides: [promise] })).money;
    const exclusive = applyOverrides(input('exclusive', { overrides: [promise] })).money;

    expect(inclusive.grandTotalThbMinor).toBe(2_500_000n);
    expect(inclusive.netThbMinor).toBe(2_293_578n);
    expect(inclusive.vatThbMinor).toBe(206_422n);
    expect(exclusive).toStrictEqual(inclusive);
  });
});
