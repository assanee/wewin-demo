import { describe, expect, test } from 'vitest';
import { buildSkuCode } from '../src/skuCode.js';
import { getProductById } from '../src/data/products.js';
import type { Product, SkuGroup } from '../src/types/catalog.js';

const product = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

describe('buildSkuCode', () => {
  test('joins the prefix and every sku group code in groups[] order', () => {
    const code = buildSkuCode(product('awn-4t'), {
      profile_color: 'DW',
      glass_color: 'GRN',
      glass_thickness: 'T5',
      insect_screen: 'NS0',
    });

    expect(code).toBe('AWN4T-DW-GRN-T5-NS0');
  });

  test('follows groups[] order, not the order keys appear in selections', () => {
    const code = buildSkuCode(product('awn-4t'), {
      insect_screen: 'NS1',
      glass_thickness: 'LAM',
      profile_color: 'BK',
      glass_color: 'CLR',
    });

    expect(code).toBe('AWN4T-BK-CLR-LAM-NS1');
  });

  test('uses each product own prefix and group set', () => {
    expect(
      buildSkuCode(product('lvr-adj-3'), {
        profile_color: 'DW',
        blade_width: 'B150',
        control: 'MOT',
      }),
    ).toBe('LVR3-DW-B150-MOT');

    expect(
      buildSkuCode(product('sld-2p'), {
        profile_color: 'WH',
        glass_color: 'CLR',
        glass_thickness: 'T6',
        lock_type: 'LK1',
      }),
    ).toBe('SLD2-WH-CLR-T6-LK1');
  });

  test('uppercases codes so a lowercase selection cannot produce a second sku for one variant', () => {
    const code = buildSkuCode(product('awn-4t'), {
      profile_color: 'dw',
      glass_color: 'grn',
      glass_thickness: 't5',
      insect_screen: 'ns0',
    });

    expect(code).toBe('AWN4T-DW-GRN-T5-NS0');
  });

  test('skips sku groups flagged includeInSkuCode: false', () => {
    const base = product('awn-4t');
    const groups = base.groups.map((group) =>
      group.kind === 'sku' && group.code === 'insect_screen'
        ? ({ ...group, includeInSkuCode: false } satisfies SkuGroup)
        : group,
    );

    const code = buildSkuCode({ ...base, groups }, {
      profile_color: 'DW',
      glass_color: 'GRN',
      glass_thickness: 'T5',
      insect_screen: 'NS1',
    });

    expect(code).toBe('AWN4T-DW-GRN-T5');
  });

  test('falls back to the group default when a selection is missing', () => {
    const code = buildSkuCode(product('awn-4t'), { profile_color: 'BK' });

    expect(code).toBe('AWN4T-BK-CLR-T5-NS0');
  });

  test('ignores custom groups entirely — measurements never create a new sku', () => {
    const code = buildSkuCode(product('awn-4t'), {
      profile_color: 'DW',
      glass_color: 'GRN',
      glass_thickness: 'T5',
      insect_screen: 'NS0',
      width: '320',
      height: '160',
    });

    expect(code).toBe('AWN4T-DW-GRN-T5-NS0');
  });
});
