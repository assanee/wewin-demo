/**
 * Display formatters. Spec section 1 requires every on-screen number to pass
 * through one of these, and section 11 forbids NaN and -0 from ever appearing.
 *
 * Each formatter degrades to a sane zero rather than throwing: a pricing bug
 * should show a wrong price, not blank the page mid-configuration.
 */

import { divRoundHalfUp } from './money.js';
import {
  EIGHTH_INCH_UM,
  type LengthUnit,
  MICRONS_PER_UNIT,
  SQ_UM_PER_SQM,
} from './units.js';

const THAI_LOCALE = 'th-TH';

/** Replace non-finite input with 0 and collapse -0 to 0. */
const safe = (value: number): number => (Number.isFinite(value) ? value + 0 : 0);

/**
 * Thai baht, whole units. Quotes are never issued in satang.
 *
 * Takes minor units, because that is what money is in this codebase now. A formatter
 * that accepted baht would need a caller to divide first, and a division on the way to
 * the screen is exactly where a rounding decision hides from review.
 */
export function formatBaht(minor: bigint): string {
  // Normally already rounded to the whole baht upstream; rounding here too means a
  // caller that hands over raw satang still gets the same answer as everywhere else.
  const whole = divRoundHalfUp(minor, 100n);
  const magnitude = (whole < 0n ? -whole : whole).toLocaleString(THAI_LOCALE, {
    maximumFractionDigits: 0,
  });

  return whole < 0n ? `-฿${magnitude}` : `฿${magnitude}`;
}

/**
 * Square metres, always two decimals (spec section 5) — from a `number`.
 *
 * ⚠️ **Prefer `formatSqmExact` wherever the square micrometres are still in hand**, which
 * is everywhere a `PriceBreakdown` or a `price.line.base` param is. This overload exists
 * for the one honest case left: a stored snapshot that kept only the `number`.
 *
 * The two do not always agree, and it is not a rounding-mode difference that could be
 * settled by choosing one. `toFixed` operates on a `double`, and 21.255 m² is
 * 21.254999999999999449… once it has been through one — so this writes `21.25` where the
 * exact path writes `21.26`. Phase 6a had both on the same screen.
 */
export function formatSqm(value: number): string {
  return safe(value).toFixed(2);
}

/**
 * Square metres, two decimals, from an exact count of square micrometres.
 *
 * The one area formatter the screen should use. All `bigint`: `divRoundHalfUp` to the
 * hundredth and the point inserted by hand, so there is no `double` anywhere on the path
 * and the rounding rule is the same half-up the rest of the system uses for money.
 *
 * Not localised — this returns canonical digits with an ASCII point, exactly like
 * `formatLength`. `@wewin/i18n` substitutes glyphs afterwards; core does not know what a
 * locale is.
 */
