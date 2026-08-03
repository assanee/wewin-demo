import { describe, expect, test } from 'vitest';
import { products, getProductById } from '../src/data/products.js';
import { categories } from '../src/data/categories.js';
import type { Category, Product } from '../src/types/catalog.js';
import {
  billableFloorSpan,
  leadTimeSpan,
  lowestPricePerSqm,
  summarizeCategories,
} from '../src/catalogSummary.js';

const byId = (id: string): Product => {
  const found = getProductById(id);
  if (!found) throw new Error(`fixture missing: ${id}`);
  return found;
};

/**
 * Same reasoning as filters.test.ts: a small fixture, so adding a product to the
 * catalog cannot fail a test that is about aggregation rules.
 *
 * awn-4t is a casement window at 1500/sqm, lvr-adj-3 a louver at 2400,
 * sld-2p a slider at 2100 — three different categories, three different prices.
 */
const FIXTURE: Product[] = [byId('awn-4t'), byId('lvr-adj-3'), byId('sld-2p')];

const category = (id: string): Category => {
  const found = categories.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture missing category: ${id}`);
  return found;
};

describe('summarizeCategories', () => {
  test('returns one summary per category, in the order given', () => {
    const summaries = summarizeCategories(FIXTURE, [
      category('sliding'),
      category('louvers'),
      category('casement'),
    ]);

    expect(summaries.map((summary) => summary.category.id)).toEqual([
      'sliding',
      'louvers',
      'casement',
    ]);
  });

  test('counts only the products in that category', () => {
    const [louvers] = summarizeCategories(FIXTURE, [category('louvers')]);
    expect(louvers?.productCount).toBe(1);
  });

  test('takes the cheapest price in the category, not the cheapest in the catalog', () => {
    const [louvers] = summarizeCategories(FIXTURE, [category('louvers')]);

    // 1500 is the catalog floor (awn-4t) but belongs to another category.
    expect(louvers?.fromPricePerSqm).toBe(2400);
  });

  test('spans lead time from the fastest low bound to the slowest high bound', () => {
    const [all] = summarizeCategories(
      [
        { ...byId('awn-4t'), categoryId: 'casement', leadTimeDays: [10, 14] },
        { ...byId('lvr-adj-3'), categoryId: 'casement', leadTimeDays: [18, 25] },
      ],
      [category('casement')],
    );

    expect(all?.leadTimeDays).toEqual([10, 25]);
  });

  test('reports an empty category rather than dropping it', () => {
    // A card that vanishes hides a data problem; a card that says "none yet" shows it.
    const [screens] = summarizeCategories(FIXTURE, [category('screens')]);

    expect(screens?.productCount).toBe(0);
    expect(screens?.fromPricePerSqm).toBeNull();
    expect(screens?.leadTimeDays).toBeNull();
  });
});

describe('lowestPricePerSqm', () => {
  test('reports the cheapest price per sqm in the list', () => {
    expect(lowestPricePerSqm(FIXTURE)).toBe(1500);
  });

  test('is null for an empty catalog, so callers cannot print a bogus ฿0', () => {
    expect(lowestPricePerSqm([])).toBeNull();
  });
});

describe('leadTimeSpan', () => {
  test('spans the fastest low bound to the slowest high bound across the list', () => {
    expect(leadTimeSpan(FIXTURE)).toEqual([10, 21]);
  });

  test('is null for an empty catalog', () => {
    expect(leadTimeSpan([])).toBeNull();
  });
});

describe('billableFloorSpan', () => {
  test('spans the smallest to the largest minimum billable area', () => {
    // lvr-adj-3 bills from 1.0 sqm (louver kit), sld-2p from 2.0 (window_wide).
    expect(billableFloorSpan(FIXTURE)).toEqual([1, 2]);
  });

  test('is null for an empty catalog', () => {
    expect(billableFloorSpan([])).toBeNull();
  });
});

describe('the real catalog', () => {
  test('every category has at least one product, so no home card is a dead end', () => {
    const summaries = summarizeCategories(products, categories);
    const empty = summaries.filter((summary) => summary.productCount === 0);

    expect(empty.map((summary) => summary.category.id)).toEqual([]);
  });

  test('every category can print a starting price', () => {
    const summaries = summarizeCategories(products, categories);

    for (const summary of summaries) {
      expect(summary.fromPricePerSqm).toBeGreaterThan(0);
    }
  });
});
