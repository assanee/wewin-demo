import {
  formatArea,
  formatCount,
  formatDate,
  formatDimensions,
  formatLength,
  formatMeasure,
  formatDateParts,
  formatMoney,
  formatPlain,
  formatRange,
} from '@wewin/i18n/format';
import { localiseNumerals } from '@wewin/i18n/numerals';
import { formatMeasure as coreMeasure, formatRange as coreRange } from '@wewin/core/format';
import type { LengthUnit } from '@wewin/core/units';
import type { Locale } from './locales';
import { averageText } from '../lib/reviews/average';

/**
 * Every number on the screen, in one locale.
 *
 * A `Formatters` is what the locale catalogues are handed alongside their params, so a
 * translator's entry writes `f.baht(p.total)` and never sees `"฿8,791"` as a substring it
 * has to splice. That is the rule the round exists to establish: **a param is a value; this
 * object is the only thing that renders one.**
 *
 * ── Every method below is one line, and that is the point ────────────────────────
 *
 * This file used to hold the arithmetic: a currency-format cache, an exact `bigint`
 * square-metre routine, a `-0` collapse. `apps/api` held a second copy and `@wewin/i18n` a
 * third, and phase 6a's review put the three side by side on ฿1,234,567.89 and got three
 * different strings in four of the eight locales — including `vi`, where two of them swapped
 * the roles of `.` and `,`, so each was a valid reading of the other's number.
 *
 * The brief said *decide where formatting happens and make it one place*. It is
 * `@wewin/i18n/format`. What survives here is the **shape**: a per-locale object handed to
 * catalogue entries, so a catalogue cannot reach for a formatter and cannot accidentally
 * produce Western digits in a Burmese sentence. The shape is this app's; the numbers are
 * the package's.
 */
export interface Formatters {
  readonly locale: Locale;

  /** Thai baht, whole units, from minor units. Never takes baht — see core's note. */
  baht(minor: bigint): string;

  /**
   * ⭐ Thai baht **to the satang**, grouped — for a figure somebody is about to transfer.
   *
   * `f.baht` rounds to whole baht, which is right for a price on a browsing page and wrong
   * for the payment screen: the two satang it drops are two satang a customer's bank
   * transfer will not match.
   *
   * ⚠️ **It exists because the payment catalogue was building this string by hand**, as
   * `` `฿${f.plain(minor / 100n)}.${minor % 100n}` `` — and `f.plain` is the *ungrouped*
   * formatter, the one whose entire purpose is that a year reads `2026` and not `2,026`.
   * So the payment screen printed `฿14124.00` while the quotation one click earlier printed
   * `฿14,124.00`: the same number, written two ways, on two pages a customer walks between.
   *
   * ⚠️ **Not `formatMoney(locale, minor, 'THB', 'exact')`, which was the obvious answer and
   * is the wrong one.** That routes the whole amount through `Intl`, which for German gives
   * `28.248,24 ฿` and for Burmese `၂၈,၂၄၈.၂၄ ฿` — symbol moved to the end, decimal comma,
   * and the satang pad in Burmese digits. The quotation page renders the same figure through
   * `@wewin/core`'s own `money()`, which groups the *baht* through `toLocaleString` and
   * leaves the fraction ASCII behind a leading `฿`. Using `Intl` for the whole thing would
   * have fixed the grouping and broken the agreement it was supposed to create.
   *
   * So this mirrors core's convention exactly — leading `฿`, grouped baht, ASCII two-digit
   * satang, sign in front of the symbol — and differs from the code it replaced in precisely
   * one respect: the baht part is grouped. `catalogue.test.ts` already pins the other three
   * properties, and pinned them through this change without an edit.
   *
   * Nothing is rounded: the split is integer division and remainder, as before.
   */
  bahtExact(minor: bigint): string;

  /** A plain count: pieces, rows, days, product totals. Grouped. */
  integer(value: number | bigint): string;

  /**
   * An integer that must not be grouped — a year, above all.
   *
   * `2,026` is not a year in any of the eight, and `f.integer` would produce exactly that.
   * Separate function rather than an options bag, so a call site has to say which kind of
   * number it is holding.
   */
  plain(value: number | bigint): string;

  /**
   * Square metres from exact square micrometres, two decimals.
   *
   * ⚠️ There is no `sqm(value: number)` any more, and its absence is a fix rather than a
   * tidy-up. `PriceBreakdown.areaSqm` is a `double`, and 21.255 m² is
   * 21.254999999999999449… once it has been through one — so `toFixed(2)` wrote `21.25`
   * while this exact path wrote `21.26`, and both were on the screen at once: the summary
   * bar from the `double`, the base row's label from the `bigint`. Phase 6a measured the
   * disagreement at 11.8% of the catalogue's reachable configurations. Core now carries
   * `areaSqUm` and `billableSqUm` beside the numbers so every caller has the exact value,
   * and this is the only way to render one.
   */
  area(sqUm: bigint): string;

  /** A length in the unit asked for. Numerals only; the caller supplies the unit. */
  length(um: bigint, unit: LengthUnit): string;

  /** A length with its unit and, when the unit cannot say it exactly, an `≈`. */
  measure(um: bigint, unit: LengthUnit): string;

  /** A closed range, with one `≈` for the pair. */
  range(minUm: bigint, maxUm: bigint, unit: LengthUnit): string;

  /** `320 × 160 cm`, marked as a pair. */
  dimensions(widthUm: bigint, heightUm: bigint, unit: LengthUnit): string;

