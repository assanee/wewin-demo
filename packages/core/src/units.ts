/**
 * Lengths.
 *
 * Canonical is an integer count of **micrometres**. The reason is one number:
 *
 *     gcd(5 mm, 1/8 in) = gcd(5000 µm, 3175 µm) = 25 µm
 *
 * A millimetre canonical cannot express both the metric grid the catalogue is authored
 * on and the imperial grid a customer might type in. Every one of the 48 authored
 * min/max/default slots sits on the 5 mm grid and none sits on the inch grid, so with
 * millimetres, switching the display unit and clicking away would move a real window
 * from 3,200,000 µm to 3,200,400 µm — a change nobody asked for and nobody would see.
 *
 * Which leads to the rule this module exists to make possible:
 *
 *   **Switching the display unit is presentation. It must never write a value back.**
 *
 * `fromMicrons` is for showing a number to a person. Only `toMicrons`, called on a value
 * a person actually typed, may produce a new canonical length.
 */

export const LENGTH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;

export type LengthUnit = (typeof LENGTH_UNITS)[number];

/**
 * Whether an untrusted string names a unit.
 *
 * Both places a unit crosses a boundary — a share link and a stored quote — need
 * this, and each writing its own `includes` check is how one of them ends up
 * accepting `'inch'` while the other does not.
 */
export const isLengthUnit = (value: unknown): value is LengthUnit =>
  typeof value === 'string' && (LENGTH_UNITS as readonly string[]).includes(value);

/**
 * Micrometres in one of each unit. All exact: the inch has been defined as precisely
 * 25.4 mm since 1959, so the imperial entries are conversions, not approximations.
 */
export const MICRONS_PER_UNIT: Record<LengthUnit, bigint> = {
  mm: 1_000n,
  cm: 10_000n,
  m: 1_000_000n,
  in: 25_400n,
  ft: 304_800n,
};

/**
 * A typed value to canonical micrometres.
 *
 * The input is a `number` because it came from a keyboard, so it carries whatever float
 * error the parse gave it; rounding to the nearest micrometre is what turns it back into
 * an exact quantity. At 1 µm resolution that rounding is far below anything a workshop
 * can cut, so it discards noise rather than meaning.
 */
export function toMicrons(value: number, unit: LengthUnit): bigint {
  if (!Number.isFinite(value)) {
    throw new RangeError(`toMicrons: value must be finite, got ${String(value)}`);
  }

  return BigInt(Math.round(value * Number(MICRONS_PER_UNIT[unit])));
}

/**
 * Canonical micrometres to a number for display. **Display only.**
 *
 * Metric round-trips exactly. Imperial does not and cannot: 3,205,000 µm is
 * 126.181102… inches, which no decimal recovers. That asymmetry is not a defect to fix
 * — it is the reason the display unit is never allowed to write back.
 */
export function fromMicrons(microns: bigint, unit: LengthUnit): number {
  return Number(microns) / Number(MICRONS_PER_UNIT[unit]);
}

/**
 * The eighth of an inch a value typed in imperial snaps to.
 *
 * Not a millimetre-equivalent approximation: it is exactly 3,175 µm, and 3175 is a
 * whole multiple of the 25 µm canonical step — which is the entire reason the canonical
 * unit is micrometres and not millimetres.
 */
export const EIGHTH_INCH_UM = MICRONS_PER_UNIT.in / 8n;

/**
 * The lattice both grids sit on: gcd(5 mm, 1/8 in) = 25 µm.
 *
 * A lattice, not a grid — nothing ever snaps to it. Snapping at 25 µm would produce
 * 47.550197 in, which no tape measure can read. Its only job is to be a whole
 * divisor of both the metric step and the eighth of an inch, which is what lets a
 * value typed in either unit survive being displayed in the other. The catalogue
 * schema checks every authored step against it, so a step that broke the property
 * would fail at boot rather than as an unrepeatable measurement months later.
 */
export const LATTICE_UM = 25n;

/**
 * Snap **up** to the next multiple of `gridUm`.
 *
 * Up, never down, and not negotiable (spec section 6): a window built slightly large
 * can be trimmed on site, one built small is scrap.
 *
 * The float version of this needed an epsilon, because `(value - min) / step` came back
 * as 3.0000000001 for a value already sitting on a step and `Math.ceil` pushed it to the
 * next one. With integers that case is arithmetic, not luck, so the tolerance is gone
 * rather than ported — plan 4.1 asks for exactly that.
 */
