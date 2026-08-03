import { describe, expect, test } from 'vitest';
import { snapToStep, validate } from '../src/validation.js';
import { getProductById } from '../src/data/products.js';
import { toMicrons } from '../src/units.js';
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

/**
 * The sizes below stay written the way the spec and the price list write them, and
 * this turns them into the canonical micrometres the catalogue is built from — the
 * same `cm()` the product table uses. Spelling `3_200_000n` in forty-odd places would
 * make a wrong zero a size six metres out with nothing next to it to compare against.
 * Snapped and boundary results are still pinned as µm literals, because there the
 * exact integer is the thing under test.
 */
const cm = (value: number): bigint => toMicrons(value, 'cm');

const ids = (product: Product, selections: Record<string, string>, measures: Record<string, bigint>) =>
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
    expect(
      ids(product('awn-4t'), { ...AWN_OK, glass_thickness: 'LAM' }, { width: cm(260), height: cm(160) }),
    ).toEqual(['awn4t-lam-width']);
  });

  test('case 2: awn-4t 400x250 exceeds the 8 sqm area cap', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(400), height: cm(250) })).toEqual(['awn4t-max-area']);
  });

  test('case 3: awn-4t 400x220 (8.80 sqm) exceeds the area cap', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(400), height: cm(220) })).toEqual(['awn4t-max-area']);
  });

  test('case 4: awn-4t height 160.3 is off the 0.5 step and snaps up to 160.5', () => {
    const issues = validate(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160.3) });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.ruleId).toBe('step:height');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.affects).toEqual(['height']);
    expect(snapToStep(customGroup('awn-4t', 'height'), cm(160.3), 'cm')).toBe(1_605_000n);
  });

  test('case 5: lvr-adj-3 at 120 cm is too narrow for the motor', () => {
    expect(
      ids(
        product('lvr-adj-3'),
        { profile_color: 'DW', blade_width: 'B150', control: 'MOT' },
        { width: cm(120), height: cm(200) },
      ),
    ).toEqual(['lvr3-motor-min']);
  });

  test('case 6: sld-2p 180x260 with LAM warns but does not block', () => {
    const issues = validate(
      product('sld-2p'),
      { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'LAM', lock_type: 'LK1' },
      { width: cm(180), height: cm(260) },
    );

    expect(issues.map((issue) => issue.ruleId)).toEqual(['sld2-lam-height']);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false);
  });

  test('case 7: a fully valid awn-4t configuration reports nothing', () => {
    expect(validate(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(160) })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Multiple simultaneous issues — what spec case 3 was reaching for
 * ------------------------------------------------------------------ */

describe('validate — multiple issues at once', () => {
  test('reports every failing rule, not just the first', () => {
    const issues = ids(
      product('awn-4t'),
      { ...AWN_OK, glass_thickness: 'LAM' },
      { width: cm(400), height: cm(250) },
    );

    expect(issues).toContain('awn4t-max-area');
    expect(issues).toContain('awn4t-lam-width');
    expect(issues).toHaveLength(2);
  });

  test('reports a range error and a cross-field error together', () => {
    const issues = ids(
      product('awn-4t'),
      { ...AWN_OK, glass_thickness: 'LAM' },
      { width: cm(460), height: cm(100) },
    );

    expect(issues).toContain('range:width'); // 460 > max 400
    expect(issues).toContain('awn4t-ratio'); // 460 / 100 = 4.6
    expect(issues).toContain('awn4t-lam-width'); // LAM above 200 cm
  });
});

/* ------------------------------------------------------------------ *
 * The ratio rule, now that it is a cross-multiplication
 *
 * `w/h > 3` became `w > 3h` when the AST lost its `div` node. Integer division
 * would have silenced the rule for every ratio in [3, 4) — 4,600,000n / 1,000,000n
 * is 4n, but 3,400,000n / 1,000,000n is 3n, and 3n > 3n is false. These two pin the
 * boundary from both sides so the rewrite cannot regress into a truncating divide.
 * ------------------------------------------------------------------ */

describe('validate — awn4t-ratio boundary', () => {
  test('fires inside the range a truncating divide would have swallowed', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(340), height: cm(100) })).toEqual(['awn4t-ratio']);
  });

  test('stays quiet at exactly 3:1, because the limit is 3:1 and not below it', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(300), height: cm(100) })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Range rules — derived from CustomGroup min/max/step, not written in rules[]
 * ------------------------------------------------------------------ */

