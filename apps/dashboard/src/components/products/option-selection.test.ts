import { describe, expect, it } from 'vitest';
import type { AdminOptionGroupWire } from '@wewin/contract';

import {
  REQUIRED_CUSTOM_CODES,
  blankChoice,
  buildOptions,
  fromUm,
  measurementProblems,
  toUm,
  type GroupChoice,
} from './option-selection';

/**
 * ⛔ These tests carry the rules Postgres refuses with ONE sentence for all eight cases
 * (`product_version_options_grid`). If they drift from the server, the form starts refusing
 * things the server accepts, or — worse — accepting things it does not, and the person is
 * sent back to a generic message that names no field.
 */

const value = (code: string, swatchHex?: string) => ({
  code,
  labelTh: code,
  ...(swatchHex === undefined ? {} : { swatchHex }),
  delta: { type: 'none' } as const,
  available: true,
  sortOrder: 0,
});

const custom = (code: string, authoredUnit: 'cm' | 'mm' = 'cm'): AdminOptionGroupWire => ({
  code,
  kind: 'custom',
  labelTh: code === 'width' ? 'ความกว้าง' : 'ความสูง',
  input: 'number',
  includeInSkuCode: false,
  authoredUnit,
  values: [],
});

const sku = (
  code: string,
  codes: readonly string[],
  input: AdminOptionGroupWire['input'] = 'chip',
  swatched = true,
): AdminOptionGroupWire => ({
  code,
  kind: 'sku',
  labelTh: code,
  input,
  includeInSkuCode: true,
  values: codes.map((c) => value(c, input === 'swatch' && swatched ? '#123456' : undefined)),
});

/** A width/height pair that satisfies every rule — the baseline the cases below break. */
const measured = (code: string, over: Partial<GroupChoice> = {}): GroupChoice => ({
  ...blankChoice(custom(code)),
  offered: true,
  minText: '60',
  maxText: '400',
  stepText: '0.5',
  defaultText: '180',
  ...over,
});

const GROUPS = [custom('width'), custom('height')];
const BOTH = [measured('width'), measured('height')];

describe('converting a typed size to micrometres', () => {
  it('is exact at both authored units', () => {
    expect(toUm('0.5', 'cm')).toBe(5_000n);
    expect(toUm('180', 'cm')).toBe(1_800_000n);
    expect(toUm('180.05', 'cm')).toBe(1_800_500n);
    expect(toUm('0.5', 'mm')).toBe(500n);
    expect(toUm('25', 'mm')).toBe(25_000n);
  });

  it('refuses anything that is not a plain positive number', () => {
    for (const bad of ['1e3', '1,800', '-5', '', ' ', 'abc', '1.23456']) {
      expect(toUm(bad, 'cm'), bad).toBeNull();
    }
  });

  it('⚠️ refuses more precision than the unit carries rather than rounding it away', () => {
    /* Silently dropping a digit changes the size somebody typed. */
    expect(toUm('1.0001', 'cm')).toBe(10_001n);
    expect(toUm('1.0001', 'mm')).toBeNull();
  });

  it('round-trips back to what a person would type', () => {
    expect(fromUm(1_800_000n, 'cm')).toBe('180');
    expect(fromUm(1_805_000n, 'cm')).toBe('180.5');
    expect(fromUm(25n, 'cm')).toBe('0.0025');
  });
});

