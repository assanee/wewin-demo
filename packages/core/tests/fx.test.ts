import { describe, expect, test } from 'vitest';

import { divRoundHalfUp } from '../src/money.js';
import {
  FX_SPREAD_BP_LIMIT,
  convertFromBaht,
  quoteFromBaht,
  readRatio,
  resolveFxRate,
  thbPerUnitText,
  type FxCountrySettings,
  type FxSnapshot,
} from '../src/fx.js';

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * The spread, the override, and the one rounding
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every figure below is stated in the currency a person would say out loud in the comment
 * and asserted in minor units, because minor units are what the function returns and a test
 * that asserted "1020.41" would be testing a formatter that does not exist yet.
 *
 * The rates are the brief's own worked example — a mid-market 36.5 THB/USD — plus a
 * plausible SGD leg so the cross-rate through USD is exercised on the same numbers.
 */

/** One `fx_rates` row, USD-base, as the free Open Exchange Rates plan delivers it. */
const OXR: FxSnapshot = {
  base: 'USD',
  rates: { USD: 1, THB: 36.5, SGD: 1.35, VND: 25_000 },
};

const midMarket = (spreadBp: number): FxCountrySettings => ({
  spreadBp,
  manualRateThbPerUnit: null,
});

/** ฿36,500 — the brief's product. */
const PRICE = 3_650_000n;

const rateOf = (currency: 'USD' | 'SGD' | 'VND', settings: FxCountrySettings) => {
  const resolved = resolveFxRate(currency, settings, OXR);
  if (!resolved.ok) throw new Error(`expected a rate, got ${resolved.reason}`);
  return resolved.rate;
};

describe('the mid-market rate, marked down by the spread', () => {
  test('a zero spread is the mid-market rate itself — ฿36,500 at 36.5 is USD 1,000.00', () => {
    expect(convertFromBaht(PRICE, rateOf('USD', midMarket(0)))).toBe(100_000n);
  });

  /**
   * ⭐ The worked example, and the one figure this whole module exists to produce.
   *
   * Mid 36.5 THB/USD, 2% spread → an effective 35.77, and ฿36,500 ÷ 35.77 = USD 1,020.41.
   *
   * Two other answers are wrong and this pins against both:
   *
   *   USD 1,000.00 — the spread not applied at all. That is the mutation named in the brief
   *                  (`BP - BigInt(spreadBp)` → `BP`), and it reddens here with a figure.
   *   USD 1,020.00 — the spread applied to the *amount* instead of the rate. Converted back
   *                  at the very rate it assumed, that lands ฿36,485.40: ฿14.60 short, which
   *                  is `฿36,500 × s²` and is exactly the gap the setting exists to close.
   *                  See the header for why the rate side is the right side.
   */
  test('a 2% spread on ฿36,500 quotes USD 1,020.41 — not 1,020.00 and not 1,000.00', () => {
    const usd = convertFromBaht(PRICE, rateOf('USD', midMarket(200)));

    expect(usd).toBe(102_041n);
    expect(usd).not.toBe(100_000n);
    expect(usd).not.toBe(102_000n);
  });

  test('a spread that is not a whole percent — 1.75% quotes USD 1,017.81', () => {
    // Effective 36.5 × 0.9825 = 35.86125, and ฿36,500 ÷ 35.86125 = 1,017.8117…
    expect(convertFromBaht(PRICE, rateOf('USD', midMarket(175)))).toBe(101_781n);
  });

  test('one basis point still moves the figure — a spread is not rounded to whole percent', () => {
    expect(convertFromBaht(PRICE, rateOf('USD', midMarket(1)))).toBe(100_010n);
  });

  test('the resolved rate reports the spread it applied and the mid it started from', () => {
    const rate = rateOf('USD', midMarket(200));

    expect(rate.source).toBe('mid_market');
    expect(rate.spreadBp).toBe(200);
    expect(thbPerUnitText(rate, 2)).toBe('35.77');
    expect(rate.midThbPerUnit).not.toBeNull();
    // Reconstructible from the stored `rates` object and nothing else — the two figures used.
    expect(rate.provider).toStrictEqual({ base: 'USD', thbPerBase: 36.5, unitPerBase: 1 });
  });
});

