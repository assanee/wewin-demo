import { CURRENCIES, type Currency } from '@wewin/core/money';
import { LOCALES, type Locale } from './locales.js';

/**
 * # How each locale writes a number — **written down, not asked at run time**
 *
 * ## The bug this table exists to stop
 *
 * Everything else in this package derives its answer from `Intl`: `numeralsFor` asks CLDR
 * for a locale's digits, `formatMoney` asks it where the currency symbol goes. That is the
 * right instinct — a hand-typed row of Burmese digits is a row nobody in the building can
 * proofread — and it holds exactly as long as every runtime has the same CLDR data.
 *
 * They do not. Measured in a browser during phase 6b, on the storefront's own pages:
 *
 * ```
 *   Node 24 (full ICU)          Chromium
 *   my  ၇,၆၈၀ ฿                  ฿7,680       Intl.NumberFormat('my-MM').resolvedOptions().locale === 'en-US'
 *   la  ฿7.680                   ฿7,680       Intl.NumberFormat('lo-LA').resolvedOptions().locale === 'en-US'
 * ```
 *
 * Chromium has no data for either tag and falls through to `en-US` **silently** — the same
 * failure `locales.ts` documents for `la`/Latin, one layer down and in the other engine.
 * Two of the eight locales therefore served a price the server had spelt one way and the
 * browser respelt another, on every product page: React error #418 on 648 pages, and, far
 * worse than the error, `฿7.680` sitting in the cached, crawlable HTML of every Lao page —
 * which any European convention reads as seven baht sixty-eight.
 *
 * The value never moved. `values-do-not-move.test.ts` was right and stayed green. What
 * moved was the *spelling*, and a price whose spelling depends on which engine drew it is
 * the risk-1 failure ("the screen disagrees with the invoice") arriving through
 * typography. The Vite app could not have this bug: one engine drew every number. Server
 * rendering is what introduced a second engine, so 6b is where it has to be answered.
 *
 * ## Why a table is the answer, and what stops it going stale
 *
 * `numerals.ts` argued against exactly this: *"a table of eight numbering systems is a
 * table that is wrong the day a ninth locale is added, and its wrongness looks like a
 * rendering that is merely ugly rather than one that is incorrect."* That argument is
 * sound and it is answered rather than overruled:
 *
 *   **Derived at test time, pinned at run time.** `tests/format.test.ts` rebuilds every
 *   field below from `Intl` on the machine running the suite and fails if one disagrees.
 *   So CI — which runs on Node with full ICU — is what keeps this honest, and a ninth
 *   locale added without an entry here fails the suite rather than rendering badly. What
 *   the table buys is that the *rendering* no longer depends on the reader's engine having
 *   the data, only on ours having had it when the test last ran.
 *
 * It is also less code than it looks: this is six fields describing where a separator goes.
 * `Intl` is still what produced every value in it, and still what checks them.
 *
 * ## What is deliberately NOT in here
 *
 * **Dates.** `formatDate` still goes through `Intl.DateTimeFormat`, and month names in Lao
 * and Burmese are subject to the same missing-CLDR problem. It is not fixed here because a
 * table of month names in four scripts is a translation task rather than a formatting one,
 * and because no date is currently rendered on a storefront page — the exposure is the
 * dashboard and the notification worker, both of which run only on Node today. It is in
 * the plan's risk register rather than in this file.
 */

/** Where the currency symbol sits relative to the amount, and what separates them. */
export interface CurrencyLayout {
  /** `฿7,680` (true) or `7.680 ฿` (false). */
  readonly symbolFirst: boolean;
  /** U+00A0 when the symbol trails, empty when it leads. Never a plain space. */
  readonly gap: string;
  /**
   * `฿-7.680` rather than `-฿7.680`, which is Lao and only Lao.
   *
   * Kept because it is what CLDR says and what this codebase already rendered; a "tidier"
   * uniform rule here would be this file inventing a typographic convention for a language
   * nobody on the team reads.
   */
  readonly minusAfterSymbol: boolean;
}

export interface NumberSpec {
  /** The locale's glyph for each of `0`–`9`, in order. */
  readonly digits: readonly string[];
  /** Between the whole part and the fraction. */
  readonly decimal: string;
  /** Between groups of the whole part. */
  readonly group: string;
  /**
   * `western` groups by threes; `indian` groups the last three and then by twos —
   * `12,34,567`, which is what `hi-IN` writes and what a lakh means.
   */
  readonly grouping: 'western' | 'indian';
  readonly currency: CurrencyLayout;
}

const LATIN = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
/** Myanmar digits U+1040–U+1049. The one locale in the set that renders its own. */
const MYANMAR = ['၀', '၁', '၂', '၃', '၄', '၅', '၆', '၇', '၈', '၉'] as const;