export function snapUpUm(valueUm: bigint, gridUm: bigint): bigint {
  if (gridUm <= 0n) throw new RangeError('snapUpUm: gridUm must be positive');
  const remainder = valueUm % gridUm;
  return remainder === 0n ? valueUm : valueUm + (gridUm - remainder);
}

/** Whether a length sits exactly on a grid. Exact, with no tolerance to tune. */
export function isOnGridUm(valueUm: bigint, gridUm: bigint): boolean {
  if (gridUm <= 0n) throw new RangeError('isOnGridUm: gridUm must be positive');
  return valueUm % gridUm === 0n;
}

/**
 * Square micrometres in one square metre.
 *
 * Area is `widthUm × heightUm` with no division anywhere, so this is the only place
 * the m² a price list is quoted in enters the arithmetic. It lives here rather than
 * in `pricing.ts` because it is a fact about units, and the rule builders need the
 * same figure to express an area threshold.
 */
export const SQ_UM_PER_SQM = 1_000_000_000_000n;

/**
 * An area written in square metres, in canonical square micrometres.
 *
 * The build-time counterpart of `toMicrons`, and the only one: a price floor in the
 * catalogue and an area threshold in a rule are the same conversion, and two copies
 * of it is two chances to write the wrong number of zeros.
 *
 * Scaled in two steps rather than one because `sqm * 1e12` leaves the exactly
 * representable range at 9,007 m², while `sqm * 1e6` is exact for any figure anyone
 * would write and the second factor is applied in bigint.
 */
export const sqmToSqUm = (sqm: number): bigint =>
  BigInt(Math.round(sqm * 1_000_000)) * (SQ_UM_PER_SQM / 1_000_000n);

/**
 * The grid a value *typed in `unit`* snaps to.
 *
 * Two grids, one lattice. Metric entry follows the catalogue's own step; imperial
 * entry follows the eighth of an inch, because that is the finest mark on the tape
 * the customer is holding. Snapping imperial entry to the 5 mm metric step would
 * turn a typed 98⅛ in into 98.2283 in, which cannot be typed again.
 */
export function gridUmFor(unit: LengthUnit, metricGridUm: bigint): bigint {
  return unit === 'in' || unit === 'ft' ? EIGHTH_INCH_UM : metricGridUm;
}

/**
 * Feet, a whole part, and a vulgar fraction, in any combination the notation allows:
 * `320.5`, `82 1/2"`, `3/8"`, `4' 3 1/2"`, `4'`.
 *
 * Every part is optional, so the caller has to reject a match in which all of them
 * are — an empty string satisfies this pattern.
 */
const MEASURE_TEXT =
  /^(?:(\d+(?:\.\d+)?)\s*')?\s*(\d+(?:\.\d+)?)?(?:\s*(\d+)\s*\/\s*(\d+))?\s*"?$/;

/**
 * The one way a typed string becomes a canonical length.
 *
 * It reads back exactly what `formatLength` writes, imperial fractions included, and
 * that is not a convenience. The input shows the rendering of the current value, so
 * anything this cannot re-read is a value the customer destroys by clicking into the
 * field and back out — the one thing plan 4.1 says must never happen.
 *
 * Returns `null` rather than throwing on anything unreadable: every caller reaches
 * this from an input event, and clearing the field and tabbing away must fall back to
 * a default rather than throw from inside a blur handler.
 *
 * A negative reading has no notation here and so cannot be typed; the pattern simply
 * does not match one. That is deliberate — `snapUpUm` on a negative rounds *towards*
 * zero and would hand back a plausible small window.
 */
export function parseMeasure(
  text: string,
  unit: LengthUnit,
  group: { stepUm: bigint },
): bigint | null {
  const match = MEASURE_TEXT.exec(text.trim());
  if (!match) return null;

  const [, feet, whole, numerator, denominator] = match;
  if (feet === undefined && whole === undefined && numerator === undefined) return null;

  // A foot mark makes everything after it inches, whatever unit the field is in:
  // `4' 3 1/2"` means the same thing typed into a field labelled ft or in.
  const restUnit: LengthUnit = feet === undefined ? unit : 'in';

  let value = whole === undefined ? 0 : Number(whole);
  if (numerator !== undefined && denominator !== undefined) {
    const divisor = Number(denominator);
    if (divisor === 0) return null;
    value += Number(numerator) / divisor;
  }

  const um =
    (feet === undefined ? 0n : toMicrons(Number(feet), 'ft')) + toMicrons(value, restUnit);

  return snapUpUm(um, gridUmFor(unit, group.stepUm));
}
