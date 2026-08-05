import { INTL_TAG, type Locale } from './locales.js';

/**
 * Digits, and the mark between the whole part and the fraction.
 *
 * This module exists because of one rule stated in two places — plan 4.1 for lengths
 * and plan 4.3 for money:
 *
 *   **A canonical value is never turned back into a number in order to be shown.**
 *
 * `@wewin/core/format` renders a `bigint` micrometre count to an exact string with no
 * float anywhere on the path: `160.5`, `98 3/8"`, `≈39 3/8"–39 1/2"`. What it does not
 * do is know that Burmese writes those digits as `၁၆၀.၅`. So the locale layer takes
 * core's exact output and substitutes *glyphs* — never re-parsing the number, because
 * re-parsing to reformat is precisely the round-trip the codebase spends `bigint`
 * everywhere to avoid.
 *
 * The consequence, stated so it is a decision and not an oversight: **a length is never
 * grouped.** `3205` mm stays `3205` in German rather than becoming `3.205`, because
 * inserting a separator requires knowing where the thousands are, which requires
 * parsing. Money and counts *are* grouped — they go through `Intl` as whole values and
 * never through this function.
 */
export interface Numerals {
  /** The locale's glyph for each of `0`–`9`, in order. */
  readonly digits: readonly string[];
  /** The mark between the whole part and the fraction: `.` in Thai, `,` in German. */
  readonly decimal: string;
  /** True when nothing needs substituting — ASCII digits and an ASCII point. */
  readonly ascii: boolean;
}

const cache = new Map<Locale, Numerals>();

/**
 * The locale's numerals, asked of `Intl` once per locale and then remembered.
 *
 * Derived rather than tabulated. A table of eight numbering systems is a table that is
 * wrong the day a ninth locale is added, and its wrongness looks like a rendering that
 * is merely ugly rather than one that is incorrect.
 */
export function numeralsFor(locale: Locale): Numerals {
  const cached = cache.get(locale);
  if (cached) return cached;

  const tag = INTL_TAG[locale];
  const plain = new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: 0 });
  const digits = Array.from({ length: 10 }, (_unused, digit) => plain.format(digit));

  const decimal =
    new Intl.NumberFormat(tag, { useGrouping: false, minimumFractionDigits: 1 })
      .formatToParts(1.5)
      .find((part) => part.type === 'decimal')?.value ?? '.';

  const ascii = decimal === '.' && digits.every((glyph, index) => glyph === String(index));
  const numerals: Numerals = { digits, decimal, ascii };

  cache.set(locale, numerals);
  return numerals;
}

/**
 * The numbering systems a **keyboard** in one of the eight languages can produce.
 *
 * Deliberately *not* derived from `numeralsFor`, and the difference is the whole point.
 * `numeralsFor` answers "what does CLDR *render* this locale's numbers in", and for Thai and
 * Hindi that is `latn` — Thai prices are written ฿8,500, not ฿๘,๕๐๐. But a Thai keyboard has
 * a Thai digit row and a Devanagari keyboard has a Devanagari one, and what somebody *types*
 * is not decided by what CLDR *prints*. A map built from the rendering side would have
 * covered only Burmese, which is the one locale that renders in its own digits.
 *
 * So the systems are named, and the glyphs for each are asked of `Intl` rather than written
 * out — a hand-typed row of Burmese digits is a row nobody in the building can proofread.
 * `hanidec` is included because a Chinese IME will produce 〇一二三 for a number typed as
 * words; it is a real input, not a rendering this package would ever emit.
 *
 * No glyph appears in two of these systems, so the inverse is unambiguous — asserted in
 * `tests/format.test.ts` rather than assumed.
 */
const INPUT_NUMBERING = ['thai', 'deva', 'mymr', 'laoo', 'hanidec'] as const;

const asciiByGlyph = new Map<string, string>();

function digitMap(): ReadonlyMap<string, string> {
  if (asciiByGlyph.size > 0) return asciiByGlyph;

  for (const system of INPUT_NUMBERING) {
    const format = new Intl.NumberFormat(`en-u-nu-${system}`, { useGrouping: false });
    for (let value = 0; value < 10; value += 1) {
      const glyph = format.format(value);
      // A runtime whose ICU lacks a system falls back to `latn`, where the glyph already is
      // the ASCII digit. Skipping it keeps the map an identity there rather than wrong.
      if (glyph !== String(value)) asciiByGlyph.set(glyph, String(value));
    }
  }
  return asciiByGlyph;
}

/**
 * Any of the eight languages' digits, written as `0`–`9`. Everything else untouched.
 *
 * Deliberately *only* digits. Separators are left exactly where they were, because their
 * placement is evidence a parser needs: `8,500` is a grouped four-digit number and `85,00`
 * is not a number at all, and a normaliser that also tidied the punctuation would answer
 * ฿8,500 for both.
 */
export function asciiNumerals(text: string): string {
  const map = digitMap();

  let out = '';
  for (const character of text) out += map.get(character) ?? character;
  return out;
}

/** Every run of digits, with an optional fractional part. Nothing else is touched. */
const NUMERIC_RUN = /\d+(?:\.\d+)?/g;

/**
 * Core's exact rendering, in this locale's numerals.
 *
 * The regex is deliberately narrow. It matches a digit run and an interior point, so
 * `ตร.ม.` keeps its dots, `98 3/8"` keeps its solidus and its inch mark, and the `≈` that
 * `formatMeasure` puts in front of an inexact value survives untouched — that marker is
 * the difference between an approximation and a lie and it is not the locale's to drop.
 */
export function localiseNumerals(locale: Locale, text: string): string {
  const numerals = numeralsFor(locale);
  if (numerals.ascii) return text;

  return text.replace(NUMERIC_RUN, (run) =>
    [...run]
      .map((character) => {
        if (character === '.') return numerals.decimal;
        const digit = numerals.digits[Number(character)];
        return digit ?? character;
      })
      .join(''),
  );
}
