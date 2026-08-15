import { describe, expect, test } from 'vitest';
import {
  formatBaht,
  formatDimensions,
  formatInteger,
  formatLength,
  formatMeasure,
  formatRange,
  formatSqmExact,
} from '@wewin/core/format';
import { divRoundHalfUp } from '@wewin/core/money';
import { LENGTH_UNITS, SQ_UM_PER_SQM } from '@wewin/core/units';
import { formattersFor } from './format';
import { LOCALE_TAGS, LOCALES, type Locale } from './locales';
import { decodeNumber, decodeNumerals } from './testing/decode';

/*
 * The phase 6a gate for this app.
 *
 * Phase 2 pinned that changing the *unit* cannot move a length by a micrometre. This
 * file pins the same property for the *language*, because it is the same property and
 * it fails the same way — silently, on a screen, in a currency somebody is about to
 * transfer.
 *
 *   **A price is ฿8,791 in every locale, even where the digits are drawn differently.**
 *
 * Every assertion below is a property rather than a table of expected strings. A table
 * pins today's CLDR: it goes red when ICU moves a separator, which is not a bug, and
 * it stays green when the value is wrong in the same way its author was. The property
 * is the thing worth defending — whatever glyphs the locale picks, the digits
 * underneath must be the digits core computed.
 */

/** Every locale, as `test.each` rows, so a failure names the language that broke. */
const everyLocale = LOCALES.map((locale) => [locale] as const);

/**
 * The first locale this *runtime* actually draws in non-Latin digits, if any.
 *
 * Not a constant, and the reason is a real finding rather than caution. Under Node's
 * full ICU, `my-MM` resolves to the `mymr` numbering system and ฿8,791 is `฿၈,၇၉၁`.
 * Under the Chromium that Playwright ships — checked, in the actual browser, on the
 * actual page — `my-MM` resolves to `latn` and the same price reads `฿8,791`; that
 * build's ICU data has no Burmese numerals, and it ignores an explicit `-u-nu-mymr`
 * request too, so pinning the tag cannot force the issue.
 *
 * A hard-coded `expect(…).toContain('၈')` would therefore be green in the suite and
 * wrong in the browser: a test that passes because of where it runs, which is the same
 * class of false green as a dead globalSetup. So the expectation is asked of the
 * runtime instead, and the assertions that need non-Latin digits say out loud when the
 * runtime cannot supply them.
 *
 * The *value* is unaffected either way — every property test above holds in both — and
 * a customer on a reduced-ICU browser sees Latin digits with the right grouping, which
 * is a degradation rather than a wrong number.
 */
const nonLatinLocale: Locale | null =
  LOCALES.find(
    (locale) =>
      new Intl.NumberFormat(LOCALE_TAGS[locale]).resolvedOptions().numberingSystem !== 'latn',
  ) ?? null;

/**
 * Money, in satang, chosen to break the ways this can go wrong.
 *
 * The last one is the important one: `879_100n` is the ฿8,791 the brief names, and
 * `123_456_789_012_345_678n` is past what a `double` holds exactly. Anything that
 * reaches for `Number(minor) / 100` renders it wrong, and does so only there.
 */
const MONEY_MINOR: readonly bigint[] = [
  0n,
  1n,
  49n,
  50n, // rounds half-up to ฿1 — core's rule, not the locale's
  99n,
  100n,
  879_100n,
  -879_100n,
  // Half a baht owed *back*. `Math.round(-0.5)` is `-0` in JavaScript, and `-0`
  // formats as `฿0`; core rounds half away from zero and owes ฿1. Spec section 11
  // forbids `-0` from reaching the screen at all, and this is the smallest value that
  // tells the two rules apart.
  -50n,
  1_234_567_890n,
  123_456_789_012_345_678n,
  // Past what a double holds: `Number(minor) / 100` is wrong from the sixteenth
  // significant digit here, and only here. Everything smaller agrees, which is exactly
  // why a suite without a value this size cannot tell the two implementations apart.
  139_350_629_764_023_435_870n,
];

/** Lengths, in canonical micrometres: a round metric size, an off-grid one, extremes. */
const LENGTHS_UM: readonly bigint[] = [
  0n,
  1n,
  3_175n, // one eighth of an inch — the imperial grid step
  1_600_200n, // 3,175 × 504: exactly on the eighth grid
  3_200_000n, // 320 cm
  3_205_000n, // 320.5 cm — inexact in inches, so it wears the ≈
  2_498_725n,
  4_000_000n,
];

