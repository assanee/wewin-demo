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
 * ONE ACCEPTED FORMAT, AND EVERY OTHER SPELLING REFUSED BY NAME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The field renders `%` as a decoration and the caption says ส่วนลด, so the accepted format is a
 * plain positive number: `5` means five percent off. The server requires a literal `%`, which this
 * function appends — that part is plumbing nobody sees.
 *
 * ⚠️ **An earlier round of this file accepted `5`, `-5`, `5%`, `-5%` and `5 %` as the same
 * discount, and those tests are now inverted on purpose.** Five spellings are five things a
 * salesperson might believe about what they typed; the owner asked for one spelling and a visible
 * refusal. So the assertions below are mostly about what is *rejected* — a suite that only checked
 * `5` would pass against a function that accepted everything, which is precisely the state being
 * left behind.
 */
const entry = (result: Ruled<PercentEntry, PercentEntryRefusal>): PercentEntry => {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.refusal}`);
  return result.value;
};

const refused = (result: Ruled<PercentEntry, PercentEntryRefusal>): PercentEntryRefusal => {
  if (result.ok) throw new Error(`expected a refusal, got bp ${String(result.value.bp)}`);
  return result.refusal;
};

describe('a typed percentage: one accepted format', () => {
  it('accepts a plain positive number, whole or to two decimals', () => {
    expect(entry(normalisePercentEntry('5')).bp).toBe(500n);
    expect(entry(normalisePercentEntry('7.5')).bp).toBe(750n);
    expect(entry(normalisePercentEntry('3.31')).bp).toBe(331n);
    expect(entry(normalisePercentEntry('0.05')).bp).toBe(5n);
    expect(entry(normalisePercentEntry('100')).bp).toBe(FULL_DISCOUNT_BP);
  });

  it('trims outer whitespace, because a paste carries it and the contract trims too', () => {
    expect(entry(normalisePercentEntry('  5  ')).bp).toBe(500n);
    expect(entry(normalisePercentEntry('\t7.5\n')).wireText).toBe('7.5%');
  });

  it('appends the % the field only draws, and adds nothing else', () => {
    expect(entry(normalisePercentEntry('5')).wireText).toBe('5%');
    expect(entry(normalisePercentEntry('7.50')).wireText).toBe('7.50%');
    /* `entered_value_text` is plan 7.9(ก)'s record of what was typed — no sign is invented. */
    expect(entry(normalisePercentEntry('5')).wireText).not.toContain('-');
  });
});

/**
 * ⭐ THE REFUSALS ARE THE FEATURE.
 *
 * Each rejected spelling must actually be rejected, and with the reason that names it — `signed`
 * and `percent_typed` are distinct codes so the prose can say "drop the minus" and "drop the %"
 * rather than a shared "invalid" that teaches nothing.
 */
describe('a typed percentage: everything else is refused, by name', () => {
  it('refuses a sign, which is the character this whole defect began with', () => {
    expect(refused(normalisePercentEntry('-5'))).toBe('signed');
    expect(refused(normalisePercentEntry('+5'))).toBe('signed');
    expect(refused(normalisePercentEntry('-5%'))).toBe('signed');
    expect(refused(normalisePercentEntry('+5%'))).toBe('signed');
    expect(refused(normalisePercentEntry('-7.5'))).toBe('signed');
    /* `--5` is nonsense, but a leading sign is still the most useful thing to name about it. */
    expect(refused(normalisePercentEntry('--5'))).toBe('signed');
  });

  it('refuses a typed %, because the field already shows one', () => {
    expect(refused(normalisePercentEntry('5%'))).toBe('percent_typed');
    expect(refused(normalisePercentEntry('5 %'))).toBe('percent_typed');
    expect(refused(normalisePercentEntry('7.5%'))).toBe('percent_typed');
    expect(refused(normalisePercentEntry('%5'))).toBe('percent_typed');
  });

  it('refuses a space inside the number', () => {
    expect(refused(normalisePercentEntry('1 5'))).toBe('unreadable');
    expect(refused(normalisePercentEntry('7 . 5'))).toBe('unreadable');
  });

  it('refuses a discount that changes nothing', () => {
    expect(refused(normalisePercentEntry('0'))).toBe('no_change');
    expect(refused(normalisePercentEntry('0.00'))).toBe('no_change');
    expect(refused(normalisePercentEntry('00'))).toBe('no_change');
  });

  it('refuses a blank box, which is what the dialog shows on open', () => {
    expect(refused(normalisePercentEntry(''))).toBe('empty');
    expect(refused(normalisePercentEntry('   '))).toBe('empty');
  });

  it('refuses more than the whole price', () => {
    expect(refused(normalisePercentEntry('101'))).toBe('above_full');
    expect(refused(normalisePercentEntry('100.01'))).toBe('above_full');
    expect(refused(normalisePercentEntry('150'))).toBe('above_full');
  });

  it('refuses what is not a number, rather than guessing at it', () => {
    for (const typed of ['abc', '5.123', '1,5', '5-', '5..5', '.5', '5.']) {
      expect(refused(normalisePercentEntry(typed)), typed).toBe('unreadable');
    }
  });

  /*
   * The regression guard for the round being reversed here: these five spellings all used to be
   * accepted and all used to mean five percent off. Every one of them must now refuse, or the
   * strictness has quietly come undone.
   */
  it('refuses every spelling the lenient version accepted', () => {
    for (const typed of ['-5', '5%', '-5%', '5 %', '-5 %']) {
      expect(normalisePercentEntry(typed).ok, typed).toBe(false);
    }
    expect(normalisePercentEntry('5').ok).toBe(true);
  });

  /*
   * The end-to-end property, stated as arithmetic: the figure the screen derives from `bp` is the
   * figure the server derives from `wireText`. The two halves are asserted in the dashboard and api
   * suites; this pins that one parse feeds both.
   */
  it('produces a wire text that still describes the same discount', () => {
    for (const typed of ['5', '7.5', '3.31', '0.05', '100']) {
      const value = entry(normalisePercentEntry(typed));

      /*
       * The wire form carries a `%`, so this function refuses it — that is the strictness working,
       * not a defect. Take the `%` back off and the number has to read as the same discount, which
       * is what proves the append changed the spelling and not the figure. The other half of the
       * loop — the server parsing `wireText` — is `apps/api/tests/quotes/entry.test.ts`.
       */
      expect(normalisePercentEntry(value.wireText).ok, typed).toBe(false);
      expect(entry(normalisePercentEntry(value.wireText.replace(/%$/, ''))).bp, typed).toBe(value.bp);
      expect(value.wireText).toBe(`${typed}%`);
    }
  });
});