export function formatSqmExact(sqUm: bigint): string {
  const hundredths = divRoundHalfUp(sqUm * 100n, SQ_UM_PER_SQM);
  const negative = hundredths < 0n;
  const magnitude = negative ? -hundredths : hundredths;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/* ------------------------------------------------------------------ *
 * Lengths
 *
 * The single exit from canonical micrometres. `toMicrons`/`parseMeasure` is the
 * single entrance; there is deliberately nothing in between.
 * ------------------------------------------------------------------ */

/**
 * Digits after the point that round-trip a micrometre in a metric unit.
 *
 * Derived rather than tabulated: mm, cm and m are all powers of ten of a
 * micrometre, so the digit count *is* the exponent, and a table could drift from it.
 */
const metricDecimals = (unit: LengthUnit): number =>
  String(MICRONS_PER_UNIT[unit]).length - 1;

/** Exact decimal, trailing zeros trimmed. All bigint — no float on this path. */
function formatMetric(um: bigint, unit: LengthUnit): string {
  const per = MICRONS_PER_UNIT[unit];
  const whole = um / per;
  const fraction = (um % per).toString().padStart(metricDecimals(unit), '0').replace(/0+$/, '');

  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** `8` → `''`, `2` → `' 1/4'`. Eighths reduced, because a tape reads 1/4 and not 2/8. */
function eighthsFraction(eighths: bigint): string {
  if (eighths === 0n) return '';
  if (eighths % 4n === 0n) return ' 1/2';
  if (eighths % 2n === 0n) return `${eighths === 2n ? ' 1/4' : ' 3/4'}`;
  return ` ${eighths.toString()}/8`;
}

/**
 * Imperial as a tape measure reads it: `82 1/2"`, `4' 3 1/2"`.
 *
 * Not `82.5"` and emphatically not `4.29'`, because the value only ever has to be
 * read back onto a saw. A value typed in inches has already snapped to the eighth,
 * so this is exact for anything the customer entered; a metric value shown in inches
 * lands between marks and is rounded to the nearest one — see `rendersExactlyIn`.
 */
function formatImperial(um: bigint, unit: LengthUnit): string {
  const eighths = divRoundHalfUp(um, EIGHTH_INCH_UM);

  // `3/8"`, not `0 3/8"` — the leading zero is not how the measurement is spoken,
  // and the step a field advances by is exactly the value that hits this case.
  const inchesPart = (whole: bigint, eighthsPart: bigint): string =>
    whole === 0n && eighthsPart !== 0n
      ? eighthsFraction(eighthsPart).trimStart()
      : `${whole.toString()}${eighthsFraction(eighthsPart)}`;

  if (unit === 'in') return `${inchesPart(eighths / 8n, eighths % 8n)}"`;

  const EIGHTHS_PER_FOOT = 96n;
  const feet = eighths / EIGHTHS_PER_FOOT;
  const rest = eighths % EIGHTHS_PER_FOOT;
  if (rest === 0n) return `${feet.toString()}'`;

  // `0' 1/8"` keeps its zero, unlike the inch case above. The foot mark is what tells
  // `parseMeasure` that what follows is inches, so dropping it in a field set to feet
  // would make the step this very function renders read back as an eighth of a *foot* —
  // a formatter whose output its own parser misreads, which is the one thing this pair
  // may not do. It shows up in the ± labels and the "ทีละ" line, never in a size.
  return `${feet.toString()}' ${inchesPart(rest / 8n, rest % 8n)}"`;
}

/**
 * A canonical length, in the unit asked for. The number only — no unit suffix for
 * metric, since the caller pairs it with a label it also uses on the input.
 */
export function formatLength(um: bigint, unit: LengthUnit): string {
  const magnitude = um < 0n ? -um : um;
  const rendered =
    unit === 'in' || unit === 'ft' ? formatImperial(magnitude, unit) : formatMetric(magnitude, unit);

  return um < 0n ? `-${rendered}` : rendered;
}

/**
 * Whether `formatLength` loses nothing rendering this value in this unit.
 *
 * The caller needs this to decide whether to prefix `≈`. 3,205,000 µm is
 * 126.181102… in, which no eighth recovers — showing that as `126 3/16"` without
 * saying so invites someone to type it back and move the window.
 */
export const rendersExactlyIn = (um: bigint, unit: LengthUnit): boolean =>
  unit === 'in' || unit === 'ft' ? um % EIGHTH_INCH_UM === 0n : true;

/**
 * The unit written out after the number — for metric only.
 *
 * `82 1/2"` already says inches; `82 1/2" in` says it twice and reads like a typo.
 */
const unitSuffix = (unit: LengthUnit): string =>
  unit === 'in' || unit === 'ft' ? '' : ` ${unit}`;

/**
 * A length ready to drop into a sentence: number, unit, and an `≈` when the unit
 * asked for cannot express the value.
 *
 * The marker is the whole reason this exists rather than callers concatenating. A
 * 400 cm maximum shown in inches is 157.48…", which the eighth grid renders as
 * `157 1/2"` — a number the customer can type but will not get back. Saying `≈157 1/2"`
 * is the difference between an approximation and a lie.
 */
export function formatMeasure(um: bigint, unit: LengthUnit): string {
  const marker = rendersExactlyIn(um, unit) ? '' : '≈';
  return `${marker}${formatLength(um, unit)}${unitSuffix(unit)}`;
}

/**
 * A closed range of lengths, e.g. `60–400 cm` or `≈23 5/8"–157 1/2"`.
 *
 * One `≈` for the pair rather than one each: if either bound is inexact in this unit
 * the range as a whole is approximate, and two markers in six characters reads as
 * noise the customer learns to ignore.
 */
export function formatRange(minUm: bigint, maxUm: bigint, unit: LengthUnit): string {
  const marker = rendersExactlyIn(minUm, unit) && rendersExactlyIn(maxUm, unit) ? '' : '≈';
  return `${marker}${formatLength(minUm, unit)}–${formatLength(maxUm, unit)}${unitSuffix(unit)}`;
}

/**
 * Plain counts and day ranges.
 *
 * The `safe` collapse happens **after** the round, not before. `Math.round(-0.2)` *produces*
 * `-0`, so collapsing the input leaves the output signed — and `toLocaleString` renders that
 * as `-0`, which spec section 11 forbids. It went unnoticed for two phases because nothing
 * fed this a small negative; phase 6a found it by routing the same value through `Intl` in
 * `@wewin/i18n`, where the identical mistake was reproduced from this line.
 */
export function formatInteger(value: number): string {
  return safe(Math.round(safe(value))).toLocaleString(THAI_LOCALE, { maximumFractionDigits: 0 });
}

/** Lead time as a range, e.g. "10–14 วัน". */
export function formatLeadTime([min, max]: [number, number]): string {
  return `${formatInteger(min)}–${formatInteger(max)} วัน`;
}

/** Dimensions as the configurator titles them, e.g. "320 × 160 cm", `82 1/2" × 63"`. */
export function formatDimensions(widthUm: bigint, heightUm: bigint, unit: LengthUnit): string {
  // Marked as a pair, the way a range is: either dimension being inexact in this unit
  // makes the size as a whole approximate, and a marker on only the second number
  // reads as if the first one were exact.
  const marker = rendersExactlyIn(widthUm, unit) && rendersExactlyIn(heightUm, unit) ? '' : '≈';
  return `${marker}${formatLength(widthUm, unit)} × ${formatLength(heightUm, unit)}${unitSuffix(unit)}`;
}
