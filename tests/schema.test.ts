import { describe, expect, test } from 'vitest';
import { parseCatalog, productSchema } from '../src/data/schema';
import { getProductById, products } from '../src/data/products';
import { categories } from '../src/data/categories';
import type { Product } from '../src/types/catalog';

/**
 * Spec section 9: schema.ts parses the mock data at boot to catch typos.
 * These tests prove the schema actually rejects the mistakes it is there to catch —
 * a schema that accepts everything passes silently and protects nothing.
 */

/**
 * awn-4t specifically, not `products[0]`: these tests mutate a swatch group, a glass
 * group and a rule, so the fixture has to be a product that actually has all three.
 * Indexing into the catalog made that an accident of ordering.
 */
const validProduct = (): Product => {
  const found = getProductById('awn-4t');
  if (!found) throw new Error('fixture missing: awn-4t');
  return structuredClone(found);
};

describe('parseCatalog', () => {
  test('accepts the shipped catalog', () => {
    expect(() => parseCatalog(products, categories)).not.toThrow();
  });

  test('returns the parsed products so callers use the validated value', () => {
    const parsed = parseCatalog(products, categories);

    expect(parsed.products).toHaveLength(products.length);
    expect(parsed.products.map((product) => product.id)).toEqual(products.map((p) => p.id));
  });

  test('keeps every field the raw product had', () => {
    // zod strips keys that the schema does not declare. Adding a field to Product
    // and forgetting it here makes it vanish between products.ts and the UI, with
    // no error anywhere — the elevation drawings went blank exactly this way.
    const parsed = parseCatalog(products, categories);

    parsed.products.forEach((product, index) => {
      const raw = products[index];
      expect(Object.keys(product).sort()).toEqual(Object.keys(raw ?? {}).sort());
    });
  });

  test('carries the elevation through the parse, panels and all', () => {
    const parsed = parseCatalog(products, categories);
    const awning = parsed.products.find((product) => product.id === 'awn-4t');

    expect(awning?.elevation).toEqual({ panels: 4, operation: 'awning', infill: 'glass' });
  });

  test('rejects an elevation whose panelWidths do not match its panel count', () => {
    const broken = validProduct();
    broken.elevation = { panels: 3, operation: 'casement', infill: 'glass', panelWidths: [2, 1] };

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a panel count below one', () => {
    const broken = validProduct();
    broken.elevation = { ...broken.elevation, panels: 0 };

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects an unknown opening symbol', () => {
    const broken = validProduct();
    // @ts-expect-error deliberately invalid data — this is what the schema must catch
    broken.elevation = { ...broken.elevation, operation: 'teleport' };

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a catalog where two products share a skuPrefix', () => {
    const a = validProduct();
    const b = { ...validProduct(), id: 'other', slug: 'other' };

    expect(() => parseCatalog([a, b], categories)).toThrow(/skuPrefix/i);
  });

  test('rejects a product whose categoryId matches no category', () => {
    const broken = validProduct();
    broken.categoryId = 'nope';

    expect(() => parseCatalog([broken], categories)).toThrow(/categoryId/i);
  });

  test('rejects duplicate product slugs, which would make routing ambiguous', () => {
    const a = validProduct();
    const b = validProduct();

    expect(() => parseCatalog([a, b], categories)).toThrow(/slug/i);
  });
});

