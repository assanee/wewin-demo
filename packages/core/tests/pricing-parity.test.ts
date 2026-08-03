import { describe, expect, test } from 'vitest';
import { products } from '../src/data/catalog.js';
import { calcAreaSqUm, calcPrice } from '../src/pricing.js';
import { calcPrice as calcPriceV1 } from './baseline/pricing-v1.0.0.js';
import { SQ_UM_PER_SQM, fromMicrons, toMicrons } from '../src/units.js';
import type { CustomGroup, Product, SkuGroup } from '../src/types/catalog.js';

/*
 * The phase 1 gate.
 *
 * Plan section 2 sets a stronger bar for this phase than "the tests still pass":
 * every THB total must equal what v1.0.0 charged, compared against v1.0.0's own
 * `calcPrice` rather than against numbers someone transcribed. That file is vendored
 * verbatim under `tests/baseline/` for exactly this, and is never imported by src.
 *
 * A passing suite would not have caught a regression here — the new implementation
 * changed from float to exact integer arithmetic, and the interesting failures are
 * amounts that land within a rounding step of a boundary, which no hand-written
 * example would think to include.
 *
 * Phase 2 moved lengths to canonical micrometres and area to µm², which multiplied
 * the working scale by exactly 10^6 in both the numerator and the denominator. This
 * file is the proof that that was a no-op in baht: the sweep is generated in µm and
 * converted back to v1's centimetres only at the moment it is handed to the baseline.
 */

const customGroups = (product: Product): CustomGroup[] =>
  product.groups.filter((group): group is CustomGroup => group.kind === 'custom');

const skuGroups = (product: Product): SkuGroup[] =>
  product.groups.filter((group): group is SkuGroup => group.kind === 'sku');

/**
 * The catalogue as v1.0.0 knew how to read it.
 *
 * The baseline is vendored verbatim, so it still reaches for `minBillableSqm` in
 * square metres and for a custom group's `defaultValue` in the authored unit. Both
 * were renamed by the flip, and the failure mode of leaving them absent is silent:
 * `Math.max(area, undefined)` is `NaN`, and `NaN !== after` would be reported as a
 * pricing regression on all 160,740 comparisons rather than as a broken harness.
 *
 * Every field is derived from the live catalogue, so this cannot drift into being a
 * second, agreeing copy of the numbers under test.
 */
interface V1CustomGroup extends CustomGroup {
  /** Only ever read as the fallback for an absent measurement. */
  defaultValue: number;
}

interface V1Product extends Omit<Product, 'groups'> {
  /** v1 compared the floor against an area in m²; the flip holds it in µm². */
  minBillableSqm: number;
  groups: (SkuGroup | V1CustomGroup)[];
}

const asV1Product = (product: Product): V1Product => ({
  ...product,
  minBillableSqm: Number(product.minBillableSqUm) / Number(SQ_UM_PER_SQM),
  groups: product.groups.map((group) =>
    group.kind === 'custom'
      ? { ...group, defaultValue: fromMicrons(group.defaultUm, group.unit) }
      : group,
  ),
});

/** The same measurements, in the centimetres v1 took. Exact for every size below. */
const asV1Measures = (measures: Record<string, bigint>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(measures).map(([code, um]) => [code, fromMicrons(um, 'cm')]),
  );

/** Every option combination is far too many; one per value, against defaults, is enough. */
function selectionSweep(product: Product): Record<string, string>[] {
  const base: Record<string, string> = {};
  for (const group of skuGroups(product)) base[group.code] = group.defaultValue;

  const sweep = [base];
  for (const group of skuGroups(product)) {
    for (const value of group.values) {
      if (value.code === group.defaultValue) continue;
      sweep.push({ ...base, [group.code]: value.code });
    }
  }
  return sweep;
}

