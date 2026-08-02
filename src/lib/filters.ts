import type { CustomGroup, OptionValue, Product, SkuGroup, Unit } from '../types/catalog';

/**
 * Catalog filtering and the facets that drive the filter panel.
 * Pure — the panel is just a controlled view over a CatalogFilters value.
 */

export interface CatalogFilters {
  categoryIds: string[];
  profileColorCodes: string[];
  minPricePerSqm: number | null;
  maxPricePerSqm: number | null;
}

export const emptyFilters = (): CatalogFilters => ({
  categoryIds: [],
  profileColorCodes: [],
  minPricePerSqm: null,
  maxPricePerSqm: null,
});

export const isFilterActive = (filters: CatalogFilters): boolean =>
  filters.categoryIds.length > 0 ||
  filters.profileColorCodes.length > 0 ||
  filters.minPricePerSqm !== null ||
  filters.maxPricePerSqm !== null;

const skuGroup = (product: Product, code: string): SkuGroup | undefined =>
  product.groups.find((group): group is SkuGroup => group.kind === 'sku' && group.code === code);

const customGroup = (product: Product, code: string): CustomGroup | undefined =>
  product.groups.find((group): group is CustomGroup => group.kind === 'custom' && group.code === code);

const availableProfileColors = (product: Product): OptionValue[] =>
  (skuGroup(product, 'profile_color')?.values ?? []).filter((value) => value.available);

/**
 * Facets combine as AND across categories, OR within one facet — the behaviour
 * people expect from faceted search: picking two colours widens the result, picking
 * a colour and a category narrows it.
 */
export function filterProducts(products: Product[], filters: CatalogFilters): Product[] {
  return products.filter((product) => {
    if (filters.categoryIds.length > 0 && !filters.categoryIds.includes(product.categoryId)) {
      return false;
    }

    if (filters.profileColorCodes.length > 0) {
      const offered = availableProfileColors(product).map((value) => value.code);
      if (!filters.profileColorCodes.some((code) => offered.includes(code))) return false;
    }

    if (filters.minPricePerSqm !== null && product.pricePerSqm < filters.minPricePerSqm) return false;
    if (filters.maxPricePerSqm !== null && product.pricePerSqm > filters.maxPricePerSqm) return false;

    return true;
  });
}

export interface ProfileColorFacet {
  code: string;
  labelTh: string;
  swatchHex: string | undefined;
}

/** Every distinct profile colour in the catalog, in first-seen order. */
export function profileColorFacets(products: Product[]): ProfileColorFacet[] {
  const seen = new Map<string, ProfileColorFacet>();

  for (const product of products) {
    for (const value of availableProfileColors(product)) {
      if (!seen.has(value.code)) {
        seen.set(value.code, {
          code: value.code,
          labelTh: value.labelTh,
          swatchHex: value.swatchHex,
        });
      }
    }
  }

  return [...seen.values()];
}

export function priceBounds(products: Product[]): { min: number; max: number } {
  if (products.length === 0) return { min: 0, max: 0 };

  const prices = products.map((product) => product.pricePerSqm);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/* ------------------------------------------------------------------ *
 * Product card metadata
 * ------------------------------------------------------------------ */

export function countProfileColors(product: Product | undefined): number {
  return product ? availableProfileColors(product).length : 0;
}

export interface MeasureRange {
  min: number;
  max: number;
  unit: Unit;
}

/** Range badge source, e.g. "ปรับขนาดได้ 60–400 cm". */
export function measureRange(product: Product | undefined, code: string): MeasureRange | null {
  if (!product) return null;

  const group = customGroup(product, code);
  if (!group) return null;

  return { min: group.min, max: group.max, unit: group.unit };
}

export { customGroup as getCustomGroup, skuGroup as getSkuGroup };