describe('the measurement grid, which the server answers with one sentence for eight faults', () => {
  const problems = (over: Partial<Record<'min' | 'max' | 'step' | 'def', string>>) => {
    const c = measured('width', {
      ...(over.min === undefined ? {} : { minText: over.min }),
      ...(over.max === undefined ? {} : { maxText: over.max }),
      ...(over.step === undefined ? {} : { stepText: over.step }),
      ...(over.def === undefined ? {} : { defaultText: over.def }),
    });
    return measurementProblems(
      'ความกว้าง',
      'cm',
      toUm(c.minText, 'cm'),
      toUm(c.maxText, 'cm'),
      toUm(c.stepText, 'cm'),
      toUm(c.defaultText, 'cm'),
    );
  };

  it('accepts a range that satisfies every rule', () => {
    expect(problems({})).toStrictEqual([]);
  });

  it('⛔ refuses a step off the 25 µm lattice, and says so alone', () => {
    /* 0.001 cm = 10 µm. Reporting the four consequences too would bury the cause. */
    const found = problems({ step: '0.001' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('จำนวนเท่าของ');
  });

  it('⛔ refuses a min that is not on the zero-anchored grid', () => {
    /* step 0.5 cm, min 60.3 cm — 603000 µm is not divisible by 5000. */
    expect(problems({ min: '60.3' }).join(' ')).toContain('ค่าต่ำสุดต้องลงตัวกับสเต็ป');
  });

  it('⛔ refuses a max that is not a whole number of steps above min', () => {
    expect(problems({ max: '400.3' }).join(' ')).toContain('ค่าสูงสุดต้องห่างจากค่าต่ำสุด');
  });

  it('⛔ refuses a default off the min-anchored grid', () => {
    expect(problems({ def: '180.3' }).join(' ')).toContain('ค่าเริ่มต้นต้องห่างจากค่าต่ำสุด');
  });

  it('refuses a default outside the range, and says that rather than the grid', () => {
    const found = problems({ def: '500' });
    expect(found.join(' ')).toContain('ต้องอยู่ระหว่าง');
    expect(found.join(' ')).not.toContain('จำนวนเท่าของสเต็ป');
  });

  it('refuses zero and negative bounds', () => {
    expect(problems({ min: '0' }).join(' ')).toContain('ค่าต่ำสุดต้องมากกว่า 0');
    expect(problems({ step: '0' }).join(' ')).toContain('สเต็ปต้องมากกว่า 0');
  });

  it('⚠️ accepts min equal to max — a product offered in exactly one size is legal', () => {
    /*
     * Both layers use `<=`: the DB says `min_um <= max_um`, core says
     * `if (group.minUm > group.maxUm) fail(...)`. Refusing it here would refuse something
     * the server accepts, which is the worse of the two ways to disagree.
     */
    expect(problems({ min: '180', max: '180', def: '180' })).toStrictEqual([]);
  });

  it('names the group, so a person with two size boxes knows which one broke', () => {
    expect(problems({ min: '60.3' })[0]).toMatch(/^ความกว้าง: /u);
  });
});

describe('building the options a create request carries', () => {
  it('emits width and height as custom groups in micrometres', () => {
    const result = buildOptions(BOTH, GROUPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.options)).toStrictEqual(['width', 'height']);
    const width = result.options['width'];
    expect(width?.kind).toBe('custom');
    if (width?.kind !== 'custom') return;
    expect(width.sortOrder).toBe(0);
    /* Opaque on the wire — compared by round-tripping, never by reading `.digits`. */
    expect(JSON.stringify(width.minUm)).toContain('600000');
    expect(JSON.stringify(width.stepUm)).toContain('5000');
  });

  it('⛔ refuses a product with no width or no height, naming the missing one', () => {
    for (const missing of REQUIRED_CUSTOM_CODES) {
      const kept = BOTH.filter((choice) => choice.code !== missing);
      const result = buildOptions(kept, GROUPS);
      expect(result.ok, missing).toBe(false);
      if (result.ok) continue;
      expect(result.problems.join(' ')).toContain(missing);
    }
  });

  it('⛔ refuses a sku group whose default is not among the values it offers', () => {
    /*
     * Checked in exactly one place on the server (core's `productSchema`) and returned as a
     * generic 422 with the real text buried in `details.issues[]`.
     */
    const colour = sku('profile_color', ['SG', 'WH', 'BK']);
    const choice: GroupChoice = {
      ...blankChoice(colour),
      offered: true,
      valueCodes: ['SG', 'WH'],
      defaultValueCode: 'BK',
    };

    const result = buildOptions([...BOTH, choice], [...GROUPS, colour]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('ค่าเริ่มต้น');
  });

  it('refuses a sku group with nothing ticked', () => {
    const colour = sku('profile_color', ['SG']);
    const choice: GroupChoice = { ...blankChoice(colour), offered: true };
    const result = buildOptions([...BOTH, choice], [...GROUPS, colour]);
    expect(result.ok).toBe(false);
  });

  it('⚠️ refuses a swatch group whose values have no colour, and says where to fix it', () => {
    /* `swatchHex` is on the shared option value — unfixable from the product form. */
    const colour = sku('profile_color', ['SG', 'WH'], 'swatch', false);
    const choice: GroupChoice = {
      ...blankChoice(colour),
      offered: true,
      valueCodes: ['SG'],
      defaultValueCode: 'SG',
    };

    const result = buildOptions([...BOTH, choice], [...GROUPS, colour]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('หน้าชุดตัวเลือก');
  });

  it('keeps catalogue order for values, not the order they were ticked', () => {
    const colour = sku('profile_color', ['SG', 'WH', 'BK']);
    const choice: GroupChoice = {
      ...blankChoice(colour),
      offered: true,
      valueCodes: ['BK', 'SG'],
      defaultValueCode: 'SG',
    };

    const result = buildOptions([...BOTH, choice], [...GROUPS, colour]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emitted = result.options['profile_color'];
    if (emitted?.kind !== 'sku') return;
    expect(emitted.valueCodes).toStrictEqual(['SG', 'BK']);
  });

  it('⛔ numbers the groups in the order the screen shows them, not catalogue order', () => {
    /*
     * `sortOrder` is what the configurator lays the groups out by. The editor shows กว้าง
     * first; if this numbered them in catalogue order the saved product would disagree with
     * the screen that made it — which is exactly what happened, and was only visible by
     * reading a created product back.
     */
    const catalogueOrder = [custom('height'), custom('width')];
    const result = buildOptions([measured('height'), measured('width')], catalogueOrder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options['width']?.sortOrder).toBe(0);
    expect(result.options['height']?.sortOrder).toBe(1);
  });

  it('a group left unticked is simply absent', () => {
    const colour = sku('profile_color', ['SG']);
    const result = buildOptions([...BOTH, blankChoice(colour)], [...GROUPS, colour]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.options)).toStrictEqual(['width', 'height']);
  });

  it('reports every problem at once rather than the first', () => {
    const result = buildOptions([measured('width', { stepText: 'x' })], GROUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    /* The missing height AND the unreadable step. */
    expect(result.problems.length).toBeGreaterThan(1);
  });
});