describe('productSchema — structural typos', () => {
  test('rejects an unknown price delta type', () => {
    const broken = validProduct();
    const group = broken.groups[0];
    if (group?.kind !== 'sku' || !group.values[0]) throw new Error('fixture changed');
    // @ts-expect-error deliberately invalid data — this is what the schema must catch
    group.values[0].delta = { type: 'per_metre', amount: 10 };

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a negative pricePerSqm', () => {
    const broken = validProduct();
    broken.pricePerSqm = -1500;

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a custom group whose min exceeds its max', () => {
    const broken = validProduct();
    const group = broken.groups.find((candidate) => candidate.kind === 'custom');
    if (group?.kind !== 'custom') throw new Error('fixture changed');
    group.min = 500;
    group.max = 100;

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a custom group whose default falls outside its own range', () => {
    const broken = validProduct();
    const group = broken.groups.find((candidate) => candidate.kind === 'custom');
    if (group?.kind !== 'custom') throw new Error('fixture changed');
    group.defaultValue = 9999;

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a zero or negative step, which would divide by zero in the step check', () => {
    const broken = validProduct();
    const group = broken.groups.find((candidate) => candidate.kind === 'custom');
    if (group?.kind !== 'custom') throw new Error('fixture changed');
    group.step = 0;

    expect(productSchema.safeParse(broken).success).toBe(false);
  });
});

describe('productSchema — referential typos', () => {
  test('rejects a sku group whose defaultValue is not one of its values', () => {
    const broken = validProduct();
    const group = broken.groups[0];
    if (group?.kind !== 'sku') throw new Error('fixture changed');
    group.defaultValue = 'XX';

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects duplicate group codes within one product', () => {
    const broken = validProduct();
    const [first] = broken.groups;
    if (!first) throw new Error('fixture changed');
    broken.groups.push(structuredClone(first));

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects duplicate option codes within one group', () => {
    const broken = validProduct();
    const group = broken.groups[0];
    if (group?.kind !== 'sku' || !group.values[0]) throw new Error('fixture changed');
    group.values.push(structuredClone(group.values[0]));

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a rule referencing a group the product does not have', () => {
    const broken = validProduct();
    broken.rules.push({
      id: 'typo-rule',
      severity: 'error',
      messageTh: 'ทดสอบ',
      when: { op: 'selected', group: 'contorl', value: 'MOT' },
    });

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a rule measuring a custom group the product does not have', () => {
    const broken = validProduct();
    broken.rules.push({
      id: 'typo-measure',
      severity: 'error',
      messageTh: 'ทดสอบ',
      when: { op: 'gt', left: { n: 'measure', group: 'widht' }, right: { n: 'const', value: 200 } },
    });

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects duplicate rule ids, which would make issues indistinguishable', () => {
    const broken = validProduct();
    const [first] = broken.rules;
    if (!first) throw new Error('fixture changed');
    broken.rules.push(structuredClone(first));

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('accepts a nested rule expression', () => {
    const ok = validProduct();
    ok.rules.push({
      id: 'nested-ok',
      severity: 'warning',
      messageTh: 'ทดสอบ',
      when: {
        op: 'and',
        all: [
          { op: 'selected', group: 'glass_thickness', value: 'LAM' },
          {
            op: 'or',
            any: [
              { op: 'gt', left: { n: 'measure', group: 'width' }, right: { n: 'const', value: 200 } },
              { op: 'gt', left: { n: 'area' }, right: { n: 'const', value: 6 } },
            ],
          },
        ],
      },
    });

    expect(productSchema.safeParse(ok).success).toBe(true);
  });
});

describe('productSchema — presentation typos', () => {
  test('rejects a swatch option missing its hex colour', () => {
    const broken = validProduct();
    const group = broken.groups.find(
      (candidate) => candidate.kind === 'sku' && candidate.input === 'swatch',
    );
    if (group?.kind !== 'sku' || !group.values[0]) throw new Error('fixture changed');
    delete group.values[0].swatchHex;

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a malformed hex colour', () => {
    const broken = validProduct();
    const group = broken.groups[0];
    if (group?.kind !== 'sku' || !group.values[0]) throw new Error('fixture changed');
    group.values[0].swatchHex = '7A4A3A';

    expect(productSchema.safeParse(broken).success).toBe(false);
  });

  test('rejects a product with no custom groups — pricing needs width and height', () => {
    const broken = validProduct();
    broken.groups = broken.groups.filter((group) => group.kind !== 'custom');

    expect(productSchema.safeParse(broken).success).toBe(false);
  });
});