describe('a cross-rate exists only through the base, and the derivation is visible', () => {
  /*
   * The free plan is USD-base, so THB→SGD is (THB per USD) ÷ (SGD per USD) = 36.5 ÷ 1.35 =
   * 27.037037… baht per SGD. ฿36,500 is USD 1,000 is SGD 1,350 — the base cancels exactly,
   * which is why this one lands on a round figure and is worth pinning.
   */
  test('฿36,500 through USD is SGD 1,350.00 at mid-market', () => {
    expect(convertFromBaht(PRICE, rateOf('SGD', midMarket(0)))).toBe(135_000n);
  });

  test('the same cross-rate at a 2% spread is SGD 1,377.55', () => {
    expect(convertFromBaht(PRICE, rateOf('SGD', midMarket(200)))).toBe(137_755n);
  });

  test('the two provider figures the cross-rate came from are handed back verbatim', () => {
    expect(rateOf('SGD', midMarket(200)).provider).toStrictEqual({
      base: 'USD',
      thbPerBase: 36.5,
      unitPerBase: 1.35,
    });
  });

  test('a currency with no minor unit converts without a special case — ฿36,500 is ₫25,000,000', () => {
    // VND's minor exponent is 0, so the returned minor units *are* đồng.
    expect(convertFromBaht(PRICE, rateOf('VND', midMarket(0)))).toBe(25_000_000n);
    expect(convertFromBaht(PRICE, rateOf('VND', midMarket(200)))).toBe(25_510_204n);
  });
});

describe('⭐ an override is that exact rate — the percentage is not applied on top', () => {
  const override = (rate: string, spreadBp: number): FxCountrySettings => ({
    spreadBp,
    manualRateThbPerUnit: rate,
  });

  test('an override alone — ฿36,500 at a bank-quoted 35.90 is USD 1,016.71', () => {
    const resolved = resolveFxRate('USD', override('35.90', 0), OXR);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.rate.source).toBe('manual');
    expect(convertFromBaht(PRICE, resolved.rate)).toBe(101_671n);
  });

  /**
   * ⭐ THE RULE, pinned. A row carrying both settings converts exactly as though the spread
   * were not there — same figure, to the satang, as the override alone above.
   *
   * The other rule would give USD 1,037.46 (฿36,500 ÷ (35.90 × 0.98)), which is a real,
   * plausible, ฿750-different answer — so this assertion is load-bearing rather than a
   * restatement: flipping the branch in `resolveFxRate` reddens it with a figure.
   *
   * The argument is in the header: a bank's quoted rate already carries the bank's margin,
   * and the percentage exists to estimate a margin that is *not* yet in the number.
   */
  test('an override with a 2% spread also set quotes the same USD 1,016.71', () => {
    const both = resolveFxRate('USD', override('35.90', 200), OXR);
    expect(both.ok).toBe(true);
    if (!both.ok) return;

    expect(convertFromBaht(PRICE, both.rate)).toBe(101_671n);
    expect(convertFromBaht(PRICE, both.rate)).not.toBe(103_746n);
  });

  test('the resolved rate says the spread applied was zero, whatever the row still holds', () => {
    const both = resolveFxRate('USD', override('35.90', 200), OXR);
    if (!both.ok) throw new Error(both.reason);

    expect(both.rate.spreadBp).toBe(0);
    expect(both.rate.source).toBe('manual');
    // No mid-market figures at all: an override needs no provider observation to be usable.
    expect(both.rate.midThbPerUnit).toBeNull();
    expect(both.rate.provider).toBeNull();
  });

  test('an override works with no provider rate for that currency at all', () => {
    const noSgd: FxSnapshot = { base: 'USD', rates: { USD: 1, THB: 36.5 } };
    const resolved = resolveFxRate('SGD', override('27.05', 0), noSgd);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // ฿36,500 ÷ 27.05 = 1,349.3530…
    expect(convertFromBaht(PRICE, resolved.rate)).toBe(134_935n);
  });

  test('an unreadable override is reported, never silently treated as no override', () => {
    for (const bad of ['', '  ', 'abc', '-1', '0', '1.2.3', '1,000']) {
      const resolved = resolveFxRate('USD', override(bad, 0), OXR);
      expect(resolved.ok, `override ${JSON.stringify(bad)}`).toBe(false);
      if (!resolved.ok) expect(resolved.reason).toBe('manual_rate_unreadable');
    }
  });
});