describe('changing the language does not move a number', () => {
  test.each(everyLocale)('%s renders the same money as every other locale', (locale) => {
    const f = formattersFor(locale);

    for (const minor of MONEY_MINOR) {
      // The value the *domain* holds, computed here with core's own rounding so the
      // expectation cannot inherit a mistake from the code under test.
      const expected = divRoundHalfUp(minor, 100n).toString();

      expect(decodeNumber(f.baht(minor), locale)).toBe(expected);
    }
  });

  test.each(everyLocale)('%s renders the same lengths, in every unit', (locale) => {
    const f = formattersFor(locale);

    for (const um of LENGTHS_UM) {
      for (const unit of LENGTH_UNITS) {
        // Not "the same value" — the *same string*, once the glyphs are read back.
        // The `≈`, the `–`, the `"` and the reduced `1/2` are core's decisions and a
        // locale may not touch any of them.
        expect(decodeNumerals(f.length(um, unit), locale)).toBe(formatLength(um, unit));
        expect(decodeNumerals(f.measure(um, unit), locale)).toBe(formatMeasure(um, unit));
      }
    }
  });

  test.each(everyLocale)('%s keeps a range and a pair of dimensions intact', (locale) => {
    const f = formattersFor(locale);

    for (const unit of LENGTH_UNITS) {
      expect(decodeNumerals(f.range(600_000n, 4_000_000n, unit), locale)).toBe(
        formatRange(600_000n, 4_000_000n, unit),
      );
      expect(decodeNumerals(f.dimensions(3_200_000n, 1_600_000n, unit), locale)).toBe(
        formatDimensions(3_200_000n, 1_600_000n, unit),
      );
    }
  });

  test.each(everyLocale)('%s renders the same counts and areas', (locale) => {
    const f = formattersFor(locale);

    for (const count of [0, 1, 7, 81, 1_234, 1_000_000]) {
      expect(decodeNumber(f.integer(count), locale)).toBe(formatInteger(count).replace(/,/g, ''));
      expect(decodeNumber(f.plain(count), locale)).toBe(String(count));
    }

    for (const sqUm of [0n, 480_000_000_000n, 1_500_000_000_000n, 5_120_000_000_000n]) {
      expect(decodeNumber(f.area(sqUm), locale)).toBe(formatSqmExact(sqUm));
    }
  });

  test('the eight renderings of one price differ, or the test above proves nothing', () => {
    // A decoder that returned a constant would pass every assertion above. This is the
    // control: the locales really do write ฿8,791 in more than one way, so the
    // agreement they show is agreement about the value and not about the glyphs.
    const rendered = new Set(LOCALES.map((locale) => formattersFor(locale).baht(879_100n)));

    // German and Vietnamese group with `.` where Thai groups with `,`. That much is in
    // every ICU build, so this half of the control is runtime-independent.
    expect(rendered.size).toBeGreaterThan(1);
    expect(formattersFor('de').baht(879_100n)).not.toBe(formattersFor('th').baht(879_100n));
    expect(decodeNumber(formattersFor('de').baht(879_100n), 'de')).toBe('8791');

    // And where the runtime has a second numbering system, the digits differ too —
    // the strongest form of "same value, different glyphs" there is.
    if (nonLatinLocale === null) return;
    expect(formattersFor(nonLatinLocale).baht(879_100n)).not.toBe(
      formattersFor('th').baht(879_100n),
    );
    expect(decodeNumber(formattersFor(nonLatinLocale).baht(879_100n), nonLatinLocale)).toBe('8791');
  });

  test('the ฿ survives all eight, wherever the locale puts it', () => {
    // The brief states the property as "a price is ฿8,791 in every locale". The symbol
    // is `narrowSymbol`, which is a choice that could regress to `THB` if the option
    // were dropped, and it would regress silently.
    for (const locale of LOCALES) {
      expect(formattersFor(locale).baht(879_100n)).toContain('฿');
    }
  });
});

