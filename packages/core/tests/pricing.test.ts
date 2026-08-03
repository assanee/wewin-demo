import { describe, expect, test } from 'vitest';
import { calcPrice } from '../src/pricing.js';
import { getProductById } from '../src/data/products.js';
import type { Product } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const awn = (
  selections: Record<string, string>,
  width: number,
  height: number,
  qty: number,
) => calcPrice(product('awn-4t'), selections, { width, height }, qty);

/* ------------------------------------------------------------------ *
 * Spec section 5 — the six cases that must all pass
 * ------------------------------------------------------------------ */

describe('calcPrice — spec test cases', () => {
  test('case 1: awn-4t 320x160 DW/GRN/T5/NS0 qty 2 -> 18432', () => {
    const price = awn(
      { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      320,
      160,
      2,
    );

    expect(price.areaSqm).toBeCloseTo(5.12, 6);
    expect(price.billableSqm).toBeCloseTo(5.12, 6);
    expect(price.base).toBeCloseTo(7680, 6);
    expect(price.percentTotal).toBeCloseTo(614.4, 6);
    expect(price.perSqmTotal).toBeCloseTo(921.6, 6);
    expect(price.flatTotal).toBeCloseTo(0, 6);
    expect(price.unitPrice).toBeCloseTo(9216, 6);
    expect(price.total).toBe(18432);
  });

  test('case 2: awn-4t 80x60 falls back to minBillableSqm 1.5 -> 2250', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      80,
      60,
      1,
    );

    expect(price.areaSqm).toBeCloseTo(0.48, 6);
    expect(price.billableSqm).toBe(1.5);
    expect(price.unitPrice).toBeCloseTo(2250, 6);
    expect(price.total).toBe(2250);
  });

  test('case 3: awn-4t 200x150 BK/LAM/NS1 combines percent + per_sqm + flat -> 8475', () => {
    const price = awn(
      { profile_color: 'BK', glass_color: 'CLR', glass_thickness: 'LAM', insect_screen: 'NS1' },
      200,
      150,
      1,
    );

    expect(price.areaSqm).toBeCloseTo(3, 6);
    expect(price.base).toBeCloseTo(4500, 6);
    expect(price.percentTotal).toBeCloseTo(225, 6);
    expect(price.perSqmTotal).toBeCloseTo(1950, 6);
    expect(price.flatTotal).toBeCloseTo(1800, 6);
    expect(price.total).toBe(8475);
  });

  test('case 4: lvr-adj-3 300x200 DW/B150/MOT -> 27552', () => {
    const price = calcPrice(
      product('lvr-adj-3'),
      { profile_color: 'DW', blade_width: 'B150', control: 'MOT' },
      { width: 300, height: 200 },
      1,
    );

    expect(price.areaSqm).toBeCloseTo(6, 6);
    expect(price.base).toBeCloseTo(14400, 6);
    expect(price.percentTotal).toBeCloseTo(1152, 6);
    expect(price.perSqmTotal).toBeCloseTo(0, 6);
    expect(price.flatTotal).toBeCloseTo(12000, 6);
    expect(price.total).toBe(27552);
  });

  test('case 5: lvr-adj-3 300x200 SG/B100/MAN qty 3 -> percent is 0 for a none delta', () => {
    const price = calcPrice(
      product('lvr-adj-3'),
      { profile_color: 'SG', blade_width: 'B100', control: 'MAN' },
      { width: 300, height: 200 },
      3,
    );

    expect(price.base).toBeCloseTo(14400, 6);
    expect(price.percentTotal).toBe(0);
    expect(price.perSqmTotal).toBeCloseTo(1080, 6);
    expect(price.unitPrice).toBeCloseTo(15480, 6);
    expect(price.total).toBe(46440);
  });

  test('case 6: sld-2p 180x220 WH/CLR/T6/LK1 -> 8791 (rounded from 8791.2)', () => {
    const price = calcPrice(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
      { width: 180, height: 220 },
      1,
    );

    expect(price.areaSqm).toBeCloseTo(3.96, 6);
    expect(price.base).toBeCloseTo(8316, 6);
    expect(price.perSqmTotal).toBeCloseTo(475.2, 6);
    expect(price.unitPrice).toBeCloseTo(8791.2, 6);
    expect(price.total).toBe(8791);
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
      200,
      150,
      1,
    );

    expect(price.percentTotal).toBeCloseTo(225, 6);
  });

  test('per_sqm uses billableSqm, not the raw area, when the minimum kicks in', () => {
    // 80x60 = 0.48 sqm, billable 1.5. GRN at 180/sqm.
    // Raw area would give 86.40; billable gives 270.
    const price = awn(
      { profile_color: 'SG', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      80,
      60,
      1,
    );

    expect(price.perSqmTotal).toBeCloseTo(270, 6);
  });

  test('flat deltas are per unit and multiply with qty', () => {
    const one = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS1' },
      200,
      150,
      1,
    );
    const four = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS1' },
      200,
      150,
      4,
    );

    expect(one.flatTotal).toBeCloseTo(1800, 6);
    expect(four.flatTotal).toBeCloseTo(1800, 6);
    expect(four.total).toBe(one.total * 4);
  });

  test('rounds once at the end, so qty x unit never accumulates per-unit rounding error', () => {
    // 180x220 sld-2p unit price is 8791.2 -> three units is 26373.6 -> 26374.
    // Rounding each unit first would give 8791 * 3 = 26373.
    const price = calcPrice(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
      { width: 180, height: 220 },
      3,
    );

    expect(price.total).toBe(26374);
  });
});

