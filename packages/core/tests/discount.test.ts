import { describe, expect, it } from 'vitest';

import {
  discountBp,
  discountMinor,
  FULL_DISCOUNT_BP,
  normalisePercentEntry,
  priceAfterPercentDiscount,
  type DiscountRule,
  type PercentEntry,
  type PercentEntryRefusal,
  type Ruled,
} from '../src/discount.js';

/**
 * The convention that used to be two comments disagreeing — see `src/discount.ts`'s header.
 *
 * ฿8,791.00 is the baseline every number below is taken against, because it is the figure
 * `apps/api/tests/quotes/entry.test.ts` and `apps/dashboard/.../override-entry.test.ts` both
 * already use. The point of repeating it here is that all three files now agree on what `-5%`
 * against it produces, and the reason they cannot stop agreeing is that they call this module.
 */
const COMPUTED = 879_100n;

const value = <T>(result: DiscountRule<T>): T => {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.refusal}`);
  return result.value;
};

describe('a discount box only discounts', () => {
  it('reads a percentage the same whether or not a salesperson typed the minus', () => {
    expect(value(discountBp('unsigned', 500n))).toBe(500n);
    expect(value(discountBp('negative', 500n))).toBe(500n);
  });

  it('reads a money discount the same whether or not a salesperson typed the minus', () => {
    expect(value(discountMinor('unsigned', 29_100n))).toBe(29_100n);
    expect(value(discountMinor('negative', 29_100n))).toBe(29_100n);
  });

  /*
   * ⭐ The refusal that makes the convention a decision rather than an accident, and the one the
   * dashboard used to answer the other way: `-5` there meant "add five percent".
   */
  it('refuses an explicit surcharge in either discount box', () => {
    expect(discountBp('positive', 500n)).toEqual({ ok: false, refusal: 'surcharge' });
    expect(discountMinor('positive', 29_100n)).toEqual({ ok: false, refusal: 'surcharge' });
  });

  it('refuses more than the whole price, because a negative total is a refund', () => {
    expect(value(discountBp('negative', FULL_DISCOUNT_BP))).toBe(FULL_DISCOUNT_BP);
    expect(discountBp('negative', FULL_DISCOUNT_BP + 1n)).toEqual({ ok: false, refusal: 'above_full' });
  });

  it('puts no ceiling on a money discount, which is compared against a baseline it has not got', () => {
    expect(value(discountMinor('negative', 900_000n))).toBe(900_000n);
  });
});

describe('the price a percentage produces', () => {
  it('lands on the whole baht, because every computed line total already does', () => {
    /* 5% of ฿8,791.00 is ฿439.55; ฿8,351.45 rounds half-up to ฿8,351. */
    expect(priceAfterPercentDiscount(COMPUTED, 500n)).toBe(835_100n);
    /* 15% is ฿1,318.65; ฿7,472.35 → ฿7,472. */
    expect(priceAfterPercentDiscount(COMPUTED, 1_500n)).toBe(747_200n);
    /* 7% is ฿615.37 exactly; ฿8,175.63 → ฿8,176. */
    expect(priceAfterPercentDiscount(COMPUTED, 700n)).toBe(817_600n);
  });

  it('rounds half away from zero, which Math.round does not — plan 7.9(ง)(4)', () => {
    /* 100001 × 5000 / 10000 = 50000.5 → 50001 away from zero, so 100001 − 50001 = 50000. */
    expect(priceAfterPercentDiscount(100_001n, 5_000n)).toBe(50_000n);
  });

  it('takes the whole price at the ceiling', () => {
    expect(priceAfterPercentDiscount(COMPUTED, FULL_DISCOUNT_BP)).toBe(0n);
  });

  /*
   * The sign is gone by the time a figure reaches here — `discountBp` removed it. This asserts
   * what a caller that skipped that step would get, so that the shape of the old bug is on the
   * record: a negative bp *raises* the price, which is exactly what the dashboard preview did.
   */
  it('would raise the price if a caller passed a negative bp, which is why nothing may', () => {
    expect(priceAfterPercentDiscount(COMPUTED, -500n)).toBe(923_100n);
    expect(priceAfterPercentDiscount(COMPUTED, -500n)).toBeGreaterThan(COMPUTED);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY SHAPE A PERSON TYPES A PERCENTAGE IN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The field renders `%` as a decoration, so `5` is what a salesperson sends when the caption says
 * ส่วนลด and the box shows `%`. The server requires a literal `%`. This function closes that gap,
 * and the property that matters is that **all four accepted spellings mean the same discount** —
 * because the last defect here was two spellings meaning opposite things.
 */
const entry = (result: Ruled<PercentEntry, PercentEntryRefusal>): PercentEntry => {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.refusal}`);
  return result.value;
};

