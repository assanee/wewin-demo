import { describe, expect, test } from 'vitest';
import { products } from '../src/data/products';
import {
  countProfileColors,
  emptyFilters,
  filterProducts,
  isFilterActive,
  measureRange,
  priceBounds,
  profileColorFacets,
} from '../src/lib/filters';

const slugs = (list: { slug: string }[]) => list.map((product) => product.slug);

describe('filterProducts', () => {
  test('returns everything when no filter is set', () => {
    expect(slugs(filterProducts(products, emptyFilters()))).toEqual(['awn-4t', 'lvr-adj-3', 'sld-2p']);
  });

  test('narrows by category', () => {
    const result = filterProducts(products, { ...emptyFilters(), categoryIds: ['doors'] });

    expect(slugs(result)).toEqual(['sld-2p']);
  });

  test('treats multiple categories as OR', () => {
    const result = filterProducts(products, { ...emptyFilters(), categoryIds: ['doors', 'louvers'] });

    expect(slugs(result)).toEqual(['lvr-adj-3', 'sld-2p']);
  });

  test('keeps products that offer any of the selected profile colours', () => {
    // Only awn-4t and sld-2p offer BK; lvr-adj-3 has DW/LW/SG only.
    const result = filterProducts(products, { ...emptyFilters(), profileColorCodes: ['BK'] });

    expect(slugs(result)).toEqual(['awn-4t', 'sld-2p']);
  });

  test('treats multiple colours as OR, not AND', () => {
    const result = filterProducts(products, { ...emptyFilters(), profileColorCodes: ['BK', 'SG'] });

    expect(slugs(result)).toEqual(['awn-4t', 'lvr-adj-3', 'sld-2p']);
  });

  test('ignores an option that exists but is unavailable', () => {
    const patched = products.map((product) => ({
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
    // 1500 / 2400 / 2100
    expect(slugs(filterProducts(products, { ...emptyFilters(), minPricePerSqm: 2100 }))).toEqual([
      'lvr-adj-3',
      'sld-2p',
    ]);
    expect(slugs(filterProducts(products, { ...emptyFilters(), maxPricePerSqm: 2100 }))).toEqual([
      'awn-4t',
      'sld-2p',
    ]);
    expect(
      slugs(filterProducts(products, { ...emptyFilters(), minPricePerSqm: 1600, maxPricePerSqm: 2200 })),
    ).toEqual(['sld-2p']);
  });

  test('combines facets with AND', () => {
    const result = filterProducts(products, {
      ...emptyFilters(),
      categoryIds: ['windows', 'doors'],
      profileColorCodes: ['BK'],
      maxPricePerSqm: 1800,
    });

    expect(slugs(result)).toEqual(['awn-4t']);
  });

  test('returns an empty list rather than throwing when nothing matches', () => {
    expect(filterProducts(products, { ...emptyFilters(), categoryIds: ['partitions'] })).toEqual([]);
  });

  test('does not mutate the input array', () => {
    const before = [...products];
    filterProducts(products, { ...emptyFilters(), categoryIds: ['doors'] });

    expect(products).toEqual(before);
  });
});

describe('isFilterActive', () => {
  test('is false for the empty filter set, so the clear button can hide', () => {
    expect(isFilterActive(emptyFilters())).toBe(false);
  });

  test('is true as soon as any facet is set', () => {
    expect(isFilterActive({ ...emptyFilters(), categoryIds: ['doors'] })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), profileColorCodes: ['BK'] })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), minPricePerSqm: 1600 })).toBe(true);
    expect(isFilterActive({ ...emptyFilters(), maxPricePerSqm: 1600 })).toBe(true);
  });
});

describe('profileColorFacets', () => {
  test('lists every distinct profile colour across the catalog, once each', () => {
    const facets = profileColorFacets(products);

    expect(facets.map((facet) => facet.code)).toEqual(['DW', 'LW', 'SG', 'BK', 'WH']);
  });

  test('carries the label and swatch so the filter can render chips', () => {
    const [first] = profileColorFacets(products);

    expect(first?.labelTh).toBe('ลายไม้เข้ม');
    expect(first?.swatchHex).toBe('#7A4A3A');
  });
});

describe('priceBounds', () => {
  test('reports the cheapest and dearest price per sqm in the catalog', () => {
    expect(priceBounds(products)).toEqual({ min: 1500, max: 2400 });
  });

  test('falls back to a zero range for an empty catalog', () => {
    expect(priceBounds([])).toEqual({ min: 0, max: 0 });
  });
});

describe('product card metadata', () => {
  test('counts the profile colours a product offers', () => {
    expect(countProfileColors(products[0])).toBe(5);
    expect(countProfileColors(products[1])).toBe(3);
  });

  test('reports the adjustable width range for the size badge', () => {
    expect(measureRange(products[0], 'width')).toEqual({ min: 60, max: 400, unit: 'cm' });
    expect(measureRange(products[2], 'width')).toEqual({ min: 120, max: 500, unit: 'cm' });
  });

  test('returns null for a measurement the product does not have', () => {
    expect(measureRange(products[0], 'depth')).toBeNull();
  });
});
