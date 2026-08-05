import { describe, expect, test } from 'vitest';
import { calcPrice } from '../src/pricing.js';
import { getProductById } from '../src/data/products.js';
import { toMicrons } from '../src/units.js';
import type { Product } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

/**
 * The sizes below are the ones the spec quotes, in the centimetres it quotes them in;
 * `calcPrice` takes canonical micrometres. Converting here rather than writing
 * `3_200_000n` keeps each case checkable against spec section 5 by eye, and routes
 * every test size through the same converter the catalogue itself uses — a second
 * hand-rolled `× 10_000` in a test file is how a test starts agreeing with itself.
 */
const cm = (value: number): bigint => toMicrons(value, 'cm');

const awn = (
  selections: Record<string, string>,
  widthUm: bigint,
  heightUm: bigint,
  qty: number,
) => calcPrice(product('awn-4t'), selections, { width: widthUm, height: heightUm }, qty);

/* ------------------------------------------------------------------ *
 * Spec section 5 — the six cases that must all pass
 * ------------------------------------------------------------------ */

describe('calcPrice — spec test cases', () => {
  test('case 1: awn-4t 320x160 DW/GRN/T5/NS0 qty 2 -> 18432', () => {
    const price = awn(
      { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(320),
      cm(160),
      2,
    );

    /*
     * Exact, not approximate. Area is now an integer count of µm² and `areaSqm` is
     * that integer divided by 10^12 once, for the screen. IEEE division is correctly
     * rounded and both operands are exact doubles, so the result *is* the double the
     * literal 5.12 parses to — there is no accumulated error left for an epsilon to
     * absorb, and tolerating one would hide a genuine scale error of a few parts per
     * million (the exact class of defect the µm² flip exists to make impossible).
     */
    expect(price.areaSqm).toBe(5.12);
    expect(price.billableSqm).toBe(5.12);
    expect(price.baseMinor).toBe(768000n);
    expect(price.percentTotalMinor).toBe(61440n);
    expect(price.perSqmTotalMinor).toBe(92160n);
    expect(price.flatTotalMinor).toBe(0n);
    expect(price.unitPriceMinor).toBe(921600n);
    expect(price.totalMinor).toBe(1843200n);
  });

  test('case 2: awn-4t 80x60 falls back to minBillableSqUm 1.5 sqm -> 2250', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(80),
      cm(60),
      1,
    );

    expect(price.areaSqm).toBe(0.48);
    expect(price.billableSqm).toBe(1.5);
    expect(price.unitPriceMinor).toBe(225000n);
    expect(price.totalMinor).toBe(225000n);
  });

  test('case 3: awn-4t 200x150 BK/LAM/NS1 combines percent + per_sqm + flat -> 8475', () => {
    const price = awn(
      { profile_color: 'BK', glass_color: 'CLR', glass_thickness: 'LAM', insect_screen: 'NS1' },
      cm(200),
      cm(150),
      1,
    );

    expect(price.areaSqm).toBe(3);
    expect(price.baseMinor).toBe(450000n);
    expect(price.percentTotalMinor).toBe(22500n);
    expect(price.perSqmTotalMinor).toBe(195000n);
    expect(price.flatTotalMinor).toBe(180000n);
    expect(price.totalMinor).toBe(847500n);
  });

  test('case 4: lvr-adj-3 300x200 DW/B150/MOT -> 27552', () => {
    const price = calcPrice(
      product('lvr-adj-3'),
      { profile_color: 'DW', blade_width: 'B150', control: 'MOT' },
      { width: cm(300), height: cm(200) },
      1,
    );

    expect(price.areaSqm).toBe(6);
    expect(price.baseMinor).toBe(1440000n);
    expect(price.percentTotalMinor).toBe(115200n);
    expect(price.perSqmTotalMinor).toBe(0n);
    expect(price.flatTotalMinor).toBe(1200000n);
    expect(price.totalMinor).toBe(2755200n);
  });

  test('case 5: lvr-adj-3 300x200 SG/B100/MAN qty 3 -> percent is 0 for a none delta', () => {
    const price = calcPrice(
      product('lvr-adj-3'),
      { profile_color: 'SG', blade_width: 'B100', control: 'MAN' },
      { width: cm(300), height: cm(200) },
      3,
    );

    expect(price.baseMinor).toBe(1440000n);
    expect(price.percentTotalMinor).toBe(0n);
    expect(price.perSqmTotalMinor).toBe(108000n);
    expect(price.unitPriceMinor).toBe(1548000n);
    expect(price.totalMinor).toBe(4644000n);
  });

  test('case 6: sld-2p 180x220 WH/CLR/T6/LK1 -> 8791 (rounded from 8791.2)', () => {
    const price = calcPrice(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
      { width: cm(180), height: cm(220) },
      1,
    );

    expect(price.areaSqm).toBe(3.96);
    expect(price.baseMinor).toBe(831600n);
    expect(price.perSqmTotalMinor).toBe(47520n);
    expect(price.unitPriceMinor).toBe(879120n);
    expect(price.totalMinor).toBe(879100n);
  });
});