/* ------------------------------------------------------------------ *
 * Breakdown lines — spec section 7 renders these in the accordion
 * ------------------------------------------------------------------ */

describe('calcPrice — breakdown lines', () => {
  test('leads with the area base line, then one line per charging option', () => {
    const price = awn(
      { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5', insect_screen: 'NS0' },
      320,
      160,
      2,
    );

    expect(price.lines).toEqual([
      { label: 'ราคาฐานตามพื้นที่', amount: 7680 },
      { label: 'สีโปรไฟล์อะลูมิเนียม · ลายไม้เข้ม', amount: 614.4 },
      { label: 'สีกระจก · สีเขียว', amount: 921.6 },
    ]);
  });

  test('omits options that add nothing, so the accordion shows only real charges', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      200,
      150,
      1,
    );

    expect(price.lines).toEqual([{ label: 'ราคาฐานตามพื้นที่', amount: 4500 }]);
  });

  test('line amounts sum to unitPrice', () => {
    const price = awn(
      { profile_color: 'BK', glass_color: 'BLU', glass_thickness: 'LAM', insect_screen: 'NS1' },
      200,
      150,
      1,
    );

    const sum = price.lines.reduce((acc, line) => acc + line.amount, 0);
    expect(sum).toBeCloseTo(price.unitPrice, 6);
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

    const withDefaults = awn({}, 320, 160, 1);
    const explicit = awn(explicitDefaults, 320, 160, 1);

    expect(withDefaults.total).toBe(explicit.total);
    expect(withDefaults.total).toBeGreaterThan(0);
  });

  test('treats a missing measurement as its group default rather than producing NaN', () => {
    const price = calcPrice(
      product('awn-4t'),
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      { width: 320 },
      1,
    );

    expect(Number.isNaN(price.total)).toBe(false);
    expect(price.areaSqm).toBeCloseTo(5.12, 6);
  });

  test('never returns NaN or -0 for a zero quantity', () => {
    const price = awn(
      { profile_color: 'SG', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      320,
      160,
      0,
    );

    expect(price.total).toBe(0);
    expect(Object.is(price.total, -0)).toBe(false);
  });

  test('ignores an unknown option code instead of throwing', () => {
    const price = awn(
      { profile_color: 'NOPE', glass_color: 'CLR', glass_thickness: 'T5', insect_screen: 'NS0' },
      320,
      160,
      1,
    );

    expect(price.percentTotal).toBe(0);
    expect(price.total).toBe(7680);
  });
});
