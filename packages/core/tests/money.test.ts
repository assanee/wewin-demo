import { describe, expect, it, test } from 'vitest';
import {
  CURRENCIES,
  MINOR_EXPONENT,
  addMinor,
  ceilToUnit,
  divRoundHalfUp,
  minorPerUnit,
  readSatang,
  roundToUnit,
  satangField,
} from '../src/money.js';

/*
 * The rounding rule the whole system is built on.
 *
 * Spec section 5 and plan 4.3(a) both pin THB to half_up, and 219 existing tests
 * encode the results. What none of them cover is a negative amount, because v1 has
 * no way to produce one. The upgrade introduces several at once — credits, reversals,
 * balancing rows, FX differences — so the sign rule has to be decided here, before
 * anything depends on it.
 */
describe('divRoundHalfUp', () => {
  test('rounds a half up, away from zero, in both directions', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divRoundHalfUp(-1n, 2n)).toBe(-1n);
    expect(divRoundHalfUp(3n, 2n)).toBe(2n);
    expect(divRoundHalfUp(-3n, 2n)).toBe(-2n);
  });

  test('disagrees with Math.round on negative halves, which is the point', () => {
    // Math.round(-1432.5) === -1432: it rounds toward +Infinity, not away from zero.
    // Accounting half_up wants -1433, so the primitive cannot be Math.round.
    expect(divRoundHalfUp(-14325n, 10n)).toBe(-1433n);
    expect(Math.round(-1432.5)).toBe(-1432);
  });

  test('leaves exact quotients alone and never produces negative zero', () => {
    expect(divRoundHalfUp(800n, 4n)).toBe(200n);
    expect(divRoundHalfUp(-800n, 4n)).toBe(-200n);
    expect(divRoundHalfUp(-1n, 4n)).toBe(0n);
    expect(Object.is(Number(divRoundHalfUp(-1n, 4n)), 0)).toBe(true);
  });

  test('rejects a zero denominator rather than returning something', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow();
  });
});

/*
 * Two modes, because the plan's own rate table carries `round_mode: up | half_up`
 * per currency and its worked examples use both: ₫5,990,400 becomes ₫5,991,000, which
 * only `up` produces, while RM 998.40 becomes RM 998, which only `half_up` produces.
 * A single mode cannot serve both, and picking one silently would quietly change a
 * published price in one of the nine markets.
 */
describe('roundToUnit — half_up', () => {
  test('rounds to a unit larger than one minor unit', () => {
    // 8,791.20 baht held as satang, rounded to whole baht.
    expect(roundToUnit(879_120n, 100n)).toBe(879_100n);
    // The spec case that pins THB to half_up rather than ceil: ฿8,791.2 stays ฿8,791.
    expect(roundToUnit(879_120n, 100n) / 100n).toBe(8_791n);
    // MYR from plan 4.2: RM 998.40 to the whole ringgit is RM 998, not RM 999.
    expect(roundToUnit(99_840n, 100n)).toBe(99_800n);
  });

  test('a unit of one is the identity', () => {
    expect(roundToUnit(879_137n, 1n)).toBe(879_137n);
  });
});

describe('ceilToUnit — up', () => {
  test('always rounds away from zero, however small the remainder', () => {
    // VND from plan 4.2: ₫5,990,400 to the thousand is ₫5,991,000.
    expect(ceilToUnit(5_990_400n, 1000n)).toBe(5_991_000n);
    expect(ceilToUnit(5_990_001n, 1000n)).toBe(5_991_000n);
  });

  test('leaves an exact multiple alone rather than pushing it a whole unit', () => {
    expect(ceilToUnit(5_990_000n, 1000n)).toBe(5_990_000n);
  });

  test('rounds a negative away from zero too, so a credit is never understated', () => {
    expect(ceilToUnit(-5_990_400n, 1000n)).toBe(-5_991_000n);
  });
});