describe('⭐ rounding happens once, at the end, and nowhere else', () => {
  /**
   * The boundary the brief asks to be stated and pinned.
   *
   * ฿100,000 to SGD at mid-market. The exact chain — provider decimals, cross-rate and
   * minor-unit exponents all carried as one bigint ratio, `divRoundHalfUp` once at the end —
   * gives SGD 3,698.63. Rounding the *rate* first to four places (27.0370, a perfectly
   * ordinary thing for an FX system to print and then divide by) gives 3,698.64.
   *
   * The second answer is computed here rather than asserted from a comment, so this test
   * proves the two paths differ instead of claiming it. This is `vat.ts:61-74`'s rule one
   * figure further along the chain: two roundings produce numbers that do not reconcile.
   */
  test('rounding the rate first moves the answer by a cent, so the rate is never rounded', () => {
    const rate = rateOf('SGD', midMarket(0));
    const hundredThousandBaht = 10_000_000n;

    // The rate as a four-decimal figure: 36 500 ⁄ 1 350 = 27.037037… → 27.0370.
    const rateTo4dp = divRoundHalfUp(36_500n * 10_000n, 1_350n);
    expect(rateTo4dp).toBe(270_370n);

    const twoRoundings = divRoundHalfUp(
      hundredThousandBaht * 100n * 10_000n,
      100n * rateTo4dp,
    );

    expect(convertFromBaht(hundredThousandBaht, rate)).toBe(369_863n);
    expect(twoRoundings).toBe(369_864n);
  });

  /**
   * The tie-break itself: half away from zero, not `Math.round`'s half toward +Infinity.
   *
   * A 2 THB/USD rate is synthetic, and deliberately so — it is the only way to land the
   * quotient exactly on a half, which is the only input that can distinguish the two rules.
   * ฿123.45 ÷ 2 is USD 61.725 exactly.
   */
  test('an exact half goes away from zero, on a credit as well as a charge', () => {
    const two: FxSnapshot = { base: 'USD', rates: { USD: 1, THB: 2 } };
    const resolved = resolveFxRate('USD', midMarket(0), two);
    if (!resolved.ok) throw new Error(resolved.reason);

    expect(convertFromBaht(12_345n, resolved.rate)).toBe(6_173n);
    // `Math.round(-6172.5)` is -6172. Credits and refunds are why money.ts fixed this once.
    expect(convertFromBaht(-12_345n, resolved.rate)).toBe(-6_173n);
  });

  test('zero baht is zero, whatever the rate and spread', () => {
    expect(convertFromBaht(0n, rateOf('USD', midMarket(200)))).toBe(0n);
    expect(convertFromBaht(0n, rateOf('VND', midMarket(0)))).toBe(0n);
  });
});

describe('a rate is read as digits, never as a float', () => {
  test('a decimal is the digits the provider printed', () => {
    expect(readRatio(36.5)).toStrictEqual({ n: 365n, d: 10n });
    expect(readRatio('35.90')).toStrictEqual({ n: 3590n, d: 100n });
    expect(readRatio(1)).toStrictEqual({ n: 1n, d: 1n });
  });

  /*
   * 0.07 is not representable in binary; the double sitting behind it is
   * 0.070000000000000006661338147750939242541790008544921875. Reading the digits gives
   * 7⁄100 and reading the double would not — the same 2.6%-wrong trap `readSatang` names.
   */
  test('a decimal that binary cannot hold is still exactly seven hundredths', () => {
    expect(readRatio(0.07)).toStrictEqual({ n: 7n, d: 100n });
  });

  test('exponent notation, which is how JavaScript prints a very small or very large rate', () => {
    expect(readRatio(1e-7)).toStrictEqual({ n: 1n, d: 10_000_000n });
    expect(readRatio(1.5e-7)).toStrictEqual({ n: 15n, d: 100_000_000n });
    expect(readRatio(1e21)).toStrictEqual({ n: 10n ** 21n, d: 1n });
  });

  test('anything that is not a positive decimal is null, never a guess', () => {
    for (const bad of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readRatio(bad), `readRatio(${String(bad)})`).toBeNull();
    }
    for (const bad of ['', 'abc', '-1', '+1', '1 000', '1,000', '.5', '1.']) {
      expect(readRatio(bad), `readRatio(${JSON.stringify(bad)})`).toBeNull();
    }
  });
});