/** Sizes chosen to sit on the awkward parts of the range, not the comfortable middle. */
function sizeSweep(product: Product): Record<string, bigint>[] {
  const dims = customGroups(product);
  const width = dims.find((group) => group.code === 'width');
  const height = dims.find((group) => group.code === 'height');
  if (!width || !height) return [{}];

  const pick = (group: CustomGroup): bigint[] => {
    const steps = (group.maxUm - group.minUm) / group.stepUm;
    // The step nearest the midpoint. `Math.round` rounded a half-step up; bigint
    // division truncates, so the +1 restores that and the sweep keeps hitting the
    // same physical sizes it did before the flip — which is what pins `correctedUp`.
    const middle = group.minUm + ((steps + 1n) / 2n) * group.stepUm;

    return [
      group.minUm,
      group.minUm + group.stepUm,
      group.defaultUm,
      middle,
      group.maxUm - group.stepUm,
      group.maxUm,
    ];
  };

  const sizes: Record<string, bigint>[] = [];
  for (const w of pick(width)) {
    for (const h of pick(height)) sizes.push({ width: w, height: h });
  }
  return sizes;
}

/**
 * Recompute a line the way `calcPrice` does, but stop before rounding.
 *
 * Used only to classify a disagreement: it answers "what was the true price, to the
 * last digit" so a difference can be attributed rather than waved through.
 */
function exactScaledTotal(
  product: Product,
  selections: Record<string, string>,
  measures: Record<string, bigint>,
  qty: number,
): bigint {
  // µm × µm is µm² — the whole point of the flip is that there is no division here.
  const areaSqUm = (measures.width ?? 0n) * (measures.height ?? 0n);
  const floor = product.minBillableSqUm;
  const billable = areaSqUm > floor ? areaSqUm : floor;

  const base = billable * BigInt(product.pricePerSqm) * 100n;
  let total = base;

  for (const group of skuGroups(product)) {
    const code = selections[group.code] ?? group.defaultValue;
    const value = group.values.find((candidate) => candidate.code === code);
    if (!value) continue;

    if (value.delta.type === 'percent') total += (base * BigInt(value.delta.amount)) / 100n;
    if (value.delta.type === 'per_sqm') total += billable * BigInt(value.delta.amount) * 100n;
    if (value.delta.type === 'flat') total += BigInt(value.delta.amount) * 100n * SQ_UM_PER_SQM;
  }

  return total * BigInt(qty);
}

/**
 * One baht, in the scaled units `exactScaledTotal` returns.
 *
 * Named from the area constant rather than written as a literal: the scale a price
 * carries *is* the number of area units in one m², so if one moves and the other does
 * not, every remainder below is off by a factor of a million and the classification
 * quietly stops meaning anything.
 */
const SCALED_BAHT = 100n * SQ_UM_PER_SQM;

/** `JSON.stringify` throws on a bigint, so failure messages spell measures out. */
const describeMeasures = (measures: Record<string, bigint>): string =>
  Object.entries(measures)
    .map(([code, um]) => `${code}=${String(um)}um`)
    .join(' ');