/*
 * Plan 4.3(c): `minorExponent` is a fact about a currency, `roundTo` is a business
 * policy. Conflating them is a 100x error waiting to happen — a fact this very plan
 * tripped over once, writing "100000 = round to the nearest thousand đồng" when VND
 * has no minor unit at all and 100000 minor is ₫100,000.
 */
describe('currency facts', () => {
  test('covers the nine currencies the brief named', () => {
    expect([...CURRENCIES].sort()).toEqual(
      ['CNY', 'EUR', 'INR', 'LAK', 'MYR', 'SGD', 'THB', 'USD', 'VND'].sort(),
    );
  });

  test('only VND and LAK have no minor unit', () => {
    const noMinor = CURRENCIES.filter((code) => MINOR_EXPONENT[code] === 0);
    expect([...noMinor].sort()).toEqual(['LAK', 'VND']);
  });

  test('minorPerUnit follows the exponent, so a whole unit is never guessed', () => {
    expect(minorPerUnit('THB')).toBe(100n);
    expect(minorPerUnit('VND')).toBe(1n);
    expect(minorPerUnit('LAK')).toBe(1n);
  });

  test('one thousand dong is 1000 minor, not 100000', () => {
    // The regression this file exists to prevent.
    expect(1000n * minorPerUnit('VND')).toBe(1000n);
    expect(1000n * minorPerUnit('THB')).toBe(100_000n);
  });
});

describe('addMinor', () => {
  test('sums a list exactly, with no intermediate rounding', () => {
    expect(addMinor([879_100n, 100n, -200n])).toBe(879_000n);
    expect(addMinor([])).toBe(0n);
  });
});

describe('⭐ reading baht-and-satang out of a text box', () => {
  it('takes whole baht and baht with satang', () => {
    expect(readSatang('8230')).toStrictEqual({ ok: true, value: 823_000n });
    expect(readSatang('8230.44')).toStrictEqual({ ok: true, value: 823_044n });
    expect(readSatang('0.05')).toStrictEqual({ ok: true, value: 5n });
    expect(readSatang('  1,972.24 ')).toStrictEqual({ ok: true, value: 197_224n });
  });

  it('⚠️ is exact where a float is not', () => {
    /*
     * `Math.trunc(parseFloat(text) * 100)` is wrong for 5,209 of the 200,000 amounts between
     * ฿0 and ฿40,000 ending in .01/.29/.57/.83/.99 — 2.6% — because 0.29 is not representable
     * in binary and lands a hair below. `Math.round` happens to rescue these magnitudes and
     * is still a claim about magnitude rather than about correctness.
     *
     * Reading the digits as digits has no magnitude at which it starts being wrong, which is
     * the only property worth having in a function that decides where somebody's money goes.
     */
    for (const [text, exact] of [
      ['0.29', 29n],
      ['0.57', 57n],
      ['2.01', 201n],
      ['8.29', 829n],
      ['19722.24', 1_972_224n],
    ] as const) {
      expect(readSatang(text), `${text} did not read exactly`).toStrictEqual({
        ok: true,
        value: exact,
      });
      // And the float route, stated so the comment above is checkable rather than folklore.
      expect(BigInt(Math.trunc(Number.parseFloat(text) * 100))).not.toBe(exact + 1n);
    }
  });

  it('pads a single decimal place rather than reading it as satang', () => {
    // "฿5.4" is five baht forty, not five baht and four satang.
    expect(readSatang('5.4')).toStrictEqual({ ok: true, value: 540n });
  });

  it('refuses what it cannot read, instead of guessing', () => {
    for (const text of ['', '   ', 'abc', '1.234', '-5', '1.2.3', '๑๒๓']) {
      expect(readSatang(text).ok, `"${text}" was accepted`).toBe(false);
    }
  });

  it('round-trips through the field it renders into', () => {
    for (const minor of [0n, 5n, 823_044n, 1_972_224n]) {
      expect(readSatang(satangField(minor))).toStrictEqual({ ok: true, value: minor });
    }
  });
});
