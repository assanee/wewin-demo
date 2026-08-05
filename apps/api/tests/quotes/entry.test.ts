import { describe, expect, it } from 'vitest';

import { EntryError, normaliseCharge, normaliseEntry } from '../../src/quotes/entry';

/**
 * What a human typed → the one figure the anchor holds — plan 7.9(ข).
 *
 * These are the tests that have to exist without a database, because the property they are
 * about is arithmetic: the API never accepts a computed figure, so *every* money a client
 * sends passes through this function, and a defect here is a wrong price with a person's name
 * on it and a plausible audit trail behind it.
 *
 * ฿8,791.00 — `879100` satang — is the plan's own worked figure and is used throughout so
 * that the numbers below can be checked against plan 7.9 and 4.3 directly.
 */

const BASELINE = 879_100n;

const money = (enteredAs: 'line_total' | 'unit_price' | 'percent_discount' | 'discount_amount', text: string, qty = 1) =>
  normaliseEntry({
    anchor: 'line_total',
    enteredAs,
    enteredValueText: text,
    computedThbMinor: BASELINE,
    computedDays: null,
    qty,
  });

describe('an absolute figure is taken exactly as typed', () => {
  it('reads plain baht', () => {
    expect(money('line_total', '8500')).toEqual({ kind: 'money', overrideThbMinor: 850_000n });
  });

  it('reads the separators and the currency mark a keyboard actually produces', () => {
    for (const typed of ['8,500', '฿8,500', 'THB 8500', ' 8500 ']) {
      expect(money('line_total', typed)).toEqual({ kind: 'money', overrideThbMinor: 850_000n });
    }
  });

  it('reads Thai digits', () => {
    expect(money('line_total', '๘๕๐๐')).toEqual({ kind: 'money', overrideThbMinor: 850_000n });
  });

  /*
   * ⭐ The reason nothing here is a `number`. `parseFloat('8500.29') * 100` is 850028.99999…,
   * which floors to 850028 — one satang lost, on a figure a human promised, with no symptom.
   */
  it('reads satang by string surgery and not by multiplying a float', () => {
    expect(money('line_total', '8500.29')).toEqual({ kind: 'money', overrideThbMinor: 850_029n });
    expect(money('line_total', '8500.5')).toEqual({ kind: 'money', overrideThbMinor: 850_050n });
  });

  it('refuses a third decimal place rather than silently charging two of them', () => {
    expect(() => money('line_total', '8500.567')).toThrow(EntryError);
  });

  it('refuses a negative price', () => {
    expect(() => money('line_total', '-8500')).toThrow(EntryError);
  });

  it('refuses a percentage in a money box', () => {
    expect(() => money('line_total', '15%')).toThrow(EntryError);
  });

  /* `8.500` is a European thousands separator to some people and ฿8.50 to this parser. It is
   * refused as ambiguous only if it has too many decimals; `8.50` is unambiguous and is ฿8.50. */
  it('reads a decimal point as a decimal point, never as a thousands separator', () => {
    expect(money('line_total', '8.50')).toEqual({ kind: 'money', overrideThbMinor: 850n });
  });
});

describe('the per-unit box normalises onto the line total — plan 7.9(ข)', () => {
  it('multiplies rather than divides, so nothing is rounded twice', () => {
    expect(money('unit_price', '9000', 2)).toEqual({ kind: 'money', overrideThbMinor: 1_800_000n });
  });

  it('carries satang through the multiplication exactly', () => {
    expect(money('unit_price', '8500.33', 3)).toEqual({
      kind: 'money',
      overrideThbMinor: 2_550_099n,
    });
  });
});

describe('a discount may only discount', () => {
  it('reads a percentage with or without the sign a salesperson happens to type', () => {
    /* 15% of ฿8,791.00 is ฿1,318.65; ฿8,791.00 − ฿1,318.65 = ฿7,472.35, on the whole baht ฿7,472. */
    for (const typed of ['-15%', '15%']) {
      expect(money('percent_discount', typed)).toEqual({
        kind: 'money',
        overrideThbMinor: 747_200n,
      });
    }
  });

  /*
   * ⭐ `+15%` is refused, and this is the test that makes the refusal a decision rather than an
   * accident. A discount mode that could also raise a price would arrive at plan 7.13's
   * `margin` dimension as a *negative* concession and quietly buy headroom under the ceiling
   * for the next real discount.
   */
  it('refuses an explicit surcharge in a discount box', () => {
    expect(() => money('percent_discount', '+15%')).toThrow(EntryError);
    expect(() => money('discount_amount', '+291')).toThrow(EntryError);
  });

  it('reads a discount written as money', () => {
    expect(money('discount_amount', '291')).toEqual({ kind: 'money', overrideThbMinor: 850_000n });
    expect(money('discount_amount', '-291')).toEqual({ kind: 'money', overrideThbMinor: 850_000n });
  });

  it('refuses a discount larger than the price, because a negative total is a refund', () => {
    expect(() => money('discount_amount', '9000')).toThrow(EntryError);
    expect(() => money('percent_discount', '-150%')).toThrow(EntryError);
  });

  it('refuses a percentage in the money box and money in the percentage box', () => {
    expect(() => money('percent_discount', '291')).toThrow(EntryError);
    expect(() => money('discount_amount', '15%')).toThrow(EntryError);
  });

  it('rounds a percentage to the whole baht, which is what every computed total already is', () => {
    /* 7% of ฿8,791.00 is ฿615.37 exactly; ฿8,175.63 rounds half-up to ฿8,176. */
    expect(money('percent_discount', '7%')).toEqual({ kind: 'money', overrideThbMinor: 817_600n });
  });
});

describe('the anchor that is not money', () => {
  const days = (text: string) =>
    normaliseEntry({
      anchor: 'lead_time_days',
      enteredAs: 'lead_time_days',
      enteredValueText: text,
      computedThbMinor: null,
      computedDays: 30,
      qty: 1,
    });

  it('reads a count of days', () => {
    expect(days('45')).toEqual({ kind: 'days', overrideDays: 45 });
  });

  it('refuses a fraction of a day, a negative one and a percentage', () => {
    for (const typed of ['45.5', '-45', '15%']) expect(() => days(typed)).toThrow(EntryError);
  });
});

describe('a free-form charge is the one human figure that is a baseline', () => {
  it('reads a charge', () => {
    expect(normaliseCharge('2000')).toBe(200_000n);
  });

  /* Plan 7.13 lists "a negative charge" among the things `margin` has to catch: a −฿1,000
   * goodwill line is a discount wearing a different hat, and `applyOverrides` scores it as one. */
  it('reads a credit', () => {
    expect(normaliseCharge('-1000')).toBe(-100_000n);
  });

  it('refuses a line for nothing', () => {
    expect(() => normaliseCharge('0')).toThrow(EntryError);
  });

  it('refuses a percentage, which has no baseline to be a percentage of', () => {
    expect(() => normaliseCharge('10%')).toThrow(EntryError);
  });
});

describe('nonsense is refused rather than coerced', () => {
  it.each(['', 'free', '8,,500', '8500฿฿x', '--500', '8500%%'])('refuses %o', (typed) => {
    expect(() => money('line_total', typed)).toThrow(EntryError);
  });
});