/* ------------------------------------------------------------------ *
 * Ordering and rounding guarantees
 * ------------------------------------------------------------------ */

describe('calcPrice — calculation order', () => {
  test('percent is taken from base only, never from per_sqm or flat additions', () => {
    // 200x150 = 3 sqm. base 4500, BK percent 5 -> 225.
    // If percent were applied after per_sqm/flat it would be 5% of 4500+1950+1800 = 412.50.
    const price = awn(
      { profile_color: 'BK', glass_color: 'CLR', glass_thickness: 'LAM', insect_screen: 'NS1' },
      cm(200),
      cm(150),
      1,
    );

    expect(price.percentTotalMinor).toBe(22500n);
  });

  test('per_sqm uses billableSqm, not the raw area, when the minimum kicks in', () => {
    // 80x60 = 0.48 sqm, billable 1.5. GRN at 180/sqm.
    // Raw area would give 86.40; billable gives 270.
    const price = awn(
      { profile_color: 'SG', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(80),
      cm(60),
      1,
    );

    expect(price.perSqmTotalMinor).toBe(27000n);
  });

  test('flat deltas are per unit and multiply with qty', () => {
    const one = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS1' },
      cm(200),
      cm(150),
      1,
    );
    const four = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS1' },
      cm(200),
      cm(150),
      4,
    );

    expect(one.flatTotalMinor).toBe(180000n);
    expect(four.flatTotalMinor).toBe(180000n);
    expect(four.totalMinor).toBe(one.totalMinor * 4n);
  });

  test('rounds once at the end, so qty x unit never accumulates per-unit rounding error', () => {
    // 180x220 sld-2p unit price is 8791.2 -> three units is 26373.6 -> 26374.
    // Rounding each unit first would give 8791 * 3 = 26373.
    const price = calcPrice(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
      { width: cm(180), height: cm(220) },
      3,
    );

    expect(price.totalMinor).toBe(2637400n);
  });
});

/* ------------------------------------------------------------------ *
 * Breakdown lines — spec section 7 renders these in the accordion
 * ------------------------------------------------------------------ */

