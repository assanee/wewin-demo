import { describe, expect, it } from 'vitest';
import { products } from '@wewin/core/fixtures';
import {
  emptyFilters,
  filterProducts,
  priceBounds,
  profileColorFacets,
  type CatalogFilters,
} from '@wewin/core/filters';

import {
  colorFacetsFrom,
  facetRowsFrom,
  filterRows,
  priceBoundsFrom,
} from './facet-rows';

/**
 * ⛔ This file is the price of having a second definition of "what matches".
 *
 * `CatalogBrowser` cannot import `@wewin/core`'s products — it is a client component and a
 * `Product` holds `bigint`s. It used to import them anyway, which meant it filtered over the
 * 81 seeded products and **never rendered anything the dashboard had added**, while the
 * count label said otherwise.
 *
 * So the predicate is mirrored over a serialisable row. The mirror is only safe while it
 * agrees with core, and "agrees" is not something a comment can promise — so every test
 * below runs both over the real catalogue and compares the selections.
 */

const rows = facetRowsFrom(products);

/** Filter combinations worth crossing: each facet alone, and in every pairing. */
const cases: readonly { readonly name: string; readonly filters: CatalogFilters }[] = (() => {
  const categories = [...new Set(products.map((product) => product.categoryId))];
  const colors = profileColorFacets(products).map((facet) => facet.code);
  const { min, max } = priceBounds(products);
  const mid = Math.round((min + max) / 2);

  const built: { name: string; filters: CatalogFilters }[] = [
    { name: 'no filters', filters: emptyFilters() },
  ];

  for (const categoryId of categories) {
    built.push({ name: `category ${categoryId}`, filters: { ...emptyFilters(), categoryIds: [categoryId] } });
  }
  for (const code of colors) {
    built.push({ name: `colour ${code}`, filters: { ...emptyFilters(), profileColorCodes: [code] } });
  }

  built.push(
    { name: 'two categories (OR widens)', filters: { ...emptyFilters(), categoryIds: categories.slice(0, 2) } },
    { name: 'two colours (OR widens)', filters: { ...emptyFilters(), profileColorCodes: colors.slice(0, 2) } },
    {
      name: 'a category AND a colour (narrows)',
      filters: {
        ...emptyFilters(),
        categoryIds: categories.slice(0, 1),
        profileColorCodes: colors.slice(0, 1),
      },
    },
    { name: 'price floor', filters: { ...emptyFilters(), minPricePerSqm: mid } },
    { name: 'price ceiling', filters: { ...emptyFilters(), maxPricePerSqm: mid } },
    { name: 'price band', filters: { ...emptyFilters(), minPricePerSqm: min, maxPricePerSqm: mid } },
    {
      name: 'everything at once',
      filters: {
        categoryIds: categories.slice(0, 2),
        profileColorCodes: colors.slice(0, 2),
        minPricePerSqm: min,
        maxPricePerSqm: max,
      },
    },
    { name: 'a band that matches nothing', filters: { ...emptyFilters(), minPricePerSqm: max + 1 } },
  );

  return built;
})();

describe('the row predicate against the one it mirrors', () => {
  it('⭐ selects exactly what core selects, for every filter combination', () => {
    expect(cases.length).toBeGreaterThan(10);

    for (const { name, filters } of cases) {
      const mine = filterRows(rows, filters).map((row) => row.id);
      const theirs = filterProducts([...products], filters).map((product) => product.id);
      expect(mine, name).toStrictEqual(theirs);
    }
  });

  it('⚠️ at least one case actually filters something out, or the test above proves nothing', () => {
    /*
     * An equivalence test over a predicate that never rejects anything passes trivially.
     * This is the anti-vacuity check.
     */
    const narrowed = cases.filter(
      ({ filters }) => filterRows(rows, filters).length < rows.length,
    );
    expect(narrowed.length).toBeGreaterThan(3);
    expect(cases.some(({ filters }) => filterRows(rows, filters).length === 0)).toBe(true);
  });

  it('builds the same colour facets, in the same order', () => {
    expect(colorFacetsFrom(rows).map((facet) => facet.code)).toStrictEqual(
      profileColorFacets([...products]).map((facet) => facet.code),
    );
  });

  it('builds the same price bounds', () => {
    expect(priceBoundsFrom(rows)).toStrictEqual(priceBounds([...products]));
  });

  it('⚠️ drops unavailable colours, exactly as core does', () => {
    /* `availableProfileColors` filters on `available`; a row that kept them would offer a
       customer a filter that matches stock they cannot buy. */
    const everyRowColor = rows.flatMap((row) => row.profileColors.map((color) => color.code));
    const coreColors = profileColorFacets([...products]).map((facet) => facet.code);
    expect([...new Set(everyRowColor)].sort()).toStrictEqual([...coreColors].sort());
  });
});

describe('a product the fixtures do not contain', () => {
  it('⭐ is carried by a row like any other — which is the whole point', () => {
    const added = facetRowsFrom([
      {
        ...(products[0] as (typeof products)[number]),
        id: 'from-the-dashboard',
        categoryId: 'casement',
        pricePerSqm: 2_500,
        groups: [],
      },
    ]);

    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('from-the-dashboard');
    /* No `profile_color` group at all — legal, and it simply offers no colours. */
    expect(added[0]?.profileColors).toStrictEqual([]);
    expect(filterRows(added, emptyFilters())).toHaveLength(1);
  });

  it('⚠️ is hidden by a colour filter, because it genuinely offers no colour', () => {
    /*
     * Worth pinning rather than leaving to chance: a product created without a
     * `profile_color` group disappears the moment a customer picks any colour. That is the
     * honest answer — it does not come in that colour — but it is surprising enough to be
     * written down.
     */
    const added = facetRowsFrom([
      { ...(products[0] as (typeof products)[number]), id: 'no-colours', groups: [] },
    ]);
    const colour = profileColorFacets([...products])[0]?.code ?? 'SG';
    expect(filterRows(added, { ...emptyFilters(), profileColorCodes: [colour] })).toHaveLength(0);
  });
});