const SYMBOL_FIRST: CurrencyLayout = { symbolFirst: true, gap: '', minusAfterSymbol: false };
const SYMBOL_LAST: CurrencyLayout = { symbolFirst: false, gap: ' ', minusAfterSymbol: false };

export const NUMBER_SPEC: Readonly<Record<Locale, NumberSpec>> = {
  de: { digits: LATIN, decimal: ',', group: '.', grouping: 'western', currency: SYMBOL_LAST },
  en: { digits: LATIN, decimal: '.', group: ',', grouping: 'western', currency: SYMBOL_FIRST },
  hi: { digits: LATIN, decimal: '.', group: ',', grouping: 'indian', currency: SYMBOL_FIRST },
  la: {
    digits: LATIN,
    decimal: ',',
    group: '.',
    grouping: 'western',
    currency: { symbolFirst: true, gap: '', minusAfterSymbol: true },
  },
  my: { digits: MYANMAR, decimal: '.', group: ',', grouping: 'western', currency: SYMBOL_LAST },
  th: { digits: LATIN, decimal: '.', group: ',', grouping: 'western', currency: SYMBOL_FIRST },
  vi: { digits: LATIN, decimal: ',', group: '.', grouping: 'western', currency: SYMBOL_LAST },
  zh: { digits: LATIN, decimal: '.', group: ',', grouping: 'western', currency: SYMBOL_FIRST },
};

/**
 * The narrow symbol for each currency — **a fact about the currency, not about the
 * reader.**
 *
 * `format.ts` has always forced `currencyDisplay: 'narrowSymbol'` and its header says why:
 * ICU's per-locale default writes `THB 8,791` in `en-GB` and `zh-CN` and `฿8,791` in
 * `th-TH`, and half the set spelling it differently reads as two currencies rather than
 * one currency written two ways. Once that is forced, the symbol is the same string in all
 * eight locales — verified for all nine currencies, which is what makes this a
 * one-dimensional table instead of a nine-by-eight one.
 */
export const NARROW_SYMBOL: Readonly<Record<Currency, string>> = {
  CNY: '¥',
  EUR: '€',
  INR: '₹',
  LAK: '₭',
  MYR: 'RM',
  SGD: '$',
  THB: '฿',
  USD: '$',
  VND: '₫',
};

/** The locales and currencies covered, so a test can walk the same sets this file claims. */
export const SPECIFIED_LOCALES: readonly Locale[] = LOCALES;
export const SPECIFIED_CURRENCIES: readonly Currency[] = CURRENCIES;

/**
 * A run of ASCII digits, grouped and re-glyphed. Nothing else touched.
 *
 * Takes and returns strings, never numbers: the value arriving here came from a `bigint`
 * and turning it into a `number` to insert separators is the round trip plan 4.1 and 4.3
 * spend the whole codebase avoiding.
 */
export function groupDigits(spec: NumberSpec, digits: string, grouped: boolean): string {
  const glyphs = (run: string): string =>
    [...run].map((character) => spec.digits[Number(character)] ?? character).join('');

  if (!grouped || digits.length <= 3) return glyphs(digits);

  const chunks: string[] = [];
  let head = digits;

  if (spec.grouping === 'indian') {
    // The last three, then twos: 1234567 → 12,34,567.
    chunks.unshift(head.slice(-3));
    head = head.slice(0, -3);
    while (head.length > 2) {
      chunks.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
  } else {
    while (head.length > 3) {
      chunks.unshift(head.slice(-3));
      head = head.slice(0, -3);
    }
  }

  if (head.length > 0) chunks.unshift(head);
  return chunks.map(glyphs).join(spec.group);
}

/**
 * An exact decimal string (`-12345.67`), written the way this locale writes numbers.
 *
 * The input is produced by integer arithmetic upstream — `divRoundHalfUp` for money,
 * `@wewin/core/format` for lengths — and this only re-spells it. No parsing, no rounding,
 * no `Number`.
 */
export function writeDecimal(locale: Locale, value: string, grouped: boolean): string {
  const spec = NUMBER_SPEC[locale];
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole = '', fraction] = magnitude.split('.');

  const body =
    fraction === undefined
      ? groupDigits(spec, whole, grouped)
      : `${groupDigits(spec, whole, grouped)}${spec.decimal}${groupDigits(spec, fraction, false)}`;

  return negative ? `-${body}` : body;
}

/** The same, with a currency symbol placed where this locale places it. */
export function writeCurrency(locale: Locale, currency: Currency, value: string): string {
  const { currency: layout } = NUMBER_SPEC[locale];
  const symbol = NARROW_SYMBOL[currency];
  const negative = value.startsWith('-');
  const body = writeDecimal(locale, negative ? value.slice(1) : value, true);
  const sign = negative ? '-' : '';

  if (!layout.symbolFirst) return `${sign}${body}${layout.gap}${symbol}`;
  return layout.minusAfterSymbol ? `${symbol}${sign}${body}` : `${sign}${symbol}${body}`;
}
