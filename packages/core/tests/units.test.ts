import { describe, expect, test } from 'vitest';
import {
  LENGTH_UNITS,
  MICRONS_PER_UNIT,
  fromMicrons,
  isOnGridUm,
  snapUpUm,
  toMicrons,
} from '../src/units.js';

/*
 * Canonical length is an integer count of micrometres (plan 4.1).
 *
 * The reason is a single number: gcd(5 mm, 1/8 in) = gcd(5000 µm, 3175 µm) = 25 µm.
 * Millimetres cannot hold both grids, and every one of the catalogue's 48 authored
 * min/max/default slots sits on the 5 mm grid while none sits on the inch grid — so a
 * millimetre canonical would change real sizes the moment anyone switched to inches.
 */
describe('the unit table', () => {
  test('covers the five units the brief named', () => {
    expect([...LENGTH_UNITS].sort()).toEqual(['cm', 'ft', 'in', 'm', 'mm'].sort());
  });

  test('every unit is a whole number of micrometres, imperial included', () => {
    // An inch is defined as exactly 25.4 mm, so nothing here is an approximation.
    expect(MICRONS_PER_UNIT).toEqual({
      mm: 1_000n,
      cm: 10_000n,
      m: 1_000_000n,
      in: 25_400n,
      ft: 304_800n,
    });
  });

  test('the grid that motivated micrometres', () => {
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    const fiveMm = 5n * MICRONS_PER_UNIT.mm;
    const eighthInch = MICRONS_PER_UNIT.in / 8n;

    expect(fiveMm).toBe(5_000n);
    expect(eighthInch).toBe(3_175n);
    expect(gcd(fiveMm, eighthInch)).toBe(25n);
  });
});

describe('toMicrons', () => {
  test('converts each unit exactly', () => {
    expect(toMicrons(320.5, 'cm')).toBe(3_205_000n);
    expect(toMicrons(5, 'mm')).toBe(5_000n);
    expect(toMicrons(2.2, 'm')).toBe(2_200_000n);
    expect(toMicrons(1, 'in')).toBe(25_400n);
    expect(toMicrons(1, 'ft')).toBe(304_800n);
  });

  test('an eighth of an inch is exact, not 3174.999', () => {
    expect(toMicrons(0.125, 'in')).toBe(3_175n);
    expect(toMicrons(1.375, 'in')).toBe(34_925n);
  });

  test('rounds to the nearest micrometre rather than carrying float dust', () => {
    // 0.1 + 0.2 territory: the input is a float and cannot always be exact.
    expect(toMicrons(0.30000000000000004, 'cm')).toBe(3_000n);
  });

  test('refuses input that is not a finite number', () => {
    expect(() => toMicrons(Number.NaN, 'cm')).toThrow();
    expect(() => toMicrons(Number.POSITIVE_INFINITY, 'cm')).toThrow();
  });
});

describe('fromMicrons — display only', () => {
  test('metric round-trips exactly, which is why authoring stays metric', () => {
    for (const microns of [3_205_000n, 5_000n, 2_200_000n, 605_000n]) {
      for (const unit of ['mm', 'cm', 'm'] as const) {
        expect(toMicrons(fromMicrons(microns, unit), unit)).toBe(microns);
      }
    }
  });

  test('imperial round-trips too — converting is not where sizes get lost', () => {
    // 3,205,000 µm is 126.181102… inches, an unbounded decimal, yet a double carries
    // enough significant digits at catalogue magnitudes to land back on the micrometre.
    const microns = 3_205_000n;
    const asInches = fromMicrons(microns, 'in');

    expect(asInches).toBeCloseTo(126.1811, 4);
    expect(toMicrons(asInches, 'in')).toBe(microns);
  });

  test('SNAPPING to the inch grid is where a size moves — hence the display-only rule', () => {
    /*
     * The hazard plan 4.1 describes is not conversion, it is re-snapping. A 320 cm
     * window is authored on the 5 mm grid and sits nowhere on the eighth-inch grid, so
     * anything that "tidies" it while inches are on screen silently rebuilds it larger.
     */
    const authored = toMicrons(320, 'cm');
    const eighthInch = MICRONS_PER_UNIT.in / 8n;

    expect(authored).toBe(3_200_000n);
    expect(authored % eighthInch).not.toBe(0n); // off the imperial grid, like all 48 slots

    const snappedUp = ((authored + eighthInch - 1n) / eighthInch) * eighthInch;
    expect(snappedUp).toBe(3_200_400n); // the exact number the plan warns about
    expect(snappedUp - authored).toBe(400n); // 0.4 mm nobody asked for

    // Switching units must therefore be presentation only: `fromMicrons` never writes.
    expect(toMicrons(fromMicrons(authored, 'in'), 'in')).toBe(authored);
  });

  test('renders a whole unit as a whole number', () => {
    expect(fromMicrons(304_800n, 'ft')).toBe(1);
    expect(fromMicrons(25_400n, 'in')).toBe(1);
    expect(fromMicrons(1_000_000n, 'm')).toBe(1);
  });
});

/*
 * Grid primitives.
 *
 * Kept apart from the catalogue so the question "what grid does a value typed in
 * inches snap to" gets answered deliberately, rather than by whatever falls out of
 * converting `snapToStep` to bigint during the migration.
 */
describe('snapUpUm', () => {
  test('snaps up, never down — spec section 6', () => {
    // A window built slightly large can be trimmed on site; one built small cannot.
    expect(snapUpUm(3_200_001n, 5_000n)).toBe(3_205_000n);
    expect(snapUpUm(3_199_999n, 5_000n)).toBe(3_200_000n);
  });

  test('leaves a value already on the grid exactly where it is', () => {
    // The float version needed an EPSILON here, because (x - min) / step came out as
    // 3.0000000001 and ceil took it to the next step. Integers make that impossible.
    expect(snapUpUm(3_200_000n, 5_000n)).toBe(3_200_000n);
    expect(snapUpUm(0n, 5_000n)).toBe(0n);
  });

  test('the eighth-inch grid, for a value typed in inches', () => {
    expect(snapUpUm(3_200_000n, 3_175n)).toBe(3_200_400n);
    expect(snapUpUm(25_400n, 3_175n)).toBe(25_400n); // a whole inch is on it
  });

  test('both grids are whole multiples of the canonical unit', () => {
    expect(5_000n % 25n).toBe(0n);
    expect(3_175n % 25n).toBe(0n);
  });
});

describe('isOnGridUm', () => {
  test('is exact, with no tolerance to tune', () => {
    expect(isOnGridUm(3_200_000n, 5_000n)).toBe(true);
    expect(isOnGridUm(3_200_000n, 3_175n)).toBe(false);
    expect(isOnGridUm(3_200_400n, 3_175n)).toBe(true);
  });
});
