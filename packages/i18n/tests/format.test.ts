import { describe, expect, test } from 'vitest';
import { formatBaht, formatLength as coreLength } from '@wewin/core/format';
import { toMicrons } from '@wewin/core/units';
import {
  formatArea,
  formatCount,
  formatDate,
  formatDateParts,
  formatDateTime,
  formatDimensions,
  formatLength,
  formatMeasure,
  formatMoney,
  formatRange,
} from '../src/format.js';
import { LOCALES } from '../src/locales.js';
import { localiseNumerals } from '../src/numerals.js';

/*
 * The formatters.
 *
 * Two claims are worth more than the rest of this file put together, and both are about
 * what *cannot* happen:
 *
 *   · the Thai locale reproduces `@wewin/core/format` character for character, so this
 *     package is not a second opinion about how money looks — it is the same answer with
 *     seven more sets of glyphs available;
 *   · no amount and no length passes through a `number` on its way to the screen, which
 *     is checkable at a magnitude where a `number` would visibly fail.
 */

/**
 * The space ICU puts between an amount and its symbol is U+00A0, not U+0020.
 *
 * Written as an escape rather than pasted, because the two are indistinguishable in a
 * source file and a test that pastes the wrong one fails with `expected '8.791 ฿' to be
 * '8.791 ฿'`. It is also a warning for anything downstream that splits a rendered amount
 * on `' '` — a non-breaking space is the correct output and it will not match.
 */
const NBSP = '\u00A0';

describe('money', () => {
  test('Thai reproduces core exactly, sign and zero included', () => {
    // If this ever diverges, the storefront and the emails start disagreeing about a
    // price with no code change in between. Negative and zero are here because
    // `divRoundHalfUp` rounds away from zero and `-0` is forbidden by spec section 11.
    for (const minor of [0n, -1n, 1n, 49n, 50n, 879_100n, -879_100n, 1_234_567_800n]) {
      expect(formatMoney('th', minor, 'THB')).toBe(formatBaht(minor));
    }
  });

  test('a signed zero never reaches the screen', () => {
    // -1 satang rounds to zero baht. `format('-0')` would render `-฿0`; the rounded
    // amount is handed over as a `bigint`, which has no negative zero to render.
    expect(formatMoney('th', -1n, 'THB')).toBe('฿0');
    expect(formatMoney('de', -49n, 'THB')).toBe(`0${NBSP}฿`);
  });

  test('exact keeps the satang a payment record has to reconcile', () => {
    expect(formatMoney('th', 879_123n, 'THB', 'exact')).toBe('฿8,791.23');
    expect(formatMoney('th', -5n, 'THB', 'exact')).toBe('-฿0.05');
    // Whole would have rounded this to ฿8,791 and lost 23 satang without saying so.
    expect(formatMoney('th', 879_123n, 'THB')).toBe('฿8,791');
  });

  test('a currency with no minor unit is not given one', () => {
    // ₫100,000 is a hundred thousand đồng, not a thousand. Plan 4.3(c) records this
    // exact confusion reaching a written plan once already.
    expect(formatMoney('vi', 100_000n, 'VND')).toBe(`100.000${NBSP}₫`);
    expect(formatMoney('vi', 100_000n, 'VND', 'exact')).toBe(`100.000${NBSP}₫`);
  });

  test('exact is exact past the point a float counts in ones', () => {
    // 8.79e17 satang. `Number` steps in 128s up here, so a formatter that touched one
    // would round this and still look plausible.
    expect(formatMoney('th', 87_912_345_678_901_234_567n, 'THB', 'exact')).toBe(
      '฿879,123,456,789,012,345.67',
    );
  });

  test('the locale moves the glyphs, the grouping and the symbol — never the amount', () => {
    expect(formatMoney('th', 879_100n, 'THB')).toBe('฿8,791');
    expect(formatMoney('de', 879_100n, 'THB')).toBe(`8.791${NBSP}฿`); // symbol after
    expect(formatMoney('my', 879_100n, 'THB')).toBe(`၈,၇၉၁${NBSP}฿`); // Myanmar numerals
    expect(formatMoney('la', 879_100n, 'THB')).toBe('฿8.791'); // Lao groups with a point
    expect(formatMoney('hi', 123_456_700n, 'THB')).toBe('฿12,34,567'); // lakh grouping
  });

  test('this package does not pick a currency for a locale', () => {
    // Plan 4.2: one base currency with pinned rates. A German customer is quoted baht,
    // and the day that changes it is a business decision and not a locale table — so
    // every locale renders the currency it is *given*, and the baht is in all eight.
    for (const locale of LOCALES) {
      const rendered = formatMoney(locale, 879_100n, 'THB');
      expect(rendered.includes('฿') || rendered.includes('THB')).toBe(true);
      expect(rendered).not.toContain('€');
    }
  });
});