describe('what cannot be converted is reported, not guessed at', () => {
  test('baht to baht is refused — a spread on it would be a silent domestic mark-up', () => {
    const resolved = resolveFxRate('THB', midMarket(200), OXR);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('same_currency');
  });

  test('a missing destination rate and a missing baht rate are different answers', () => {
    const noSgd = resolveFxRate('SGD', midMarket(0), { base: 'USD', rates: { USD: 1, THB: 36.5 } });
    expect(noSgd.ok).toBe(false);
    if (!noSgd.ok) expect(noSgd.reason).toBe('destination_rate_missing');

    const noThb = resolveFxRate('SGD', midMarket(0), { base: 'USD', rates: { USD: 1, SGD: 1.35 } });
    expect(noThb.ok).toBe(false);
    if (!noThb.ok) expect(noThb.reason).toBe('baht_rate_missing');
  });

  test('a present-but-unusable provider figure counts as missing', () => {
    for (const rates of [{ THB: 0, SGD: 1.35 }, { THB: 36.5, SGD: 0 }, { THB: 36.5, SGD: -1 }]) {
      expect(resolveFxRate('SGD', midMarket(0), { base: 'USD', rates }).ok).toBe(false);
    }
  });

  /*
   * The same split `vat.ts`'s `assertRate` makes: a malformed *setting* is a caller bug and
   * throws, a missing *observation* is a state of the world and comes back as a value. A
   * 100% spread would make the effective rate zero and the division undefined, which is why
   * this ceiling lives in core at all — the business ceiling is the database's 2,000 bp.
   */
  test('a spread outside [0, 100%) throws rather than dividing by zero', () => {
    for (const bad of [-1, 0.5, FX_SPREAD_BP_LIMIT, FX_SPREAD_BP_LIMIT + 1, Number.NaN]) {
      expect(() => resolveFxRate('USD', midMarket(bad), OXR), `spreadBp ${String(bad)}`).toThrow(
        RangeError,
      );
    }
  });
});

describe('thbPerUnitText — a rendering, and the module says so', () => {
  test('renders the effective rate at six places by default', () => {
    expect(thbPerUnitText(rateOf('SGD', midMarket(0)))).toBe('27.037037');
    expect(thbPerUnitText(rateOf('USD', midMarket(200)))).toBe('35.770000');
  });

  /*
   * The point of the warning on that function: dividing by what it printed is not what
   * `convertFromBaht` did, and on ฿100,000 to SGD the two disagree by a cent — see the
   * rounding-boundary test above for the same fact from the other side.
   */
  test('what it prints is not what the conversion divided by', () => {
    const rate = rateOf('SGD', midMarket(0));
    const printed = thbPerUnitText(rate, 4);

    expect(printed).toBe('27.0370');
    expect(rate.thbPerUnit).toStrictEqual({ n: 365_000_000n, d: 13_500_000n });
  });
});

describe('quoteFromBaht — the two steps in one call', () => {
  test('carries the figure and everything it was derived from', () => {
    const quoted = quoteFromBaht(PRICE, 'USD', midMarket(200), OXR);
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;

    expect(quoted.amount.currency).toBe('USD');
    expect(quoted.amount.minor).toBe(102_041n);
    expect(quoted.amount.rate.spreadBp).toBe(200);
  });

  test('passes a refusal straight through', () => {
    const quoted = quoteFromBaht(PRICE, 'THB', midMarket(0), OXR);
    expect(quoted.ok).toBe(false);
    if (!quoted.ok) expect(quoted.reason).toBe('same_currency');
  });
});
