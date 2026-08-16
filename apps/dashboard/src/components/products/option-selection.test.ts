import { describe, expect, it } from 'vitest';
import type { AdminOptionGroupWire } from '@wewin/contract';

import { encodeUm } from '@wewin/contract/measure';

import {
  REQUIRED_CUSTOM_CODES,
  choicesFromProduct,
  optionWrites,
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
    expect(found[0]?.field).toBe('stepText');
    expect(found[0]?.messageTh).toContain('จำนวนเท่าของ');
  });

  it('⛔ refuses a min that is not on the zero-anchored grid', () => {
    /* step 0.5 cm, min 60.3 cm — 603000 µm is not divisible by 5000. */
    expect(problems({ min: '60.3' }).map((p) => p.messageTh).join(' ')).toContain('ค่าต่ำสุดต้องลงตัวกับสเต็ป');
  });

  it('⛔ refuses a max that is not a whole number of steps above min', () => {
    expect(problems({ max: '400.3' }).map((p) => p.messageTh).join(' ')).toContain('ค่าสูงสุดต้องห่างจากค่าต่ำสุด');
  });

  it('⛔ refuses a default off the min-anchored grid', () => {
    expect(problems({ def: '180.3' }).map((p) => p.messageTh).join(' ')).toContain('ค่าเริ่มต้นต้องห่างจากค่าต่ำสุด');
  });

  it('refuses a default outside the range, and says that rather than the grid', () => {
    const found = problems({ def: '500' });
    expect(found.map((p) => p.messageTh).join(' ')).toContain('ต้องอยู่ระหว่าง');
    expect(found.map((p) => p.messageTh).join(' ')).not.toContain('จำนวนเท่าของสเต็ป');
  });

  it('refuses zero and negative bounds', () => {
    expect(problems({ min: '0' }).map((p) => p.messageTh).join(' ')).toContain('ค่าต่ำสุดต้องมากกว่า 0');
    expect(problems({ step: '0' }).map((p) => p.messageTh).join(' ')).toContain('สเต็ปต้องมากกว่า 0');
  });

  it('⚠️ accepts min equal to max — a product offered in exactly one size is legal', () => {
    /*
     * Both layers use `<=`: the DB says `min_um <= max_um`, core says
     * `if (group.minUm > group.maxUm) fail(...)`. Refusing it here would refuse something
     * the server accepts, which is the worse of the two ways to disagree.
     */
    expect(problems({ min: '180', max: '180', def: '180' })).toStrictEqual([]);
  });

  it('⭐ names the BOX, so the control that is wrong is the one that turns red', () => {
    /*
     * The reason this returns objects rather than sentences. A person filling eight boxes
     * across two groups had to read a paragraph at the foot of the page and work out which
     * of the eight it meant.
     */
    expect(problems({ min: '60.3' })[0]?.field).toBe('minText');
    expect(problems({ max: '400.3' })[0]?.field).toBe('maxText');
    expect(problems({ def: '500' })[0]?.field).toBe('defaultText');
    expect(problems({ step: '0.001' })[0]?.field).toBe('stepText');
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

  it('⭐ addresses each refusal to the box that can fix it, keyed by group', () => {
    /*
     * The exact case from the screenshot that prompted this: a default below the minimum,
     * in both required groups. Before, it was one sentence at the foot of a long page
     * naming neither box.
     */
    const result = buildOptions(
      [
        measured('width', { minText: '30', maxText: '100', stepText: '10', defaultText: '20' }),
        measured('height', { minText: '30', maxText: '120', stepText: '10', defaultText: '20' }),
      ],
      GROUPS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors['width']?.defaultText).toContain('ต้องอยู่ระหว่าง');
    expect(result.errors['height']?.defaultText).toContain('ต้องอยู่ระหว่าง');
    /* And nothing else is marked — the other three boxes in each group are fine. */
    expect(Object.keys(result.errors['width'] ?? {})).toStrictEqual(['defaultText']);
  });

  it('⚠️ one box shows one message, not a paragraph', () => {
    /* A field with several faults gets the first; the rest reappear as they are fixed. */
    const result = buildOptions([measured('width', { minText: 'x' })], GROUPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.values(result.errors['width'] ?? {}).every((m) => !m.includes('·'))).toBe(true);
  });

  it('marks a sku group on the control that is wrong', () => {
    const colour = sku('profile_color', ['SG', 'WH']);
    const empty: GroupChoice = { ...blankChoice(colour), offered: true };
    const noDefault: GroupChoice = {
      ...blankChoice(colour),
      offered: true,
      valueCodes: ['SG'],
      defaultValueCode: 'WH',
    };

    const a = buildOptions([...BOTH, empty], [...GROUPS, colour]);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors['profile_color']?.valueCodes).toBeDefined();

    const b = buildOptions([...BOTH, noDefault], [...GROUPS, colour]);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors['profile_color']?.defaultValueCode).toBeDefined();
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

/* ------------------------------------------------------------------ *
 * Editing a draft that already has options
 * ------------------------------------------------------------------ */

const skuGroupWire = (code: string, codes: readonly string[], defaultValue: string) =>
  ({
    kind: 'sku' as const,
    code,
    labelTh: code,
    input: 'chip' as const,
    required: true as const,
    includeInSkuCode: true,
    values: codes.map((c) => ({ code: c, labelTh: c, delta: { type: 'none' as const }, available: true })),
    defaultValue,
  });

const customGroupWire = (code: string, min: string, max: string, step: string, def: string) =>
  ({
    kind: 'custom' as const,
    code,
    labelTh: code,
    input: 'number' as const,
    unit: 'cm' as const,
    minUm: encodeUm(toUm(min, 'cm') as bigint),
    maxUm: encodeUm(toUm(max, 'cm') as bigint),
    stepUm: encodeUm(toUm(step, 'cm') as bigint),
    defaultUm: encodeUm(toUm(def, 'cm') as bigint),
  });

describe('seeding the editor from a draft that already has options', () => {
  it('⭐ shows the numbers back as the text a person would have typed', () => {
    const seeded = choicesFromProduct(
      [customGroupWire('width', '60', '400', '0.5', '180')],
      [custom('width'), custom('height')],
    );

    const width = seeded.find((choice) => choice.code === 'width');
    expect(width?.offered).toBe(true);
    expect(width?.minText).toBe('60');
    expect(width?.stepText).toBe('0.5');
    expect(width?.defaultText).toBe('180');
    /* A catalogue group the product does not offer comes back unticked and empty. */
    expect(seeded.find((choice) => choice.code === 'height')?.offered).toBe(false);
  });

  it('carries a sku group’s offered values and its default', () => {
    const seeded = choicesFromProduct(
      [skuGroupWire('profile_color', ['SG', 'BK'], 'BK')],
      [sku('profile_color', ['SG', 'WH', 'BK'])],
    );
    const colour = seeded.find((choice) => choice.code === 'profile_color');
    expect(colour?.valueCodes).toStrictEqual(['SG', 'BK']);
    expect(colour?.defaultValueCode).toBe('BK');
  });

  it('⚠️ keeps a group the catalogue no longer lists rather than dropping it', () => {
    /*
     * Dropping it would delete the product's option on the very next save, silently. The
     * cost of being wrong in this direction is a group nobody can remove from this screen;
     * in the other direction it is a product that quietly stops being configurable.
     */
    const seeded = choicesFromProduct([customGroupWire('legacy', '10', '20', '1', '10')], []);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.code).toBe('legacy');
    expect(seeded[0]?.offered).toBe(true);
  });
});

describe('planning the writes a save has to make', () => {
  const current = [customGroupWire('width', '60', '400', '0.5', '180')];
  const wantedSame = {
    width: {
      kind: 'custom' as const,
      sortOrder: 0,
      minUm: encodeUm(600_000n),
      maxUm: encodeUm(4_000_000n),
      stepUm: encodeUm(5_000n),
      defaultUm: encodeUm(1_800_000n),
    },
  };

  it('⭐ writes nothing when nothing changed', () => {
    /*
     * Re-putting every group would work and would also move `documentHash` on a save that
     * changed nothing — turning a no-op into an edit that collides with a colleague's.
     */
    expect(optionWrites(current, wantedSame)).toStrictEqual([]);
  });

  it('puts the group whose numbers moved', () => {
    const moved = {
      width: { ...wantedSame.width, defaultUm: encodeUm(2_000_000n) },
    };
    const writes = optionWrites(current, moved);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('put');
    expect(writes[0]?.code).toBe('width');
  });

  it('⚠️ treats a reorder as a change, because order is what the configurator shows', () => {
    const reordered = { width: { ...wantedSame.width, sortOrder: 3 } };
    expect(optionWrites(current, reordered)).toHaveLength(1);
  });

  it('⛔ puts before deletes, so a rename never leaves the draft unpublishable', () => {
    /*
     * `productSchema` runs on every mutation, not only at publish. Deleting `width` first —
     * even to add it straight back — is refused outright by the server.
     */
    const writes = optionWrites(current, {
      height: { ...wantedSame.width, sortOrder: 0 },
    });
    expect(writes.map((write) => write.kind)).toStrictEqual(['put', 'delete']);
    expect(writes[0]?.code).toBe('height');
    expect(writes[1]?.code).toBe('width');
  });

  it('deletes a group that is no longer offered', () => {
    const writes = optionWrites(current, {});
    expect(writes).toStrictEqual([{ kind: 'delete', code: 'width' }]);
  });
});
