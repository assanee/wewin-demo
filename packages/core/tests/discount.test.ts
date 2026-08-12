import { describe, expect, it } from 'vitest';

import {
  discountBp,
  discountMinor,
  FULL_DISCOUNT_BP,
  priceAfterPercentDiscount,
  type DiscountRule,
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
