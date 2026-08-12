import { describe, expect, it } from 'vitest';

import {
  configuredRates,
  type FxConfiguredDestination,
  type FxObservation,
} from '../../src/fx/configured-rates';

/**
 * ⭐ The figures the organisation card prints — and, mostly, the figures it must NOT print.
 *
 * Two properties are load-bearing here and everything else is detail:
 *
 *   1. **The number is baht per unit, derived and spread-adjusted — never the provider's raw
 *      USD-based figure.** `rates['SGD'] = 1.35` and "26.50 baht per Singapore dollar" differ by a
 *      reciprocal, a cross-rate and a spread. A staff member checking against a search engine sees
 *      the second; a card printing the first is misleading somebody who is doing exactly the right
 *      thing. The arithmetic is asserted against hand-computed digits below rather than against
 *      whatever the code produces.
 *   2. **A destination with a manual override gets NO derived mid-market figure.** THE RULE in
 *      `packages/core/src/fx.ts` says the spread is not applied on top of an override, so there is
 *      no mid-market rate in play for such a destination — but one is trivially computable from
 *      the same observation, and computing it would put a plausible, correctly-derived, entirely
 *      inapplicable number on a settings card beside the real one.
 *
 * No database and no clock: this is a function of two arguments.
 */

/** Baht is 36.5 per USD and SGD is 1.35 per USD, so the cross-rate is 36.5 ÷ 1.35 = 27.037037… */
const OBSERVATION: FxObservation = {
  base: 'USD',
  rates: { THB: 36.5, SGD: 1.35, USD: 1, VND: 25_000, EUR: 0.92 },
};

const destination = (
  overrides: Partial<FxConfiguredDestination> = {},
): FxConfiguredDestination => ({
  code: 'SG',
  nameTh: 'สิงคโปร์',
  fxCurrency: 'SGD',
  fxSpreadBp: 0,
  fxManualRate: null,
  isActive: true,
  ...overrides,
});

describe('configuredRates picks the rows that matter', () => {
  /**
   * ⭐ The whole reason this is driven from `tax_countries` rather than from the provider's
   * keyset. The observation carries five currencies and would carry ~170 in production; one
   * destination is configured, so one row comes out.
   */
  it('lists one row per configured destination, not one per currency the feed carries', () => {
    const rows = configuredRates([destination()], OBSERVATION);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.currency).toBe('SGD');
  });

  /**
   * A destination quoted in baht has no conversion at all. A row of blanks under a heading about
   * exchange rates invites a reader to think something is missing, so it is dropped rather than
   * listed empty.
   */
  it('drops a destination with no currency configured', () => {
    const rows = configuredRates(
      [destination({ code: 'TH', nameTh: 'ไทย', fxCurrency: null })],
      OBSERVATION,
    );

    expect(rows).toStrictEqual([]);
  });

  /**
   * ⚠️ A withdrawn destination is KEPT. `is_active` governs which destinations a new order may
   * name, never whether an order that already names one resolves — `TaxCountryRepository.byCode`
   * has no `is_active` filter. Its rate can still be pinned onto a document, so hiding it here
   * would hide a live number.
   */
  it('keeps a withdrawn destination and marks it, because its rate can still be pinned', () => {
    const rows = configuredRates([destination({ isActive: false })], OBSERVATION);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(false);
    expect(rows[0]?.effectiveThbPerUnit).not.toBeNull();
  });

  /** The caller's order is the caller's — `sort_order` then code, as the repository returns them. */
  it('preserves the order it was given', () => {
    const rows = configuredRates(
      [
        destination({ code: 'SG', fxCurrency: 'SGD' }),
        destination({ code: 'VN', nameTh: 'เวียดนาม', fxCurrency: 'VND' }),
      ],
      OBSERVATION,
    );

    expect(rows.map((row) => row.countryCode)).toStrictEqual(['SG', 'VN']);
  });
});

