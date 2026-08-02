import type { Category, Product } from '../types/catalog';

/**
 * Catalog-wide aggregates for the marketing surfaces (home page, footer).
 *
 * The home page makes three promises — a starting price, a production time and a
 * minimum billable area — and each one is a number a visitor will hold us to. None
 * of them are written into copy: they are derived here from the same products.ts
 * the configurator prices from, so a price list update cannot leave the home page
 * advertising a figure the configurator no longer charges.
 *
 * Every aggregate returns null on an empty list rather than 0. A "เริ่ม ฿0/ตร.ม."
 * is worse than no price at all.
 */

export interface CategorySummary {
  category: Category;
  productCount: number;
  /** Cheapest price per sqm within this category. */
  fromPricePerSqm: number | null;
  /** Fastest low bound to slowest high bound within this category. */
  leadTimeDays: [number, number] | null;
}

export function lowestPricePerSqm(products: Product[]): number | null {
  if (products.length === 0) return null;
  return Math.min(...products.map((product) => product.pricePerSqm));
}

/**
 * Not a min/max of whole ranges but of their bounds: with [10,14] and [18,25] the
 * honest claim is "10–25 วัน", because both ends are achievable in the catalog.
 */
export function leadTimeSpan(products: Product[]): [number, number] | null {
  if (products.length === 0) return null;

  return [
    Math.min(...products.map((product) => product.leadTimeDays[0])),
    Math.max(...products.map((product) => product.leadTimeDays[1])),
  ];
}

export function billableFloorSpan(products: Product[]): [number, number] | null {
  if (products.length === 0) return null;

  const floors = products.map((product) => product.minBillableSqm);
  return [Math.min(...floors), Math.max(...floors)];
}

/**
 * Preserves the caller's category order and keeps empty categories in the result.
 * Dropping them here would let a mis-tagged categoryId silently erase a card from
 * the home page; leaving them in makes the gap visible in the UI instead.
 */
export function summarizeCategories(
  products: Product[],
  categories: Category[],
): CategorySummary[] {
  return categories.map((category) => {
    const inCategory = products.filter((product) => product.categoryId === category.id);

    return {
      category,
      productCount: inCategory.length,
      fromPricePerSqm: lowestPricePerSqm(inCategory),
      leadTimeDays: leadTimeSpan(inCategory),
    };
  });
}
