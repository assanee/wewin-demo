import type { Product } from '@wewin/core';
import type { CatalogFilters } from '@wewin/core/filters';

/**
 * ⭐ What the catalogue's filter panel needs to know about a product, and nothing else.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────────
 *
 * `CatalogBrowser` is a client component and used to import the 81 seeded products
 * *directly*, filtering over that array and looking cards up by id. Its own comment gave the
 * reason and the reason was good: a `Product` holds `bigint` micrometres, a `bigint` does not
 * serialise, and re-implementing the predicate would put a second definition of "what
 * matches" in the app.
 *
 * ⛔ What it also did, once the page began adding products from the database, is **render
 * only the 81**. The extra cards were serialised into the payload and never displayed,
 * because their ids were not in the array being filtered — while the count label, computed
 * on the server from the real list, said 83. A page that says 83 and shows 81 is worse than
 * one that shows 81, because the number is the thing a person trusts.
 *
 * ── The trade, made explicitly ──────────────────────────────────────────────────
 *
 * A row carries only the four things the predicate reads, all of them JSON-safe — no
 * `bigint` goes near the boundary. The second definition of "what matches" does now exist,
 * and it is answered not by an argument but by `facet-rows.test.ts`, which runs this
 * predicate and core's over every seeded product across a matrix of filters and asserts they
 * select exactly the same products. Drift fails the suite rather than silently hiding stock.
 */

export interface FacetColor {
  readonly code: string;
  readonly labelTh: string;
  /**
   * ⚠️ Declared present-and-possibly-undefined rather than optional, to match core's
   * `ProfileColorFacet` exactly — `exactOptionalPropertyTypes` treats the two as different
   * types, and the filter panel takes core's.
   */
  readonly swatchHex: string | undefined;
}

export interface FacetRow {
  readonly id: string;
  readonly categoryId: string;
  /** Whole baht, as `Product.pricePerSqm` holds it — a `number`, not a `bigint`. */
  readonly pricePerSqm: number;
  /** ⚠️ Only the values a customer can actually pick: unavailable ones are dropped here. */
  readonly profileColors: readonly FacetColor[];
}

/** One row per product, built on the server where the `bigint`s are harmless. */
export function facetRowsFrom(products: readonly Product[]): readonly FacetRow[] {
  return products.map((product) => {
    const group = product.groups.find(
      (candidate) => candidate.kind === 'sku' && candidate.code === 'profile_color',
    );

    const colors: FacetColor[] =
      group === undefined || group.kind !== 'sku'
        ? []
        : group.values
            .filter((value) => value.available)
            .map((value) => ({
              code: value.code,
              labelTh: value.labelTh,
              swatchHex: value.swatchHex,
            }));

    return {
      id: product.id,
      categoryId: product.categoryId,
      pricePerSqm: product.pricePerSqm,
      profileColors: colors,
    };
  });
}

/**
 * The same rule as core's `filterProducts`, over rows.
 *
 * ⚠️ AND across facets, OR within one — picking two colours widens the result, picking a
 * colour and a category narrows it. Copied deliberately, and pinned by the equivalence test.
 */
export function filterRows(
  rows: readonly FacetRow[],
  filters: CatalogFilters,
): readonly FacetRow[] {
  return rows.filter((row) => {
    if (filters.categoryIds.length > 0 && !filters.categoryIds.includes(row.categoryId)) {
      return false;
    }

    if (filters.profileColorCodes.length > 0) {
      const offered = row.profileColors.map((color) => color.code);
      if (!filters.profileColorCodes.some((code) => offered.includes(code))) return false;
    }

    if (filters.minPricePerSqm !== null && row.pricePerSqm < filters.minPricePerSqm) return false;
    if (filters.maxPricePerSqm !== null && row.pricePerSqm > filters.maxPricePerSqm) return false;

    return true;
  });
}

/** Every distinct profile colour in the rows, in first-seen order — core's rule. */
export function colorFacetsFrom(rows: readonly FacetRow[]): readonly FacetColor[] {
  const seen = new Map<string, FacetColor>();
  for (const row of rows) {
    for (const color of row.profileColors) {
      if (!seen.has(color.code)) seen.set(color.code, color);
    }
  }
  return [...seen.values()];
}

/** The price slider's ends. Zero-to-zero for an empty catalogue, as core does. */
export function priceBoundsFrom(rows: readonly FacetRow[]): { readonly min: number; readonly max: number } {
  if (rows.length === 0) return { min: 0, max: 0 };
  const prices = rows.map((row) => row.pricePerSqm);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