  /**
   * A number the customer will be asked to **type back**, in ASCII with an ASCII point.
   *
   * The one deliberate exception to "every number on screen is localised", and it exists
   * because `MeasureInput`'s field is not only displayed: `parseMeasure` reads it straight
   * back on blur and on every ± press, and it accepts exactly one decimal separator. The
   * field is therefore ASCII in all eight locales.
   *
   * Before this round the *helper line under it* was localised normally, which produced the
   * German page telling a customer `ทีละ 0,5` above a field that silently discards `320,5`
   * and resets the window to its default. An instruction that the field it labels cannot
   * obey is worse than no instruction, so a number that is a **specimen of input** goes
   * through here and a number that is a *quantity to read* does not.
   */
  entry(um: bigint, unit: LengthUnit): string;

  /** The same, for the pair of bounds a field states. ASCII, for the same reason. */
  entryRange(minUm: bigint, maxUm: bigint, unit: LengthUnit): string;

  /**
   * A calendar year, in this locale's own era. **Not** `plain(year + 543)`.
   *
   * The Thai catalogue used to do that arithmetic itself, inside the one file a
   * translator is meant to edit — so switching from English to German moved the year on
   * screen by 543, because German falls back to the Thai entry and the Thai entry
   * computes. A locale layer that computes is exactly what this round exists to abolish:
   * it re-spells, it does not recompute.
   *
   * The era comes from ICU via `LOCALE_CALENDAR`, so Thai renders 2569 and the other seven
   * render 2026 from the identical call, and a translator who copies the Thai entry gets a
   * correct year in their own language rather than a Buddhist one.
   */
  year(gregorianYear: number): string;

  /**
   * A calendar date — the day a review became public, and nothing finer.
   *
   * Medium style, in the business's own zone and the locale's own era, so a Thai reader
   * sees พ.ศ. and the other seven see the common era from the identical call. No time of
   * day: plan 9.2's whole point about reviews is the *season* they were written in
   * ("aluminium is judged after a rainy season"), and a timestamp to the minute on a
   * customer's opinion is precision nobody asked for and one more datum beside their words.
   */
  date(value: Date): string;

  /**
   * A star rating — **and the only way to render one is to hand over the count as well.**
   *
   * Plan 9.5: *"never show an average without its count."* `product_review_stats` makes
   * that structural by having no average column; this signature is the same decision at the
   * top of the stack, and it is the reason there is no `average: number` anywhere in this
   * app. A caller holding only a mean cannot call this function.
   *
   * Returns an em dash when `count` is zero. An average of nothing is not `0.0`, and a
   * formatter that rendered one would put a one-star-looking product on 81 pages that have
   * no reviews at all.
   *
   * ⚠️ **The decimal separator is the numerals path, not the number-spec one.** This routes
   * through `localiseNumerals`, exactly as `formatArea` does, because `writeDecimal` — the
   * function that knows German writes `4,2` — has no subpath export from `@wewin/i18n`.
   * German therefore reads `4.2` here and `21.26` for an area, which is at least the same
   * answer twice. Fixing it is one export in that package plus this line; it is written down
   * in the phase report rather than left as a surprise.
   */
  rating(sum: bigint, count: bigint): string;
}

const formattersCache = new Map<Locale, Formatters>();

/** The formatters for one locale. Memoised — `Intl` construction is not cheap. */
export function formattersFor(locale: Locale): Formatters {
  const cached = formattersCache.get(locale);
  if (cached) return cached;

  const created: Formatters = {
    locale,

    baht: (minor) => formatMoney(locale, minor, 'THB', 'whole'),

    bahtExact: (minor) => {
      /* Sign lifted out first: BigInt `/` and `%` truncate toward zero, so `-150n` split
       * directly renders `-1.-50` — the overpayment bug `catalogue.test.ts` pins. */
      const negative = minor < 0n;
      const magnitude = negative ? -minor : minor;
      const baht = formatCount(locale, magnitude / 100n);
      const satang = String(magnitude % 100n).padStart(2, '0');
      return `${negative ? '-' : ''}฿${baht}.${satang}`;
    },

    integer: (value) => formatCount(locale, value),

    plain: (value) => formatPlain(locale, value),

    area: (sqUm) => formatArea(locale, sqUm),

    length: (um, unit) => formatLength(locale, um, unit),

    measure: (um, unit) => formatMeasure(locale, um, unit),

    range: (minUm, maxUm, unit) => formatRange(locale, minUm, maxUm, unit),

    dimensions: (widthUm, heightUm, unit) => formatDimensions(locale, widthUm, heightUm, unit),

    // Core's own output, with no locale consulted at all — not `'en'`, which renders
    // identically today and would stop the moment somebody gave English a different
    // numbering system. This is not "the English spelling of the number"; it is "the
    // spelling this app's own parser accepts", and those are different facts.
    entry: (um, unit) => coreMeasure(um, unit),

    entryRange: (minUm, maxUm, unit) => coreRange(minUm, maxUm, unit),

    date: (value) => formatDate(locale, value, { style: 'medium' }),

    rating: (sum, count) => {
      const text = averageText({ sum, count });
      // `value.unknown`'s glyph, deliberately the same one, so a screen with no average on
      // it looks like every other screen with no value on it.
      return text === null ? '—' : localiseNumerals(locale, text);
    },

    year: (gregorianYear) => {
      // Mid-year in the business's own zone, so no time-zone offset can push the instant
      // into the neighbouring year — the failure that makes a copyright line read 2025 for
      // eight hours a day on a server west of Bangkok.
      const midYear = new Date(Date.UTC(gregorianYear, 6, 1, 12));
      const parts = formatDateParts(locale, midYear, { style: 'long' });
      return parts.find((part) => part.type === 'year')?.value ?? String(gregorianYear);
    },
  };

  formattersCache.set(locale, created);
  return created;
}