describe('the figure is baht per unit, and the spread is in it', () => {
  /**
   * ⭐⭐ THE ARITHMETIC, against digits computed by hand rather than by the code under test.
   *
   * 36.5 ÷ 1.35 = 27.037037037… so at six decimal places the mid is `27.037037`. The provider's
   * own figure for SGD is `1.35`, which is 20× smaller and points the other way; a test asserting
   * only "it is a string" would pass on either.
   */
  it('derives the cross-rate through the provider base with no spread set', () => {
    const [row] = configuredRates([destination({ fxSpreadBp: 0 })], OBSERVATION);

    expect(row?.effectiveThbPerUnit).toBe('27.037037');
    expect(row?.source).toBe('mid_market');
    expect(row?.spreadApplied).toBe(true);
  });

  /**
   * ⭐ 2% marks the RATE down, it does not mark the amount up — `packages/core/src/fx.ts` spends a
   * section on why. 27.037037… × 0.98 = 26.496296…, so `26.496296` at six places.
   *
   * The pre-spread figure travels beside it, because a reader checking what the spread did needs
   * both and neither is derivable from the other without knowing the spread was applied at all.
   */
  it('marks the rate down by the spread and reports the pre-spread figure beside it', () => {
    const [row] = configuredRates([destination({ fxSpreadBp: 200 })], OBSERVATION);

    expect(row?.effectiveThbPerUnit).toBe('26.496296');
    expect(row?.midThbPerUnit).toBe('27.037037');
    expect(row?.spreadBp).toBe(200);
    expect(row?.spreadApplied).toBe(true);
  });

  /**
   * ⚠️ The provider's raw pair travels verbatim and unreduced, and it is nested rather than flat.
   * `1.35` is what the feed holds for Singapore; it is on the payload because this card is about
   * the feed, and it is under `provider` so a template cannot print it where a baht rate belongs.
   */
  it('carries the provider pair verbatim, nested, never flattened beside the rate', () => {
    const [row] = configuredRates([destination({ fxSpreadBp: 200 })], OBSERVATION);

    expect(row?.provider).toStrictEqual({ unitPerBase: 1.35, thbPerBase: 36.5 });
    /* The useful figure and the raw figure are not the same number, and this is the assertion
       that would fail if somebody ever "simplified" one into the other. */
    expect(row?.effectiveThbPerUnit).not.toBe('1.35');
  });

  /** A currency with a very small baht value still comes out in the same direction and unit. */
  it('handles a currency far below one baht without inverting the direction', () => {
    const [row] = configuredRates(
      [destination({ code: 'VN', nameTh: 'เวียดนาม', fxCurrency: 'VND' })],
      OBSERVATION,
    );

    /* 36.5 ÷ 25000 = 0.00146 exactly. Baht per đồng, not đồng per baht. */
    expect(row?.effectiveThbPerUnit).toBe('0.001460');
  });
});

