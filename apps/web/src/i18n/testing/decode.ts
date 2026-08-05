import { LOCALE_TAGS, type Locale } from '../locales';

/**
 * The inverse of the locale layer, for tests only.
 *
 * `numerals.ts` writes a canonical number the way a locale writes numbers. This reads
 * it back. Together they make the round's central claim checkable rather than
 * asserted: if `decodeNumber(f.baht(minor), locale)` is the same integer for all eight
 * locales, then **changing the language did not move the number**, and if it is ever
 * not, a test fails with the locale that moved it named.
 *
 * ## Why an inverse and not a table of expected strings
 *
 * A table of `['de', '8.791 ฿']` pins today's CLDR. It goes red when ICU changes a
 * separator, which is not a bug, and it stays green when the *value* is wrong in a way
 * the table's author also got wrong. The inverse tests the property instead: whatever
 * glyphs the locale chose, the digits underneath have to be the digits core computed.
 *
 * Nothing here is imported by the app. It lives under `src/` so `tsc -b` checks it
 * with the same strictness as everything else.
 */

interface Alphabet {
  /** This locale's ten digits, in value order. */
  readonly digits: readonly string[];
  readonly decimal: string;
  readonly group: string;
}

const alphabets = new Map<Locale, Alphabet>();

/**
 * How this locale writes digits and separators, asked of `Intl` rather than tabulated.
 *
 * Derived from a formatted sample, so Burmese digits and Hindi lakh grouping arrive on
 * their own. A hand-written table here would be the same table `numerals.ts` refuses
 * to keep, and two copies of a wrong table agree perfectly.
 */
function alphabetOf(locale: Locale): Alphabet {
  const cached = alphabets.get(locale);
  if (cached) return cached;

  const tag = LOCALE_TAGS[locale];
  const plain = new Intl.NumberFormat(tag, { useGrouping: false });

  const digits = Array.from({ length: 10 }, (_, value) => plain.format(value));

  const parts = new Intl.NumberFormat(tag, {
    useGrouping: true,
    minimumFractionDigits: 1,
  }).formatToParts(1234567.8);

  const built: Alphabet = {
    digits,
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
  };

  alphabets.set(locale, built);
  return built;
}

/** A locale digit back to `0`–`9`, or `null` when the character is not a digit. */
function asciiDigit(character: string, alphabet: Alphabet): string | null {
  const value = alphabet.digits.indexOf(character);
  return value === -1 ? null : String(value);
}

/**
 * Locale digits back to ASCII, **leaving every other character exactly where it is**.
 *
 * For lengths, which are never grouped and which carry structure a locale may not
 * touch: the `≈` marker, the `–` between the ends of a range, the `"` and the `1/2`
 * that make an imperial reading readable on a tape. The result should be identical to
 * what `@wewin/core/format` produced before the locale saw it — that identity is the
 * assertion.
 */
export function decodeNumerals(rendered: string, locale: Locale): string {
  const alphabet = alphabetOf(locale);

  return [...rendered]
    .map((character) => {
      const digit = asciiDigit(character, alphabet);
      if (digit !== null) return digit;
      // A length has no grouping, so the only separator that can appear is the point.
      return character === alphabet.decimal ? '.' : character;
    })
    .join('');
}

/**
 * A rendered quantity back to a canonical decimal: digits, an optional `.`, a sign.
 *
 * Everything else goes — the currency symbol wherever the locale put it, the
 * non-breaking space German puts before it, the group separators, and the lakh
 * grouping Hindi uses instead of thousands. What is left has to match the integer the
 * caller started from, digit for digit.
 */
export function decodeNumber(rendered: string, locale: Locale): string {
  const alphabet = alphabetOf(locale);
  let sign = '';
  let body = '';

  for (const character of rendered) {
    const digit = asciiDigit(character, alphabet);
    if (digit !== null) {
      body += digit;
      continue;
    }
    if (character === alphabet.decimal) {
      body += '.';
      continue;
    }
    // U+2212 as well as the ASCII hyphen: several locales sign with the real minus.
    if ((character === '-' || character === '−') && body === '') sign = '-';
  }

  return `${sign}${body}`;
}