describe('Thai is identical to what core renders, digit for digit', () => {
  // Thai is the source language and `@wewin/core/format` is written in it, so the two
  // must agree exactly. This is what makes the property tests above meaningful: they
  // compare every locale against core's output, and this is the one locale where that
  // comparison is a string equality rather than a decode.
  const f = formattersFor('th');

  test('⭐ money — the exact figure, which core owns', () => {
    /*
     * ⚠️ `bahtExact`, not `baht`, and the swap is the record of a decision rather than a test
     * being bent to fit. `formatBaht` rounded to the whole baht until the owner stopped it: a
     * staff screen cannot move a figure by up to fifty satang when somebody is about to
     * reconcile it against a bank statement. Core's formatter and this storefront's exact one
     * are now the same rendering, and this line is what keeps them from drifting apart.
     */
    for (const minor of MONEY_MINOR) expect(f.bahtExact(minor)).toBe(formatBaht(minor));
  });

  test('⚠️ money — and the browsing price still rounds, which is the other half', () => {
    /*
     * `f.baht` is the price a shopper reads and it is untouched: `formatMoney(…, 'whole')`.
     * The split is by surface, not by audience — this same customer sees the exact figure on
     * the payment page. The three values below are the ones the list above was built to
     * straddle: the tie at half a baht, either side of it, and the negative tie where
     * `Math.round(-0.5)` would give `-0` and core owes a whole baht away from zero.
     */
    expect(f.baht(49n)).toBe('฿0');
    expect(f.baht(50n)).toBe('฿1');
    expect(f.baht(-50n)).toBe('-฿1');
  });

  test('lengths, ranges and dimensions', () => {
    for (const um of LENGTHS_UM) {
      for (const unit of LENGTH_UNITS) {
        expect(f.length(um, unit)).toBe(formatLength(um, unit));
        expect(f.measure(um, unit)).toBe(formatMeasure(um, unit));
      }
    }
    expect(f.range(600_000n, 4_000_000n, 'in')).toBe(formatRange(600_000n, 4_000_000n, 'in'));
    expect(f.dimensions(3_200_000n, 1_600_000n, 'in')).toBe(
      formatDimensions(3_200_000n, 1_600_000n, 'in'),
    );
  });

  test('counts and areas', () => {
    for (const count of [0, 81, 1_234]) expect(f.integer(count)).toBe(formatInteger(count));
    for (const sqUm of [480_000_000_000n, 5_120_000_000_000n]) {
      expect(f.area(sqUm)).toBe(formatSqmExact(sqUm));
    }
  });

  test('the ฿8,791 the brief names', () => {
    expect(f.baht(879_100n)).toBe('฿8,791');
  });
});