describe('a manual override, and the figure that is deliberately absent', () => {
  const MANUAL = destination({ fxSpreadBp: 200, fxManualRate: '27.0500000000' });

  /**
   * ⭐ THE RULE: an override is used exactly as typed, and the spread is not applied on top of it.
   * 27.05 with a 2% spread applied would be 26.509 — a figure that is never produced here.
   */
  it('uses the typed rate exactly and applies no spread to it', () => {
    const [row] = configuredRates([MANUAL], OBSERVATION);

    expect(row?.source).toBe('manual');
    expect(row?.effectiveThbPerUnit).toBe('27.050000');
    expect(row?.spreadApplied).toBe(false);
  });

  /**
   * ⭐⭐ THE ASSERTION THIS FILE EXISTS FOR.
   *
   * The observation is right there and the cross-rate is three lines of arithmetic away, so a
   * "helpful" implementation would fill `midThbPerUnit` in with `27.037037` — a correctly derived,
   * completely inapplicable number, sitting beside the real one on a settings card. The first
   * person to reconcile a quotation against the wrong one of the two would be right to blame the
   * screen. It is `null`, and it stays `null`.
   */
  it('reports NO derived mid-market figure, even though one is computable from the same row', () => {
    const [row] = configuredRates([MANUAL], OBSERVATION);

    expect(row?.midThbPerUnit).toBeNull();
    /* Said twice, because the failure mode is a specific value rather than a truthy one. */
    expect(row?.midThbPerUnit).not.toBe('27.037037');
  });

  /**
   * ⚠️ The *raw* provider figures are still reported, and that is the other half of the same
   * decision. "What did the sync bring in" is a fact about the feed and this card is about the
   * feed; the screen labels it as not applied here. The line is: raw observations yes, a derived
   * rate the system would never use, no.
   */
  it('still reports what the feed said for that currency, unreduced', () => {
    const [row] = configuredRates([MANUAL], OBSERVATION);

    expect(row?.provider).toStrictEqual({ unitPerBase: 1.35, thbPerBase: 36.5 });
  });

  /**
   * ⭐ An override needs no observation and must not be made to wait for one — the same
   * short-circuit `QuotationRateService` makes, for the same reason: a destination whose whole
   * point is that somebody typed the rate would otherwise be unreadable on the day the feed is
   * empty, which inverts the point of being able to type one.
   */
  it('resolves with no observation at all, because a typed rate needs none', () => {
    const [row] = configuredRates([MANUAL], undefined);

    expect(row?.effectiveThbPerUnit).toBe('27.050000');
    expect(row?.problem).toBeNull();
    expect(row?.provider).toBeNull();
  });

  /** The configured spread is reported as configured — the column keeps its value deliberately,
      so removing the override restores the old behaviour, and a screen showing `0` would say it
      had been cleared. `spreadApplied` is what says it is doing nothing. */
  it('reports the configured spread rather than the applied zero', () => {
    const [row] = configuredRates([MANUAL], OBSERVATION);

    expect(row?.spreadBp).toBe(200);
    expect(row?.spreadApplied).toBe(false);
  });

  /** A typo in the text box leaves the destination with no rate at all — core refuses both the
      typed value and the market fallback, and the screen has to say which. */
  it('reports an unreadable override as its own problem rather than falling back to market', () => {
    const [row] = configuredRates([destination({ fxManualRate: 'not a number' })], OBSERVATION);

    expect(row?.effectiveThbPerUnit).toBeNull();
    expect(row?.problem).toBe('manual_rate_unreadable');
  });
});

describe('the reasons there is no figure are kept apart', () => {
  /** An empty table is a sync problem and affects every destination at once. */
  it('reports no_snapshot for a mid-market destination with nothing stored', () => {
    const [row] = configuredRates([destination()], undefined);

    expect(row?.effectiveThbPerUnit).toBeNull();
    expect(row?.problem).toBe('no_snapshot');
    expect(row?.provider).toBeNull();
  });

  /** One country's problem — the others still quote. Worded separately for that reason. */
  it('reports destination_rate_missing when the feed does not carry that currency', () => {
    const [row] = configuredRates(
      [destination({ code: 'MY', nameTh: 'มาเลเซีย', fxCurrency: 'MYR' })],
      OBSERVATION,
    );

    expect(row?.problem).toBe('destination_rate_missing');
    expect(row?.provider).toBeNull();
  });

  /** Every destination's problem at once — a provider object with no baht in it. */
  it('reports baht_rate_missing when the feed carries no THB', () => {
    const [row] = configuredRates([destination()], { base: 'USD', rates: { SGD: 1.35 } });

    expect(row?.problem).toBe('baht_rate_missing');
    expect(row?.provider).toBeNull();
  });

  /**
   * ⚠️ `Record<string, number>` admits values no rate can be. A zero would divide to infinity and
   * a negative would invert the sign of every quotation; both are refused as missing rather than
   * printed as digits, which is what core does with them too.
   */
  it('treats an unusable provider figure as missing rather than printing it', () => {
    for (const bad of [0, -1.35, Number.NaN, Number.POSITIVE_INFINITY]) {
      const [row] = configuredRates([destination()], {
        base: 'USD',
        rates: { THB: 36.5, SGD: bad },
      });

      expect(row?.provider, `SGD = ${String(bad)} reached the payload`).toBeNull();
      expect(row?.effectiveThbPerUnit, `SGD = ${String(bad)} produced a rate`).toBeNull();
    }
  });
});