describe('lengths', () => {
  test('Thai is core, untouched', () => {
    for (const um of [1_605_000n, 3_205_000n, 2_498_725n, 0n]) {
      for (const unit of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
        expect(formatLength('th', um, unit)).toBe(coreLength(um, unit));
      }
    }
  });

  test('German moves the decimal mark; the value is the same digits', () => {
    expect(formatLength('th', toMicrons(160.5, 'cm'), 'cm')).toBe('160.5');
    expect(formatLength('de', toMicrons(160.5, 'cm'), 'cm')).toBe('160,5');
  });

  test('Burmese numerals reach inside an imperial fraction', () => {
    expect(formatMeasure('th', 2_498_725n, 'in')).toBe('98 3/8"');
    expect(formatMeasure('my', 2_498_725n, 'in')).toBe('၉၈ ၃/၈"');
  });

  test('the ≈ marker is not the locale’s to drop', () => {
    // `formatMeasure` puts it there when the unit cannot express the value. It is the
    // difference between an approximation and a lie, and it survives translation.
    expect(formatMeasure('my', 4_000_000n, 'in')).toBe('≈၁၅၇ ၁/၂"');
    expect(formatRange('de', 600_000n, 4_000_000n, 'in')).toBe('≈23 5/8"–157 1/2"');
  });

  test('a length is never grouped, in any locale', () => {
    // Stated as a test because it is a decision: grouping would mean re-parsing a number
    // core deliberately never turns back into one. 3205 mm stays 3205.
    expect(formatLength('de', 3_205_000n, 'mm')).toBe('3205');
    expect(formatLength('hi', 3_205_000n, 'mm')).toBe('3205');
  });

  test('dimensions keep their single ≈ for the pair', () => {
    expect(formatDimensions('th', 3_200_000n, 1_600_000n, 'cm')).toBe('320 × 160 cm');
    expect(formatDimensions('de', 3_205_000n, 1_600_000n, 'cm')).toBe('320,5 × 160 cm');
  });

  test('an area is the bare number, so the unit word stays in the sentence', () => {
    expect(formatArea('th', 5_120_000_000_000n)).toBe('5.12');
    expect(formatArea('de', 5_120_000_000_000n)).toBe('5,12');
    expect(formatArea('my', 5_120_000_000_000n)).toBe('၅.၁၂');
  });
});

describe('the numeral pass itself', () => {
  /*
   * Tested at its own boundary rather than only through the formatters, because through
   * them it cannot fail: every string that reaches it today is a bare number, so a
   * pattern as loose as `[\d.]+` would produce identical output and a mutation of it
   * survives the whole rest of this suite. The narrowness is a contract of the function,
   * so it is checked where the contract is.
   */
  test('touches digits and an interior decimal point, and nothing else', () => {
    expect(localiseNumerals('de', '5.12')).toBe('5,12');
    // A dot that is not between digits is punctuation. `ตร.ม.` is an abbreviation, and a
    // pass that rewrote it would turn square metres into `ตร,ม,` in six locales.
    expect(localiseNumerals('de', 'ตร.ม. 5.12')).toBe('ตร.ม. 5,12');
    expect(localiseNumerals('de', '98 3/8"')).toBe('98 3/8"');
    expect(localiseNumerals('my', 'ตร.ม. 5.12')).toBe('ตร.ม. ၅.၁၂');
  });

  test('is the identity for a locale whose numerals are already ASCII', () => {
    for (const text of ['5.12', '≈39 3/8"–39 1/2"', 'ตร.ม.']) {
      expect(localiseNumerals('th', text)).toBe(text);
      expect(localiseNumerals('en', text)).toBe(text);
    }
  });
});

describe('counts', () => {
  test('are grouped the way the locale groups, unlike a length', () => {
    expect(formatCount('en', 1_234_567n)).toBe('1,234,567');
    expect(formatCount('de', 1_234_567n)).toBe('1.234.567');
    // Indian grouping is lakh/crore, not thousands. A hand-rolled `\B(?=(\d{3})+)` would
    // have produced 1,234,567 here and looked right to everyone who cannot read it.
    expect(formatCount('hi', 1_234_567n)).toBe('12,34,567');
  });

  test('a count is a bigint or a number, and neither is rounded here', () => {
    expect(formatCount('en', 87_912_345_678_901_234_567n)).toBe('87,912,345,678,901,234,567');
  });
});

describe('dates', () => {
  // 01:00 on the 6th in Bangkok, 18:00 on the 5th in UTC. One instant, two days.
  const instant = new Date('2026-08-05T18:00:00Z');

  test('render in the business time zone, not the host’s', () => {
    expect(formatDate('en', instant)).toBe('6 Aug 2026');
    expect(formatDate('en', instant, { timeZone: 'UTC' })).toBe('5 Aug 2026');
  });

  test('Thai dates are in the Buddhist era, because a Thai document is', () => {
    const year = formatDateParts('th', instant).find((part) => part.type === 'year');
    expect(year?.value).toBe('2569');
    expect(formatDate('th', instant, { calendar: 'gregory' })).toContain('2026');
  });

  test('no other locale inherits the Thai era', () => {
    for (const locale of ['de', 'en', 'hi', 'la', 'my', 'vi', 'zh'] as const) {
      const year = formatDateParts(locale, instant).find((part) => part.type === 'year');
      expect(year?.value).not.toContain('2569');
    }
  });

  test('a timestamp keeps the hour, in the same zone', () => {
    expect(formatDateTime('en', instant)).toContain('01:00');
    expect(formatDateTime('en', instant, { timeZone: 'UTC' })).toContain('18:00');
  });
});