describe('nothing rounds on the way to the screen', () => {
  test('a fraction keeps every digit it arrived with', () => {
    // A length is rendered exactly, in `bigint`, and the locale layer only re-spells it.
    // If anything on this path went through `Intl`'s default `maximumFractionDigits` — 3
    // — a micrometre reading in metres would be silently rounded, and the value it
    // rounded would be a window somebody is about to have cut.
    expect(formattersFor('de').length(5_000n, 'm')).toBe('0,005');
    expect(formattersFor('en').length(4_999n, 'm')).toBe('0.004999');
    expect(formattersFor('en').area(1_500_000_000_000n)).toBe('1.50');
  });

  test('an eighteen-digit amount survives, which a double would not', () => {
    // ฿1,234,567,890,123,456 — absurd for a window and perfectly ordinary for a currency
    // with no minor unit, and past the point where a `double` counts in ones.
    const satang = 123_456_789_012_345_600n;
    expect(decodeNumber(formattersFor('en').baht(satang), 'en')).toBe('1234567890123456');
    expect(String(Number('1234567890123456789'))).not.toBe('1234567890123456789');
  });

  test('a broken count renders as zero rather than as NaN', () => {
    // Spec section 11 forbids `NaN` and `-0` from ever reaching the screen, and `Intl`
    // renders both without complaint: `format(NaN)` is `'NaN'` and `format(-0.2)` with no
    // fraction digits is `'-0'`. Core's `formatInteger` guards against exactly this and
    // the locale layer has to guard the same way — it is on the render path of every
    // count on the site.
    expect(formattersFor('en').integer(Number.NaN)).toBe('0');
    expect(formattersFor('en').integer(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formattersFor('en').plain(-0.2)).toBe('0');
    // −49 satang rounds to zero baht, and that zero must not carry the sign it came in
    // with. A `bigint` has no `-0`, which is why the whole-baht path rounds *before* it
    // reaches `Intl` rather than handing over a signed decimal string.
    expect(formattersFor('th').baht(-49n)).not.toContain('-');
    // And the sign is not simply being dropped: −50 satang really is a debt of one baht.
    expect(decodeNumber(formattersFor('th').baht(-50n), 'th')).toBe('-1');
  });
});

describe('there is exactly one area path, and it is the exact one', () => {
  const sqmOf = (sqUm: bigint): number => Number(sqUm) / Number(SQ_UM_PER_SQM);

  const AREAS_SQ_UM: readonly bigint[] = [
    0n,
    480_000_000_000n, // 0.48 m² — an 80 × 60 cm panel
    1_500_000_000_000n, // 1.50 m² — a typical minimum billable floor
    5_120_000_000_000n, // 5.12 m² — 320 × 160 cm
    8_000_000_000_000n,
  ];

  test.each(everyLocale)('%s renders the exact value, not the double', (locale: Locale) => {
    const f = formattersFor(locale);
    for (const sqUm of AREAS_SQ_UM) {
      expect(decodeNumber(f.area(sqUm), locale)).toBe(formatSqmExact(sqUm));
    }
  });

  test('21.255 m² — the value that had two answers on one screen', () => {
    // 780 × 272.5 cm, fold-nt-12. Before this round the summary bar took
    // `PriceBreakdown.areaSqm` through `formatSqm` and printed `21.25`, while the base
    // row's label took the same quantity through the `bigint` path and printed `21.26`.
    // Both were on the page at once, and neither matched the price, which is computed
    // from the exact area and was right.
    //
    // Measured over the real catalogue at the time: 124,612 of 1,051,769 sampled
    // reachable configurations — 11.8% — showed a pair of areas that disagreed.
    //
    // `f.sqm` no longer exists, so there is nothing left to disagree with. This pins the
    // survivor and pins that the double path really did differ, so the fix cannot be
    // undone by "simplifying" back to `sqUmToSqm`.
    const sqUm = 21_255_000_000_000n;
    expect(formattersFor('th').area(sqUm)).toBe('21.26');
    expect(sqmOf(sqUm).toFixed(2)).toBe('21.25');
  });

  test('and the exact path is the one that stays exact on a tie', () => {
    // 1.005 m² — a small panel, and the value where the two paths part company.
    //
    // The bigint path rounds the hundredth half *up*, which is the rule the rest of
    // the money code uses. The obvious alternative — `formatSqm(sqUmToSqm(sqUm))`,
    // which is what the rest of the screen uses on the `number` fields — goes through
    // a double, where 1.005 is really 1.00499999999999989 and `toFixed(2)` therefore
    // reports `1.00`. One square centimetre, on the row that explains a base charge.
    //
    // Worth knowing how narrow this is: across the catalogue's whole range the two
    // paths agree on every value tried, and this tie is the case that separates them.
    // The `bigint` path is correct by construction rather than by margin.
    expect(formattersFor('th').area(1_005_000_000_000n)).toBe('1.01');
    expect((Number(1_005_000_000_000n) / 1e12).toFixed(2)).toBe('1.00');

    expect(formattersFor('th').area(1_004_999_999_999n)).toBe('1.00');
  });
});

describe('a unit is meaning, and stays out of the locale', () => {
  test('the same micrometres in a different language are the same micrometres', () => {
    // The failure this forbids: a locale layer that "helpfully" converts to feet for
    // en-US. 3,200,000 µm is 320 cm to a German and 320 cm to a Thai; which unit it is
    // *shown* in is the display-unit preference phase 2 built, and language has no
    // vote in it.
    const asCm = LOCALES.map((locale) =>
      decodeNumerals(formattersFor(locale).length(3_200_000n, 'cm'), locale),
    );
    expect(new Set(asCm)).toEqual(new Set(['320']));

    // And the unit that *is* asked for is honoured, in a locale that writes its
    // decimal point differently — so `3.2 m` really does come back as `3.2 m` and not
    // as a metre value that lost its fraction on the way through the separator swap.
    const de = formattersFor('de');
    expect(de.measure(3_200_000n, 'm')).toBe('3,2 m');
    expect(decodeNumerals(de.measure(3_200_000n, 'm'), 'de')).toBe('3.2 m');
    expect(decodeNumerals(de.measure(3_200_000n, 'mm'), 'de')).toBe('3200 mm');
  });

  test('every digit is transliterated, including the ones inside a fraction', () => {
    // Where the runtime has non-Latin digits, a correct rendering of `98 3/8"` has no
    // ASCII digit left in it. A numeral matcher that swallowed the `/` would hand
    // `3/8` to the formatter, which rejects it as unparseable and passes it straight
    // through — leaving half the reading in Latin digits, and leaving every property
    // test above green, because decoding a Latin digit is the identity.
    //
    // This is the *only* assertion in the file that can catch that, so when the
    // runtime has no second numbering system the guard behind it has no evidence here
    // and the test says so rather than passing quietly.
    expect(
      nonLatinLocale,
      'this runtime has only Latin digits, so transliteration is untested',
    ).not.toBeNull();
    if (nonLatinLocale === null) return;

    const imperial = formattersFor(nonLatinLocale).measure(2_498_725n, 'in');

    expect(imperial).toContain('/');
    expect(imperial).not.toMatch(/[0-9]/);
    expect(decodeNumerals(imperial, nonLatinLocale)).toBe(formatMeasure(2_498_725n, 'in'));

    // And the same for the metric decimal, where the point is not a digit.
    expect(formattersFor(nonLatinLocale).length(3_205_000n, 'cm')).not.toMatch(/[0-9]/);
  });

  test('a length is never grouped, in any locale', () => {
    // 3,200 mm grouped as `3.200 mm` in German would read as three point two
    // millimetres to anyone who then typed it back. `MeasureInput` keeps its own field
    // canonical for exactly this reason, but the readings around it must not lie
    // either.
    for (const locale of LOCALES) {
      expect(formattersFor(locale).length(3_200_000n, 'mm')).not.toMatch(/[.,\s]/);
    }
  });
});
