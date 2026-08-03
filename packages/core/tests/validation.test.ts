import { describe, expect, test } from 'vitest';
import { snapToStep, validate } from '../src/validation.js';
import { getProductById } from '../src/data/products.js';
import type { CustomGroup, Product } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const customGroup = (id: string, code: string): CustomGroup => {
  const found = product(id).groups.find(
    (group): group is CustomGroup => group.kind === 'custom' && group.code === code,
  );
  if (!found) throw new Error(`fixture missing: ${id}.${code}`);
  return found;
};

const ids = (product: Product, selections: Record<string, string>, measures: Record<string, number>) =>
  validate(product, selections, measures).map((issue) => issue.ruleId);

const AWN_OK = {
  profile_color: 'DW',
  glass_color: 'GRN',
  glass_thickness: 'T5',
  insect_screen: 'NS0',
} as const;

/* ------------------------------------------------------------------ *
 * Spec section 6 test cases
 *
 * Case 3 in the spec reads "awn-4t 400x120 -> awn4t-ratio and awn4t-max-area".
 * 400x120 is 4.8 sqm, so the 8 sqm rule cannot fire; the input was amended to
 * 400x220 (8.80 sqm). No awn-4t size can trip both rules at once, because
 * ratio > 3 and area > 8 together require width > 490 cm and the product caps
 * width at 400 cm. The simultaneous-errors case is covered separately below.
 * ------------------------------------------------------------------ */

describe('validate — spec test cases', () => {
  test('case 1: awn-4t 260x160 with LAM glass exceeds the laminated width limit', () => {
    expect(ids(product('awn-4t'), { ...AWN_OK, glass_thickness: 'LAM' }, { width: 260, height: 160 })).toEqual([
      'awn4t-lam-width',
    ]);
  });

  test('case 2: awn-4t 400x250 exceeds the 8 sqm area cap', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: 400, height: 250 })).toEqual(['awn4t-max-area']);
  });

  test('case 3: awn-4t 400x220 (8.80 sqm) exceeds the area cap', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: 400, height: 220 })).toEqual(['awn4t-max-area']);
  });

  test('case 4: awn-4t height 160.3 is off the 0.5 step and snaps up to 160.5', () => {
    const issues = validate(product('awn-4t'), AWN_OK, { width: 320, height: 160.3 });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.ruleId).toBe('step:height');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.affects).toEqual(['height']);
    expect(snapToStep(customGroup('awn-4t', 'height'), 160.3)).toBe(160.5);
  });

  test('case 5: lvr-adj-3 at 120 cm is too narrow for the motor', () => {
    expect(
      ids(product('lvr-adj-3'), { profile_color: 'DW', blade_width: 'B150', control: 'MOT' }, { width: 120, height: 200 }),
    ).toEqual(['lvr3-motor-min']);
  });

  test('case 6: sld-2p 180x260 with LAM warns but does not block', () => {
    const issues = validate(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'LAM', lock_type: 'LK1' },
      { width: 180, height: 260 },
    );

    expect(issues.map((issue) => issue.ruleId)).toEqual(['sld2-lam-height']);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false);
  });

  test('case 7: a fully valid awn-4t configuration reports nothing', () => {
    expect(validate(product('awn-4t'), AWN_OK, { width: 320, height: 160 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Multiple simultaneous issues — what spec case 3 was reaching for
 * ------------------------------------------------------------------ */

describe('validate — multiple issues at once', () => {
  test('reports every failing rule, not just the first', () => {
    const issues = ids(product('awn-4t'), { ...AWN_OK, glass_thickness: 'LAM' }, { width: 400, height: 250 });

    expect(issues).toContain('awn4t-max-area');
    expect(issues).toContain('awn4t-lam-width');
    expect(issues).toHaveLength(2);
  });

  test('reports a range error and a cross-field error together', () => {
    const issues = ids(product('awn-4t'), { ...AWN_OK, glass_thickness: 'LAM' }, { width: 460, height: 100 });

    expect(issues).toContain('range:width'); // 460 > max 400
    expect(issues).toContain('awn4t-ratio'); // 460 / 100 = 4.6
    expect(issues).toContain('awn4t-lam-width'); // LAM above 200 cm
  });
});

/* ------------------------------------------------------------------ *
 * Range rules — derived from CustomGroup min/max/step, not written in rules[]
 * ------------------------------------------------------------------ */

describe('validate — derived range rules', () => {
  test('flags a measurement below the minimum', () => {
    const issues = validate(product('awn-4t'), AWN_OK, { width: 40, height: 160 });

    expect(issues.map((issue) => issue.ruleId)).toContain('range:width');
    expect(issues.find((issue) => issue.ruleId === 'range:width')?.severity).toBe('error');
  });

  test('flags a measurement above the maximum', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: 320, height: 300 })).toContain('range:height');
  });

  test('accepts the exact boundary values', () => {
    // sld-2p height range is 180-280, width 120-500. 120x180 = 2.16 sqm, no rules apply.
    expect(
      validate(
        product('sld-2p'),
        { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
        { width: 120, height: 180 },
      ),
    ).toEqual([]);
  });

  test('accepts an on-step value without float noise', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: 320.5, height: 160.5 })).toEqual([]);
  });

  test('does not raise a step warning on top of a range error for the same field', () => {
    // 40.3 is both below min and off-step; the customer only needs the actionable one.
    const issues = ids(product('awn-4t'), AWN_OK, { width: 40.3, height: 160 });

    expect(issues).toContain('range:width');
    expect(issues).not.toContain('step:width');
  });
});

describe('snapToStep', () => {
  test('snaps up to the nearest step above, per spec section 6', () => {
    const height = customGroup('awn-4t', 'height');

    expect(snapToStep(height, 160.3)).toBe(160.5);
    expect(snapToStep(height, 160.6)).toBe(161);
  });

  test('leaves an already-on-step value untouched', () => {
    const height = customGroup('awn-4t', 'height');

    expect(snapToStep(height, 160)).toBe(160);
    expect(snapToStep(height, 160.5)).toBe(160.5);
  });

  test('clamps into range so snapping can never push past the maximum', () => {
    const height = customGroup('awn-4t', 'height'); // 60-250

    expect(snapToStep(height, 249.9)).toBe(250);
    expect(snapToStep(height, 400)).toBe(250);
    expect(snapToStep(height, 10)).toBe(60);
  });
});

/* ------------------------------------------------------------------ *
 * Defaults and defensive cases
 * ------------------------------------------------------------------ */

describe('validate — defaults', () => {
  test('every product ships with a valid default configuration', () => {
    for (const item of [product('awn-4t'), product('lvr-adj-3'), product('sld-2p')]) {
      expect(validate(item, {}, {})).toEqual([]);
    }
  });

  test('an area rule reports the measurements the area is derived from', () => {
    // `affects` drives which fields the UI marks. An area rule that names no field
    // leaves the dimension lines and the number inputs looking fine while the
    // configuration is unbuildable.
    const issues = validate(product('awn-4t'), AWN_OK, { width: 400, height: 250 });
    const areaIssue = issues.find((issue) => issue.ruleId === 'awn4t-max-area');

    expect(areaIssue?.affects).toEqual(expect.arrayContaining(['width', 'height']));
  });

  test('carries the rule message and affected groups so the UI can highlight them', () => {
    const issues = validate(product('awn-4t'), { ...AWN_OK, glass_thickness: 'LAM' }, { width: 260, height: 160 });

    expect(issues[0]?.messageTh).toBe('กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm');
    expect(issues[0]?.affects).toEqual(expect.arrayContaining(['glass_thickness', 'width']));
  });
});
