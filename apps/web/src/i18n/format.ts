import {
  formatArea,
  formatCount,
  formatDimensions,
  formatLength,
  formatMeasure,
  formatDateParts,
  formatMoney,
  formatPlain,
  formatRange,
} from '@wewin/i18n/format';
import { formatMeasure as coreMeasure, formatRange as coreRange } from '@wewin/core/format';
import type { LengthUnit } from '@wewin/core/units';
import type { Locale } from './locales';

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
}

const formattersCache = new Map<Locale, Formatters>();

/** The formatters for one locale. Memoised — `Intl` construction is not cheap. */
export function formattersFor(locale: Locale): Formatters {
  const cached = formattersCache.get(locale);
  if (cached) return cached;

  const created: Formatters = {
    locale,

    baht: (minor) => formatMoney(locale, minor, 'THB', 'whole'),

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
