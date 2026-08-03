import { describe, expect, test } from 'vitest';
import { optionStatesFor } from '../src/optionStates.js';
import { getProductById } from '../src/data/products.js';
import type { Product, SkuGroup } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

const AWN = {
  profile_color: 'SG',
  glass_color: 'CLR',
  glass_thickness: 'T5',
  insect_screen: 'NS0',
} as const;

const blockedCodes = (
  productId: string,
  groupCode: string,
  selections: Record<string, string>,
  measures: Record<string, number>,
): string[] => {
  const states = optionStatesFor(product(productId), selections, measures);
  return Object.entries(states[groupCode] ?? {})
    .filter(([, state]) => state.blocked)
    .map(([code]) => code);
};

describe('optionStatesFor — compatibility blocking', () => {
  test('blocks laminated glass once the width passes its 200 cm limit', () => {
    expect(blockedCodes('awn-4t', 'glass_thickness', AWN, { width: 260, height: 160 })).toEqual(['LAM']);
  });

  test('leaves every thickness selectable below the limit', () => {
    expect(blockedCodes('awn-4t', 'glass_thickness', AWN, { width: 180, height: 160 })).toEqual([]);
  });

  test('blocks the motor below its minimum width', () => {
    const selections = { profile_color: 'SG', blade_width: 'B150', control: 'MAN' };

    expect(blockedCodes('lvr-adj-3', 'control', selections, { width: 120, height: 200 })).toEqual(['MOT']);
  });

  test('reports the rule message as the reason, so the tooltip can explain itself', () => {
    const states = optionStatesFor(product('awn-4t'), AWN, { width: 260, height: 160 });

    expect(states['glass_thickness']?.['LAM']?.reasonTh).toBe(
      'กระจกสองชั้นรองรับความกว้างไม่เกิน 200 cm',
    );
  });

  test('keeps the currently selected value blocked when it is itself the problem', () => {
    // The customer picked LAM and then widened past 200 — LAM must show as struck
    // through rather than silently switching to something else.
    const selections = { ...AWN, glass_thickness: 'LAM' };

    expect(blockedCodes('awn-4t', 'glass_thickness', selections, { width: 260, height: 160 })).toEqual([
      'LAM',
    ]);
  });
});

describe('optionStatesFor — errors that belong to other fields', () => {
  test('an over-area error does not strike through unrelated colour options', () => {
    // 400x250 = 10 sqm, over the 8 sqm cap. That is a size problem, not a colour
    // problem: striking out every swatch would tell the customer the wrong thing.
    const measures = { width: 400, height: 250 };

    expect(blockedCodes('awn-4t', 'glass_color', AWN, measures)).toEqual([]);
    expect(blockedCodes('awn-4t', 'profile_color', AWN, measures)).toEqual([]);
    expect(blockedCodes('awn-4t', 'insect_screen', AWN, measures)).toEqual([]);
  });

  test('an over-area error still leaves thickness selectable when width is within limits', () => {
    expect(blockedCodes('awn-4t', 'glass_thickness', AWN, { width: 190, height: 250 })).toEqual([]);
  });
});

describe('optionStatesFor — warnings never block', () => {
  test('the laminated height warning leaves the option selectable', () => {
    const selections = { profile_color: 'WH', glass_color: 'CLR', glass_thickness: 'T6', lock_type: 'LK1' };
    const states = optionStatesFor(product('sld-2p'), selections, { width: 180, height: 260 });

    expect(states['glass_thickness']?.['LAM']?.blocked).toBe(false);
    expect(states['glass_thickness']?.['LAM']?.warnTh).toBe(
      'กระจกสองชั้นที่ความสูงเกิน 250 cm อาจต้องเสริมเสา ทีมงานจะยืนยันอีกครั้ง',
    );
  });
});

describe('optionStatesFor — stock', () => {
  test('blocks an option flagged unavailable, with a stock reason rather than a rule message', () => {
    const base = product('awn-4t');
    const groups = base.groups.map((group) =>
      group.kind === 'sku' && group.code === 'profile_color'
        ? ({
            ...group,
            values: group.values.map((value) =>
              value.code === 'BK' ? { ...value, available: false } : value,
            ),
          } satisfies SkuGroup)
        : group,
    );

    const states = optionStatesFor({ ...base, groups }, AWN, { width: 320, height: 160 });

    expect(states['profile_color']?.['BK']?.blocked).toBe(true);
    expect(states['profile_color']?.['BK']?.reasonTh).toBe('ตอนนี้สีนี้ยังไม่พร้อมผลิต');
  });
});

describe('optionStatesFor — shape', () => {
  test('covers every value of every sku group and ignores custom groups', () => {
    const states = optionStatesFor(product('awn-4t'), AWN, { width: 320, height: 160 });

    expect(Object.keys(states).sort()).toEqual([
      'glass_color',
      'glass_thickness',
      'insect_screen',
      'profile_color',
    ]);
    expect(Object.keys(states['glass_color'] ?? {})).toHaveLength(6);
  });

  test('blocks nothing when no option could break a rule at this size', () => {
    const states = optionStatesFor(product('awn-4t'), AWN, { width: 180, height: 160 });
    const anyBlocked = Object.values(states).some((group) =>
      Object.values(group).some((state) => state.blocked),
    );

    expect(anyBlocked).toBe(false);
  });

  test('at the default 320 cm width, laminated glass is already out of reach', () => {
    // The selection itself is valid, but LAM is not reachable from it. "Valid config"
    // and "every option available" are different things, and the panel must show it.
    const states = optionStatesFor(product('awn-4t'), AWN, { width: 320, height: 160 });

    expect(states['glass_thickness']?.['LAM']?.blocked).toBe(true);
    expect(states['glass_thickness']?.['T8']?.blocked).toBe(false);
    expect(states['glass_color']?.['GRN']?.blocked).toBe(false);
  });
});
