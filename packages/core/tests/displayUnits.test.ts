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

/* ------------------------------------------------------------------ *
 * The tour
 *
 * Not a handful of examples: every size the catalogue can be configured to, taken
 * through all five display units and back to the one it started in. That is the
 * customer holding a tape in inches, checking the drawing in feet, and returning to
 * the centimetres the quote is written in — and it is the shape of the accident this
 * phase was opened over, because the size passes under five different renderings and
 * only one of them can say it exactly.
 * ------------------------------------------------------------------ */

/** Every size the customer can configure this group to — the group's own grid, end to end. */
function everySize(group: CustomGroup): bigint[] {
  const sizes: bigint[] = [];
  for (let um = group.minUm; um <= group.maxUm; um += group.stepUm) sizes.push(um);
  return sizes;
}

/**
 * One trip through every unit, starting at `from` and ending back where it began.
 *
 * Returns the value the page is holding after each of the six stops, rather than just
 * the last one. The endpoint alone would be the wrong thing to check: a size can be
 * wrong at three stops and right again at the sixth, and what the customer is shown —
 * and can add to a quote — is the value while the tour is under way.
 *
 * `writesBack` is MeasureInput's dirty flag, and it is the only difference between the
 * two policies below. False renders and leaves the value alone; true reads the field
 * back at every stop, the way a blur after a keystroke does. The rule of plan 4.1 is
 * that a unit switch is always the first and never the second, so modelling both here
 * is what lets the assertions say precisely what separates them.
 */
function tour(um: bigint, group: CustomGroup, from: number, writesBack: boolean): bigint[] {
  const itinerary: bigint[] = [];
  let current = um;

  for (let step = 0; step <= LENGTH_UNITS.length; step += 1) {
    const unit = LENGTH_UNITS[(from + step) % LENGTH_UNITS.length];
    if (!unit) throw new Error('unreachable');

    const shown = formatLength(current, unit);
    if (writesBack) current = parseMeasure(shown, unit, group) ?? current;
    itinerary.push(current);
  }

  return itinerary;
}

/**
 * lcm(5 mm, 1/8 in) — where the two entry grids coincide, at 63.5 cm.
 *
 * A size sitting on it is the only kind that survives being re-snapped in both, which
 * is what makes it the exact measure of the damage in the counterfactual below.
 */
const BOTH_GRIDS_UM = 635_000n;

describe('a size tours every display unit and comes back unmoved', () => {
  test('the sweep is the whole catalogue, not a sample of it', () => {
    // The 162 authored groups are 16 distinct sets of bounds; sweeping the same six
    // numbers 32 times would be slower, not stronger. This is the step that lets the
    // dedup be honest — every authored group has to be one of the 16.
    const profiles = new Set(
      sizeProfiles().map((group) => `${group.minUm}:${group.maxUm}:${group.stepUm}:${group.defaultUm}`),
    );

    expect(customGroups()).toHaveLength(162);
    expect(profiles.size).toBe(16);
    for (const group of customGroups()) {
      expect(profiles).toContain(
        `${group.minUm}:${group.maxUm}:${group.stepUm}:${group.defaultUm}`,
      );
    }
  });

  test('every configurable size holds still at every stop, from every starting unit', () => {
    let checked = 0;

    for (const group of sizeProfiles()) {
      for (const um of everySize(group)) {
        // From each of the five, because the preference is restored from storage and
        // the customer does not always start in the unit the catalogue was authored in.
        for (let from = 0; from < LENGTH_UNITS.length; from += 1) {
          for (const atStop of tour(um, group, from, false)) {
            expect(atStop).toBe(um);
            checked += 1;
          }
        }
      }
    }

    // 9,356 configurable sizes across the 16 profiles × 5 starting units × 6 stops.
    // Pinned, not floored: the count is a fact about the catalogue, and a floor would
    // let the sweep erode to a handful of points with nothing saying so.
    expect(checked).toBe(9_356 * 5 * 6);
  });

  test('with a write-back at each stop, the same tour disturbs all but 78 of them', () => {
    /*
     * The counterfactual, and the reason the test above is not vacuous. Everything is
     * identical except the flag: this is the tour a build takes if a unit switch is
     * allowed to commit what the field is showing — which is what the pre-phase blur
     * handler did, since it compared a parsed number against the value and found them
     * different on every render.
     *
     * The survivors are exactly the multiples of 63.5 cm, the 78 sizes where the metric
     * and imperial grids meet. Every other size in the catalogue is a window the
     * customer never touched, moved by up to a full 5 mm step.
     */
    let disturbed = 0;
    let onBothGrids = 0;
    let differsAtTheEnd = 0;
    let worstDrift = 0n;

    for (const group of sizeProfiles()) {
      for (const um of everySize(group)) {
        const itinerary = tour(um, group, 0, true);
        const moved = itinerary.filter((atStop) => atStop !== um);

        for (const atStop of moved) {
          const drift = atStop > um ? atStop - um : um - atStop;
          if (drift > worstDrift) worstDrift = drift;
        }

        if (moved.length > 0) disturbed += 1;
        else onBothGrids += 1;
        if (itinerary.at(-1) !== um) differsAtTheEnd += 1;

        // Exactly, in both directions: nothing off the shared grid survives, and
        // nothing on it is touched.
        expect(isOnGridUm(um, BOTH_GRIDS_UM)).toBe(moved.length === 0);
      }
    }

    expect(disturbed + onBothGrids).toBe(9_356);
    expect(onBothGrids).toBe(78);
    expect(disturbed).toBe(9_278);
    expect(worstDrift).toBe(5_000n); // a whole metric step, on a window nobody edited

    // And this is what makes it silent rather than merely wrong: half of the damaged
    // sizes are back at their original value by the last stop, so a before-and-after
    // comparison reports the catalogue intact while the customer was shown — and could
    // have added to a quote — a window 5 mm out.
    expect(differsAtTheEnd).toBe(4_647);
    expect(differsAtTheEnd).toBeLessThan(disturbed);
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