describe('validate — derived range rules', () => {
  test('flags a measurement below the minimum', () => {
    const issues = validate(product('awn-4t'), AWN_OK, { width: cm(40), height: cm(160) });

    expect(issues.map((issue) => issue.ruleId)).toContain('range:width');
    expect(issues.find((issue) => issue.ruleId === 'range:width')?.severity).toBe('error');
  });

  test('flags a measurement above the maximum', () => {
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(320), height: cm(300) })).toContain('range:height');
  });

  test('accepts the exact boundary values', () => {
    // sld-2p height range is 180-280, width 120-500. 120x180 = 2.16 sqm, no rules apply.
    expect(
      validate(
        product('sld-2p'),
        { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' },
        { width: cm(120), height: cm(180) },
      ),
    ).toEqual([]);
  });

  test('accepts a half-centimetre value sitting on the step grid', () => {
    // Was "without float noise": the old code needed an epsilon here because
    // (320.5 - 60) / 0.5 came back as 521.0000000000001. On integers being on the
    // grid is 3_205_000n % 5_000n === 0n, so there is no tolerance left to test.
    expect(ids(product('awn-4t'), AWN_OK, { width: cm(320.5), height: cm(160.5) })).toEqual([]);
  });

  test('does not raise a step warning on top of a range error for the same field', () => {
    // 40.3 is both below min and off-step; the customer only needs the actionable one.
    const issues = ids(product('awn-4t'), AWN_OK, { width: cm(40.3), height: cm(160) });

    expect(issues).toContain('range:width');
    expect(issues).not.toContain('step:width');
  });
});

describe('snapToStep', () => {
  test('snaps up to the nearest step above, per spec section 6', () => {
    const height = customGroup('awn-4t', 'height');

    expect(snapToStep(height, cm(160.3), 'cm')).toBe(1_605_000n);
    expect(snapToStep(height, cm(160.6), 'cm')).toBe(1_610_000n);
  });

  test('leaves an already-on-step value untouched', () => {
    const height = customGroup('awn-4t', 'height');

    expect(snapToStep(height, cm(160), 'cm')).toBe(1_600_000n);
    expect(snapToStep(height, cm(160.5), 'cm')).toBe(1_605_000n);
  });

  test('snaps a value typed in inches to the eighth, not to the metric step', () => {
    // The grid follows the unit the customer typed in, not the one the catalogue was
    // authored in: 1,600,000 µm is not a whole number of eighths (3,175 × 503 =
    // 1,597,025), so entry in inches lands on the next mark up. Snapping imperial
    // entry to the 5 mm step would hand back 98.2283 in, which cannot be typed again.
    expect(snapToStep(customGroup('awn-4t', 'height'), cm(160), 'in')).toBe(1_600_200n);
  });

  test('never snaps down, not even to keep the value inside the range', () => {
    // Was "clamps into range so snapping can never push past the maximum", which
    // asserted the old `Math.min(snapped, group.max)`. That min was a snap *down*
    // wearing a guard's clothes — the one direction spec section 6 forbids, because a
    // window built short is scrap. Snapping is now pure rounding-up; keeping a value
    // inside the range is `validate`'s job, and it reports rather than adjusts.
    const height = customGroup('awn-4t', 'height'); // 60-250

    expect(snapToStep(height, cm(249.9), 'cm')).toBe(2_500_000n);
    expect(snapToStep(height, cm(400), 'cm')).toBe(4_000_000n);
    expect(snapToStep(height, cm(10), 'cm')).toBe(100_000n);
  });
});

/* ------------------------------------------------------------------ *
 * Overshooting the maximum
 *
 * Reachable only when the entry grid is imperial, since the schema forces every
 * authored maximum onto its own metric step. The 250 cm maximum is 787.4 eighths,
 * so anything above 3,175 × 787 = 2,498,725 µm is in range with no mark left to
 * round up to.
 * ------------------------------------------------------------------ */

describe('validate — no grid mark left below the maximum', () => {
  const overshoot = () =>
    validate(
      product('awn-4t'),
      AWN_OK,
      { width: cm(320), height: 2_499_000n },
      { height: 'in' },
    );

  test('is an error the customer resolves, not a warning the app resolves for them', () => {
    const issues = overshoot();

    expect(issues.map((issue) => issue.ruleId)).toEqual(['step:height']);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.affects).toEqual(['height']);
  });

  test('names the largest mark that fits, exactly, rather than the maximum', () => {
    // The maximum itself is 98.4252… in, which the eighth grid can only approximate;
    // advising it would be advising a value the customer cannot type back.
    const message = overshoot()[0]?.messageTh ?? '';

    expect(message).toContain('98 3/8"'); // 3,175 × 787 µm
    expect(message).not.toContain('≈');
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
    const issues = validate(product('awn-4t'), AWN_OK, { width: cm(400), height: cm(250) });
    const areaIssue = issues.find((issue) => issue.ruleId === 'awn4t-max-area');

    expect(areaIssue?.affects).toEqual(expect.arrayContaining(['width', 'height']));
  });

  test('carries the rule message and affected groups so the UI can highlight them', () => {
    const issues = validate(
      product('awn-4t'),
      { ...AWN_OK, glass_thickness: 'LAM' },
      { width: cm(260), height: cm(160) },
    );

    expect(issues[0]?.messageTh).toBe('กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm');
    expect(issues[0]?.affects).toEqual(expect.arrayContaining(['glass_thickness', 'width']));
  });
});
