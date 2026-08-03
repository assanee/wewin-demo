import { describe, expect, test } from 'vitest';
import { products } from '../src/data/catalog.js';
import { formatLength, formatMeasure, rendersExactlyIn } from '../src/format.js';
import {
  EIGHTH_INCH_UM,
  LENGTH_UNITS,
  type LengthUnit,
  fromMicrons,
  gridUmFor,
  isOnGridUm,
  parseMeasure,
  toMicrons,
} from '../src/units.js';
import type { CustomGroup } from '../src/types/catalog.js';

/*
 * The invariant the whole micrometre phase exists for (plan 4.1, migration order §4.2).
 *
 * Every other test in this suite fixes one function's behaviour. This one fixes the
 * property those functions were chosen to give the product: a size a customer entered
 * is theirs, and looking at it in another unit is looking, not editing.
 *
 * It sweeps the real catalogue rather than a fixture, because the claim is about the
 * 162 authored measurement groups and not about an example. The 16 distinct size
 * profiles behind them are deduplicated — sweeping the same six numbers 32 times only
 * makes the run slower, not the proof stronger.
 */

const customGroups = (): CustomGroup[] =>
  products.flatMap((product) =>
    product.groups.filter((group): group is CustomGroup => group.kind === 'custom'),
  );

/** One representative per distinct set of bounds. Nothing here depends on the label. */
function sizeProfiles(): CustomGroup[] {
  const byBounds = new Map<string, CustomGroup>();
  for (const group of customGroups()) {
    const key = `${group.minUm}:${group.maxUm}:${group.stepUm}:${group.defaultUm}`;
    if (!byBounds.has(key)) byBounds.set(key, group);
  }
  return [...byBounds.values()];
}

/** Every mark a value typed in `unit` can land on, inside this group's range. */
function marks(group: CustomGroup, unit: LengthUnit): bigint[] {
  const grid = gridUmFor(unit, group.stepUm);
  const found: bigint[] = [];
  // The grid is anchored at absolute zero, not at `min` — see D3. The first mark is
  // therefore the first multiple of the grid at or above the minimum, which for the
  // imperial grid is not the minimum itself.
  for (let um = ((group.minUm + grid - 1n) / grid) * grid; um <= group.maxUm; um += grid) {
    found.push(um);
  }
  return found;
}

describe('a canonical length survives every display unit', () => {
  test('converting an authored bound out and back returns the same micrometre', () => {
    let checked = 0;

    for (const group of sizeProfiles()) {
      for (const um of [group.minUm, group.maxUm, group.defaultUm]) {
        for (const unit of LENGTH_UNITS) {
          // `fromMicrons` is the display conversion and `toMicrons` the entry one. If
          // the pair were not an identity, merely rendering a field in feet and reading
          // it back would resize the window.
          expect(toMicrons(fromMicrons(um, unit), unit)).toBe(um);
          checked += 1;
        }
      }
    }

    // Non-vacuous: a broken `sizeProfiles` returning nothing would otherwise pass.
    expect(checked).toBe(16 * 3 * 5);
  });

  test('what the field shows reads back as exactly what it was showing', () => {
    /*
     * The round trip that matters is not the numeric one above, it is the one through
     * the screen: `formatLength` renders, the customer clicks in and out, and
     * `parseMeasure` reads the untouched text back. Anything this loses is a size
     * destroyed by a stray click, which is the failure the phase was opened over.
     *
     * Stated per unit over that unit's own entry grid, because that is the set of
     * values the unit can express. A metric size shown in inches lands between marks
     * and is not claimed to survive — it is marked `≈`, and pinned as such below.
     */
    let checked = 0;

    for (const group of sizeProfiles()) {
      for (const unit of LENGTH_UNITS) {
        for (const um of marks(group, unit)) {
          expect(parseMeasure(formatLength(um, unit), unit, group)).toBe(um);
          checked += 1;
        }
      }
    }

    // Pinned rather than floored: the size of the sweep is a fact about the catalogue
    // (16 profiles × 5 units × every mark in range), so a floor would let it be eroded
    // to a handful of points without anything saying so.
    expect(checked).toBe(57_490);
  });
});

describe('switching the display unit never re-snaps', () => {
  /** awn-4t's width: 320 cm, authored on the 5 mm grid like all 162 slots. */
  const group = sizeProfiles().find((candidate) => candidate.stepUm === 5_000n);
  if (!group) throw new Error('fixture missing');

  test('a thousand switches move the value by zero micrometres', () => {
    const authored = toMicrons(320, 'cm');
    let value = authored;
    const shown: string[] = [];

    for (let i = 0; i < 1_000; i += 1) {
      const unit = LENGTH_UNITS[i % LENGTH_UNITS.length];
      if (!unit) throw new Error('unreachable');
      // Switching units is a render. There is deliberately no assignment to `value`
      // here, and that absence is the thing under test: if a display unit change ever
      // acquires a write-back, this loop is where it would have to appear.
      shown.push(formatMeasure(value, unit));
    }

    expect(value).toBe(3_200_000n);
    expect(value - authored).toBe(0n);
    expect(new Set(shown).size).toBe(5); // all five renderings were actually produced
  });

  test('320 cm becomes 3,200,400 µm only when a human types it in inches', () => {
    const authored = toMicrons(320, 'cm');

    // The size sits nowhere on the eighth-inch grid, so inches cannot show it exactly.
    expect(isOnGridUm(authored, EIGHTH_INCH_UM)).toBe(false);
    expect(rendersExactlyIn(authored, 'in')).toBe(false);
    expect(formatMeasure(authored, 'in')).toBe('≈126"');

    // Looking at it in inches leaves it alone...
    expect(toMicrons(fromMicrons(authored, 'in'), 'in')).toBe(authored);

    // ...but typing that same `126` in, which is entry and not display, is a new size
    // on the imperial grid. 400 µm larger, and correctly so: the customer asked for
    // 126 inches. This is the one path allowed to move the value.
    expect(parseMeasure('126', 'in', group)).toBe(3_200_400n);
    expect(parseMeasure('126', 'in', group)).not.toBe(authored);

    // Typing it back in the unit it is displayed in is not a change at all.
    expect(parseMeasure(formatLength(authored, 'cm'), 'cm', group)).toBe(authored);
  });

  test('no authored bound sits on the imperial grid, so the hazard is universal', () => {
    // If even one did, a test that only sampled that group would pass while the
    // property was broken everywhere else.
    const bounds = customGroups().flatMap((candidate) => [
      candidate.minUm,
      candidate.maxUm,
      candidate.defaultUm,
    ]);

    expect(bounds).toHaveLength(162 * 3);
    expect(bounds.filter((um) => isOnGridUm(um, EIGHTH_INCH_UM))).toEqual([]);
    expect(bounds.every((um) => isOnGridUm(um, 5_000n))).toBe(true);
  });
});
