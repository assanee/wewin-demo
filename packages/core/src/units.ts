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