describe('THB totals against v1.0.0', () => {
  test('agree everywhere except where v1 lost an exact half baht to float error', () => {
    const unexplained: string[] = [];
    let compared = 0;
    let correctedUp = 0;

    for (const product of products) {
      const v1Product = asV1Product(product);

      for (const selections of selectionSweep(product)) {
        for (const measures of sizeSweep(product)) {
          const v1Measures = asV1Measures(measures);

          for (const qty of [1, 2, 3, 7, 99]) {
            const before =
              BigInt(calcPriceV1(v1Product, selections, v1Measures, qty).total) * 100n;
            const after = calcPrice(product, selections, measures, qty).totalMinor;
            compared += 1;
            if (before === after) continue;

            /*
             * A disagreement is only acceptable if it is this exact shape: the true
             * price ends in precisely .50, half_up says round up, and v1's binary
             * arithmetic landed a sliver below and rounded down. Anything else — a
             * different gap, or a half that is not exact — is a real regression and
             * lands in `unexplained`.
             */
            const remainder = exactScaledTotal(product, selections, measures, qty) % SCALED_BAHT;
            const isTrueHalf = remainder === SCALED_BAHT / 2n;
            const isOneBahtHigher = after - before === 100n;

            if (isTrueHalf && isOneBahtHigher) {
              correctedUp += 1;
              continue;
            }

            unexplained.push(
              `${product.id} ${describeMeasures(measures)} ×${qty}: ` +
                `v1 ${String(before)} vs now ${String(after)} satang, remainder ${String(remainder)}`,
            );
          }
        }
      }
    }

    expect({ unexplained: unexplained.slice(0, 5), count: unexplained.length }).toEqual({
      unexplained: [],
      count: 0,
    });
    expect(compared).toBeGreaterThan(50_000);

    /*
     * Pinned, not tolerated. If a change makes this number move, that is a pricing
     * change and whoever made it has to say so out loud.
     */
    expect(correctedUp).toBe(87);
  });
});

describe('the spec totals from section 5 survive the rewrite', () => {
  /** The spec quotes centimetres; `calcPrice` takes canonical micrometres. */
  const cm = (value: number): bigint => toMicrons(value, 'cm');

  const cases: [string, Record<string, string>, Record<string, bigint>, number, bigint][] = [
    ['awn-4t', { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' }, { width: cm(320), height: cm(160) }, 2, 1_843_200n],
    ['sld-2p', {}, { width: cm(180), height: cm(220) }, 1, 879_100n],
  ];

  test.each(cases)('%s stays put', (id, selections, measures, qty, expected) => {
    const product = products.find((candidate) => candidate.id === id);
    if (!product) throw new Error(`fixture ${id} missing`);
    expect(calcPrice(product, selections, measures, qty).totalMinor).toBe(expected);
  });
});

describe('exactness the float version could not offer', () => {
  test('the unit price is not the total divided by quantity, and says so', () => {
    const product = products.find((candidate) => candidate.id === 'sld-2p');
    if (!product) throw new Error('fixture missing');

    const measures = { width: toMicrons(180, 'cm'), height: toMicrons(220, 'cm') };
    const one = calcPrice(product, {}, measures, 1);
    const three = calcPrice(product, {}, measures, 3);

    /*
     * Rounding once on the line, not once per unit — so these need not agree, and
     * anything that adds money must read totalMinor. sld-2p at 180×220 is the case
     * that shows it: ฿8,791.20 a unit renders as ฿8,791, but three of them are
     * ฿26,373.60 and bill as ฿26,374, not as 3 × ฿8,791.
     *
     * The old assertion here was `3n * one.unitPriceMinor > 0n ? three.totalMinor :
     * three.totalMinor`, which compares the line total to itself and holds for any
     * implementation whatsoever. Stated properly, the claim is that the two disagree
     * by a known amount.
     */
    expect(one.unitPriceMinor).toBe(879_120n);
    expect(3n * one.unitPriceMinor).not.toBe(three.totalMinor);
    expect(three.totalMinor).toBe(2_637_400n);
    expect(three.totalMinor % 100n).toBe(0n);
  });

  test('area is an exact integer count of square micrometres', () => {
    const product = products.find((candidate) => candidate.id === 'awn-4t');
    if (!product) throw new Error('fixture missing');

    // 320.5 cm × 160 cm = 3,205,000 µm × 1,600,000 µm = 5.128 × 10^12 µm², which is
    // 5.128 m². Re-pinned from the mm² era: the same physical window, and the same
    // digits, now with six more zeros and no division on the way there.
    expect(
      calcAreaSqUm(product, {
        width: toMicrons(320.5, 'cm'),
        height: toMicrons(160, 'cm'),
      }),
    ).toBe(5_128_000_000_000n);
  });
});
