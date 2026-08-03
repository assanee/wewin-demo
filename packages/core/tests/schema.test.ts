import { describe, expect, test } from 'vitest';
import { parseCatalog, productSchema } from '../src/data/schema.js';
import { getProductById, products } from '../src/data/products.js';
import { categories } from '../src/data/categories.js';
import type { CustomGroup, Product } from '../src/types/catalog.js';

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

/**
 * awn-4t's width group: min 600,000 µm, max 4,000,000 µm, step 5,000 µm,
 * default 3,200,000 µm. Returned by reference so a test can break one field of it.
 */
const measureGroup = (product: Product): CustomGroup => {
  const group = product.groups.find((candidate) => candidate.kind === 'custom');
  if (group?.kind !== 'custom') throw new Error('fixture changed');
  return group;
};

/**
 * Every rejection message, joined.
 *
 * The grid invariants below are not independent — a min that is off its own step is
 * also, arithmetically, a max and a default that are no longer a whole number of
 * steps away from it. Asserting only `success === false` would let each of these
 * tests pass on a refinement it was not written for, which for a gate whose whole
 * job is to catch a mistyped bound is the same as not testing it. A parse that
 * succeeds yields '' and matches nothing.
 */
const rejection = (product: Product): string => {
  const result = productSchema.safeParse(product);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n');
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
    const group = measureGroup(broken);
    group.minUm = 5_000_000n; // 500 cm
    group.maxUm = 1_000_000n; // 100 cm

    expect(rejection(broken)).toMatch(/min above max/);
  });

  test('rejects a custom group whose default falls outside its own range', () => {
    const broken = validProduct();
    // 9,999 cm, still a whole number of 5,000 µm steps above the min, so the range
    // check is the only one this can trip.
    measureGroup(broken).defaultUm = 99_990_000n;

    expect(rejection(broken)).toMatch(/defaultUm is outside min\/max/);
  });

  test('rejects a zero or negative step, which would divide by zero in the step check', () => {
    const broken = validProduct();
    measureGroup(broken).stepUm = 0n;

    expect(rejection(broken)).toMatch(/step at or below zero/);
  });

  test('rejects a bound at or below zero, which is a unit gone missing rather than a small window', () => {
    const broken = validProduct();
    measureGroup(broken).minUm = 0n;

    expect(rejection(broken)).toMatch(/min at or below zero/);
  });
});

/**
 * The bounds are authored in centimetres and converted by `cm()`, so what the schema
 * sees is never what a person reviewed. These are the checks that make the conversion
 * verifiable by machine — each one fails a mistake that would otherwise surface as a
 * measurement the customer cannot re-enter, months later and off a tape measure.
 */
describe('productSchema — measurement grid invariants', () => {
  test('rejects a step that is off the 25 µm lattice', () => {
    const broken = validProduct();
    // 16 µm divides all three of this group's bounds (600,000 / 4,000,000 /
    // 3,200,000), so the lattice is the only invariant left to fail. A step off the
    // lattice is one that metric and imperial entry cannot both land on.
    measureGroup(broken).stepUm = 16n;

    expect(rejection(broken)).toMatch(/lattice/);
  });

  test('rejects a min that is not itself on its step grid', () => {
    const broken = validProduct();
    // Snapping is anchored at absolute zero, so an off-grid min is a size the
    // customer is handed and then warned about. It also puts the max and the default
    // a fractional step away, which is why the message is what is asserted.
    measureGroup(broken).minUm = 602_000n;

    expect(rejection(broken)).toMatch(/min that is not itself on its step grid/);
  });

  test('rejects a max that is not a whole number of steps above its min', () => {
    const broken = validProduct();
    measureGroup(broken).maxUm = 4_002_000n; // 400.2 cm, 2,000 µm past the last step

    expect(rejection(broken)).toMatch(/max that is not a whole number of steps/);
  });

  test('rejects a default that is not on its own step grid', () => {
    const broken = validProduct();
    measureGroup(broken).defaultUm = 3_202_000n; // in range, but between two steps

    expect(rejection(broken)).toMatch(/default that is not on its own step grid/);
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
      when: {
        op: 'gt',
        left: { n: 'measure', group: 'widht' },
        right: { n: 'const', value: 2_000_000n, dim: 'length' }, // 200 cm
      },
    });

    expect(rejection(broken)).toMatch(/measures unknown custom group "widht"/);
  });

  test('rejects a comparison between two different dimensions', () => {
    const broken = validProduct();
    broken.rules.push({
      id: 'dimensionless',
      severity: 'error',
      messageTh: 'ทดสอบ',
      // The threshold a person means when they write 200 is 200 cm. Left bare, it is
      // 200 µm, and an error-severity rule that fires for every window ever built is
      // as broken as one that never fires — so the constant carries its dimension and
      // a mismatch is refused at boot rather than evaluated.
      when: {
        op: 'gt',
        left: { n: 'measure', group: 'width' },
        right: { n: 'const', value: 200n, dim: 'scalar' },
      },
    });

    expect(rejection(broken)).toMatch(/compares length against scalar/);
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
              {
                op: 'gt',
                left: { n: 'measure', group: 'width' },
                right: { n: 'const', value: 2_000_000n, dim: 'length' }, // 200 cm
              },
              {
                op: 'gt',
                left: { n: 'area' },
                right: { n: 'const', value: 6_000_000_000_000n, dim: 'area' }, // 6 m²
              },
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