describe('calcPrice — breakdown lines', () => {
  test('leads with the area base line, then one line per charging option', () => {
    const price = awn(
      { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(320),
      cm(160),
      2,
    );

    // Was three joined Thai strings. Each row now names its parts, which is what makes
    // eight catalogues possible: the two option rows carry the group label and the
    // value label as separate catalogue references, so `·` — a typographic choice, not
    // content — belongs to the locale and not to `pricing.ts`.
    expect(price.lines).toEqual([
      {
        label: {
          key: 'price.line.base',
          params: { billableArea: { kind: 'area', sqUm: 5_120_000_000_000n } },
        },
        amountMinor: 768000n,
      },
      {
        label: {
          key: 'price.line.option',
          params: {
            group: {
              kind: 'catalogText',
              ref: { on: 'groupLabel', productId: 'awn-4t', groupCode: 'profile_color' },
              th: 'สีโปรไฟล์อะลูมิเนียม',
            },
            option: {
              kind: 'catalogText',
              ref: {
                on: 'optionLabel',
                productId: 'awn-4t',
                groupCode: 'profile_color',
                valueCode: 'DW',
              },
              th: 'ลายไม้เข้ม',
            },
          },
        },
        amountMinor: 61440n,
      },
      {
        label: {
          key: 'price.line.option',
          params: {
            group: {
              kind: 'catalogText',
              ref: { on: 'groupLabel', productId: 'awn-4t', groupCode: 'glass_color' },
              th: 'สีกระจก',
            },
            option: {
              kind: 'catalogText',
              ref: {
                on: 'optionLabel',
                productId: 'awn-4t',
                groupCode: 'glass_color',
                valueCode: 'GRN',
              },
              th: 'สีเขียว',
            },
          },
        },
        amountMinor: 92160n,
      },
    ]);
  });

  test('the base row carries the area it charged for, floor and all', () => {
    // 80 × 60 cm is 0.48 m², under awn-4t's 1.5 m² floor, so the base charge is for an
    // area nobody entered. The old label — "ราคาฐานตามพื้นที่" — could not say that in
    // any language; the row now carries the exact µm² the price was computed from.
    // This is the "threshold is an area" case: no length in sight, and no division on
    // the way out, so a locale rendering it in m² cannot move the number.
    const small = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(80),
      cm(60),
    1,
    );

    expect(small.lines[0]?.label).toEqual({
      key: 'price.line.base',
      params: { billableArea: { kind: 'area', sqUm: product('awn-4t').minBillableSqUm } },
    });
    // Not the ordered area — that is the whole point of the floor being visible.
    expect(small.lines[0]?.label.params).not.toEqual({
      billableArea: { kind: 'area', sqUm: cm(80) * cm(60) },
    });
  });

  test('omits options that add nothing, so the accordion shows only real charges', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(200),
      cm(150),
      1,
    );

    expect(price.lines).toEqual([
      {
        label: {
          key: 'price.line.base',
          params: { billableArea: { kind: 'area', sqUm: 3_000_000_000_000n } },
        },
        amountMinor: 450000n,
      },
    ]);
  });

  test('line amounts sum to unitPrice', () => {
    const price = awn(
      { profile_color: 'BK', glass_color: 'BLU', glass_thickness: 'LAM', insect_screen: 'NS1' },
      cm(200),
      cm(150),
      1,
    );

    // Exact now, so no epsilon: the breakdown accounts for the unit price to the satang.
    const sum = price.lines.reduce((acc, line) => acc + line.amountMinor, 0n);
    expect(sum).toBe(price.unitPriceMinor);
  });
});

/* ------------------------------------------------------------------ *
 * Defensive cases — spec section 11 requires no NaN and no -0 on screen
 * ------------------------------------------------------------------ */

describe('calcPrice — degenerate input', () => {
  test('uses group defaults when a selection is missing', () => {
    // Derived from the product rather than hardcoded, so changing a group's default
    // in products.ts cannot make this pass for the wrong reason.
    const explicitDefaults = Object.fromEntries(
      product('awn-4t')
        .groups.filter((group) => group.kind === 'sku')
        .map((group) => [group.code, group.defaultValue]),
    );

    const withDefaults = awn({}, cm(320), cm(160), 1);
    const explicit = awn(explicitDefaults, cm(320), cm(160), 1);

    expect(withDefaults.totalMinor).toBe(explicit.totalMinor);
    expect(withDefaults.totalMinor).toBeGreaterThan(0n);
  });

  test('treats a missing measurement as its group default rather than producing NaN', () => {
    const price = calcPrice(
      product('awn-4t'),
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      { width: cm(320) },
      1,
    );

    expect(price.totalMinor).toBeTypeOf('bigint');
    // The fallback is `defaultUm`, so the missing height is exactly 160 cm and the
    // area is exactly 5.12 m² — "not NaN" is no longer the strongest thing to say.
    expect(price.areaSqm).toBe(5.12);
  });

  test('never returns NaN or -0 for a zero quantity', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(320),
      cm(160),
      0,
    );

    // A bigint has no negative zero, so the "-0 on screen" defect the spec calls out
    // in section 11 is now unrepresentable rather than guarded against.
    expect(price.totalMinor).toBe(0n);
    expect(Object.is(Number(price.totalMinor), -0)).toBe(false);
  });

  test('ignores an unknown option code instead of throwing', () => {
    const price = awn(
      { profile_color: 'NOPE', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      cm(320),
      cm(160),
      1,
    );

    expect(price.percentTotalMinor).toBe(0n);
    expect(price.totalMinor).toBe(768000n);
  });
});
