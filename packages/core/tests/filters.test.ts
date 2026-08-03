import { describe, expect, test } from 'vitest';
import { products, getProductById } from '../src/data/products.js';
import type { Product } from '../src/types/catalog.js';
import {
  countProfileColors,
  emptyFilters,
  filterProducts,
  isFilterActive,
  measureRange,
  priceBounds,
  profileColorFacets,
} from '../src/filters.js';

const byId = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

/**
 * A three-product fixture, not the whole catalog.
 *
 * These tests are about filter behaviour, not about what happens to be in the
 * catalog this week. Asserting on the real 81-product list made every one of them
 * fail the moment products were added — noise that says nothing about the logic.
 * The real catalog gets its own smoke tests at the bottom instead.
 */
const FIXTURE: Product[] = [byId('awn-4t'), byId('lvr-adj-3'), byId('sld-2p')];

const slugs = (list: { slug: string }[]) => list.map((product) => product.slug);

describe('filterProducts', () => {
  test('returns everything when no filter is set', () => {
    expect(slugs(filterProducts(FIXTURE, emptyFilters()))).toEqual(['awn-4t', 'lvr-adj-3', 'sld-2p']);
  });

  test('narrows by category', () => {
    expect(slugs(filterProducts(FIXTURE, { ...emptyFilters(), categoryIds: ['sliding'] }))).toEqual([
      'sld-2p',
    ]);
  });

  test('treats multiple categories as OR', () => {
    const result = filterProducts(FIXTURE, { ...emptyFilters(), categoryIds: ['sliding', 'louvers'] });

    expect(slugs(result)).toEqual(['lvr-adj-3', 'sld-2p']);
  });

  test('keeps products that offer any of the selected profile colours', () => {
    // lvr-adj-3 offers DW/LW/SG only; the other two offer all five.
    const result = filterProducts(FIXTURE, { ...emptyFilters(), profileColorCodes: ['BK'] });

    expect(slugs(result)).toEqual(['awn-4t', 'sld-2p']);
  });

  test('treats multiple colours as OR, not AND', () => {
    const result = filterProducts(FIXTURE, { ...emptyFilters(), profileColorCodes: ['BK', 'SG'] });

    expect(slugs(result)).toEqual(['awn-4t', 'lvr-adj-3', 'sld-2p']);
  });

  test('ignores an option that exists but is unavailable', () => {
    const patched = FIXTURE.map((product) => ({
      ...product,
      groups: product.groups.map((group) =>
        group.kind === 'sku' && group.code === 'profile_color'
          ? { ...group, values: group.values.map((value) => ({ ...value, available: value.code !== 'BK' })) }
          : group,
      ),
    }));

    expect(filterProducts(patched, { ...emptyFilters(), profileColorCodes: ['BK'] })).toEqual([]);
  });

  test('narrows by price per sqm, inclusive of both bounds', () => {
    // awn-4t 1500 / lvr-adj-3 2400 / sld-2p 2100
    expect(slugs(filterProducts(FIXTURE, { ...emptyFilters(), minPricePerSqm: 2100 }))).toEqual([
      'lvr-adj-3',
      'sld-2p',
    ]);
    expect(slugs(filterProducts(FIXTURE, { ...emptyFilters(), maxPricePerSqm: 2100 }))).toEqual([
      'awn-4t',
      'sld-2p',
    ]);
    expect(
      slugs(filterProducts(FIXTURE, { ...emptyFilters(), minPricePerSqm: 1600, maxPricePerSqm: 2200 })),
    ).toEqual(['sld-2p']);
  });

  test('combines facets with AND', () => {
    const result = filterProducts(FIXTURE, {
      ...emptyFilters(),
      categoryIds: ['casement', 'sliding'],
      profileColorCodes: ['BK'],
      maxPricePerSqm: 1800,
    });

    expect(slugs(result)).toEqual(['awn-4t']);
  });

  test('returns an empty list rather than throwing when nothing matches', () => {
    expect(filterProducts(FIXTURE, { ...emptyFilters(), categoryIds: ['screens'] })).toEqual([]);
  });

  test('does not mutate the input array', () => {
    const before = [...FIXTURE];
    filterProducts(FIXTURE, { ...emptyFilters(), categoryIds: ['sliding'] });

    expect(FIXTURE).toEqual(before);
  });
});

describe('isFilterActive', () => {
  test('is false for the empty filter set, so the clear button can hide', () => {
    expect(isFilterActive(emptyFilters())).toBe(false);
  });

  test('is true as soon as any facet is set', () => {
    expect(isFilterActive({ ...emptyFilters(), categoryIds: ['sliding'] })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), profileColorCodes: ['BK'] })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), minPricePerSqm: 1600 })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), maxPricePerSqm: 1600 })).toBe(true);
  });
});

describe('profileColorFacets', () => {
  test('lists each distinct profile colour once, in first-seen order', () => {
    expect(profileColorFacets(FIXTURE).map((facet) => facet.code)).toEqual([
      'DW',
      'LW',
      'SG',
      'BK',
      'WH',
    ]);
  });

  test('carries the label and swatch so the filter can render chips', () => {
    const [first] = profileColorFacets(FIXTURE);

    expect(first?.labelTh).toBe('ลายไม้เข้ม');
    expect(first?.swatchHex).toBe('#7A4A3A');
  });
});

describe('priceBounds', () => {
  test('reports the cheapest and dearest price per sqm', () => {
    expect(priceBounds(FIXTURE)).toEqual({ min: 1500, max: 2400 });
  });

  test('falls back to a zero range for an empty catalog', () => {
    expect(priceBounds([])).toEqual({ min: 0, max: 0 });
  });
});

describe('product card metadata', () => {
  test('counts the profile colours a product offers', () => {
    expect(countProfileColors(byId('awn-4t'))).toBe(5);
    expect(countProfileColors(byId('lvr-adj-3'))).toBe(3);
  });

  test('reports the adjustable width range for the size badge', () => {
    expect(measureRange(byId('awn-4t'), 'width')).toEqual({ min: 60, max: 400, unit: 'cm' });
    expect(measureRange(byId('sld-2p'), 'width')).toEqual({ min: 120, max: 500, unit: 'cm' });
  });

  test('returns null for a measurement the product does not have', () => {
    expect(measureRange(byId('awn-4t'), 'depth')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The real catalog — properties that must hold however it grows
 * ------------------------------------------------------------------ */

describe('the shipped catalog', () => {
  test('every product is reachable through its own category filter', () => {
    for (const product of products) {
      const result = filterProducts(products, {
        ...emptyFilters(),
        categoryIds: [product.categoryId],
      });

      expect(result).toContain(product);
    }
  });

  test('filtering by a category never returns a product from another one', () => {
    const result = filterProducts(products, { ...emptyFilters(), categoryIds: ['screens'] });

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((product) => product.categoryId === 'screens')).toBe(true);
  });

  test('the colour facet covers every profile colour offered anywhere', () => {
    expect(profileColorFacets(products).map((facet) => facet.code).sort()).toEqual([
      'BK',
      'DW',
      'LW',
      'SG',
      'WH',
    ]);
  });

  test('the price slider bounds span the whole catalog', () => {
    const bounds = priceBounds(products);
    const prices = products.map((product) => product.pricePerSqm);

    expect(bounds.min).toBe(Math.min(...prices));
    expect(bounds.max).toBe(Math.max(...prices));
  });
});