const refused = (result: Ruled<PercentEntry, PercentEntryRefusal>): PercentEntryRefusal => {
  if (result.ok) throw new Error(`expected a refusal, got bp ${String(result.value.bp)}`);
  return result.refusal;
};

describe('a typed percentage, in every shape a person types it', () => {
  /*
   * ⭐ The assertion the owner's ruling turns on. Four spellings, one discount — and one of them
   * (`-5`) is the exact string that used to mean "add five percent" on this screen.
   */
  it('reads 5, -5, 5% and -5% as the same five percent off', () => {
    for (const typed of ['5', '-5', '5%', '-5%', ' 5 % ', '-5 %']) {
      expect(entry(normalisePercentEntry(typed)).bp, typed).toBe(500n);
    }
  });

  it('sends a literal % in every case, because the server refuses a bare number', () => {
    expect(entry(normalisePercentEntry('5')).wireText).toBe('5%');
    expect(entry(normalisePercentEntry('-5')).wireText).toBe('-5%');
    expect(entry(normalisePercentEntry('5%')).wireText).toBe('5%');
    expect(entry(normalisePercentEntry('-5%')).wireText).toBe('-5%');
    expect(entry(normalisePercentEntry('  7.50  ')).wireText).toBe('7.50%');
  });

  /*
   * `entered_value_text` is the record of what a human said (plan 7.9(ก)). A `-` survives because
   * it was typed; one is never added, because the server reads `5%` and `-5%` identically and an
   * invented character in an audit column buys nothing.
   */
  it('never invents a sign the person did not type', () => {
    expect(entry(normalisePercentEntry('5')).wireText).not.toContain('-');
    expect(entry(normalisePercentEntry('7.5')).wireText).not.toContain('-');
  });

  it('keeps two decimal places exactly, in the figure and on the wire', () => {
    expect(entry(normalisePercentEntry('7.5')).bp).toBe(750n);
    expect(entry(normalisePercentEntry('-3.31')).bp).toBe(331n);
    expect(entry(normalisePercentEntry('-3.31')).wireText).toBe('-3.31%');
    expect(entry(normalisePercentEntry('0.05')).bp).toBe(5n);
  });

  it('refuses an explicit surcharge, whichever way it is spelled', () => {
    expect(refused(normalisePercentEntry('+5'))).toBe('surcharge');
    expect(refused(normalisePercentEntry('+5%'))).toBe('surcharge');
  });

  it('refuses a discount that changes nothing', () => {
    expect(refused(normalisePercentEntry('0'))).toBe('no_change');
    expect(refused(normalisePercentEntry('0%'))).toBe('no_change');
    expect(refused(normalisePercentEntry('-0'))).toBe('no_change');
    expect(refused(normalisePercentEntry('0.00'))).toBe('no_change');
  });

  it('refuses an empty box before it becomes a price', () => {
    expect(refused(normalisePercentEntry(''))).toBe('empty');
    expect(refused(normalisePercentEntry('   '))).toBe('empty');
    expect(refused(normalisePercentEntry('%'))).toBe('empty');
  });

  it('refuses more than the whole price, signed or not', () => {
    expect(refused(normalisePercentEntry('101'))).toBe('above_full');
    expect(refused(normalisePercentEntry('-101%'))).toBe('above_full');
    expect(refused(normalisePercentEntry('-150%'))).toBe('above_full');
    expect(entry(normalisePercentEntry('100')).bp).toBe(FULL_DISCOUNT_BP);
  });

  it('refuses what is not a number, rather than guessing at it', () => {
    for (const typed of ['abc', '5.123', '5%5', '--5', '1,5', '5-', '', ' - ']) {
      expect(refused(normalisePercentEntry(typed)), typed).toMatch(/unreadable|empty/);
    }
  });

  /*
   * The end-to-end property, stated as arithmetic: whatever a person types, the figure the screen
   * derives from `bp` is the figure the server derives from `wireText`. The two sides of that are
   * asserted in the dashboard and api suites; this pins that one parse feeds both.
   */
  it('produces a figure and a wire text that describe the same discount', () => {
    for (const typed of ['5', '-5', '5%', '-5%', '7.5', '-3.31', '100']) {
      const value = entry(normalisePercentEntry(typed));
      const fromWire = entry(normalisePercentEntry(value.wireText));
      expect(fromWire.bp, typed).toBe(value.bp);
      expect(priceAfterPercentDiscount(COMPUTED, fromWire.bp), typed).toBe(
        priceAfterPercentDiscount(COMPUTED, value.bp),
      );
    }
  });
});
