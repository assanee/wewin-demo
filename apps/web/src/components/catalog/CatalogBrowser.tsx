'use client';

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { categories } from '@wewin/core/fixtures';
import { emptyFilters, isFilterActive, type CatalogFilters } from '@wewin/core/filters';

import {
  colorFacetsFrom,
  filterRows,
  priceBoundsFrom,
  type FacetRow,
} from '@/lib/catalog/facet-rows';

import { Button } from '../common/Button';
import { BottomSheet } from '../common/BottomSheet';
import { useIsDesktop } from '../../state/useMediaQuery';
import { useLocale } from '../../state/localeContext';
import { FilterPanel } from './FilterPanel';

/** One product's card, already rendered on the server, with the id to address it by. */
export interface CatalogCard {
  readonly id: string;
  readonly card: ReactNode;
}

interface CatalogBrowserProps {
  /** Every card, server-rendered, in catalogue order. */
  readonly cards: readonly CatalogCard[];
  /**
   * ⭐ One row per card, in the same order — what the filter panel reasons over.
   *
   * Handed in rather than imported, so a product that exists only in the database is
   * filtered, faceted and counted exactly like a seeded one. See `facet-rows.ts`.
   */
  readonly rows: readonly FacetRow[];
  /**
   * `catalog.resultCount` for the unfiltered catalogue, rendered on the server.
   *
   * Not a convenience. The count is the one number that is in the prerendered HTML *and*
   * inside this client subtree, so it is the one place where Node's `Intl` and the
   * browser's meet — and the scaffold's README records that they disagree for `my-MM`,
   * where Node writes `၈၁` and Chromium writes `81` for the same call. Rendering the
   * server's own string until a filter is touched means the two never produce the same
   * node twice, so there is no mismatch to have and no flash of a re-spelled number.
   */
  readonly initialCountLabel: string;
}

/**
 * The catalogue's interactive half — and the shape of the answer to "how is a filtered,
 * shareable, faceted list also a prerendered page".
 *
 * ## What is on the server and what is here
 *
 * Every card is rendered by `app/[locale]/products/page.tsx` as a **server component** and
 * arrives here as an already-rendered node. This component never builds a card; it decides
 * which of them to show. So the prerendered HTML for `/de/products` contains all 81 product
 * names, summaries, prices and links — which is precisely what the crawl argument for this
 * whole phase is about — and the filtering is what it has always been: an interaction.
 *
 * The alternative, filtering on the server from `searchParams`, is plan 8.2's second trap
 * one door along. It is not `generateMetadata`, so no scan fires, but the consequence is
 * the same and larger: reading `searchParams` in a page opts the route out of static
 * rendering, and the catalogue is the page the move was made for.
 *
 * ## The category deep link, and why it is read from an effect
 *
 * `/de/products?category=awning` comes from the home page's category cards. The idiomatic
 * reader is `useSearchParams()` — and it cannot be used here. In a statically rendered
 * route it must sit under a `<Suspense>` boundary, and Next answers that boundary by
 * *skipping the prerender of the subtree inside it*: the 81 cards would leave the HTML and
 * arrive by JavaScript, giving back the one thing this page exists to have.
 *
 * So the query string is read once, after mount, from `window.location` — which is a
 * browser fact arriving on the client, in a client component, off the render path. The
 * server renders the unfiltered catalogue, hydration matches it exactly because both used
 * the same pristine filter state, and the facet lands on the commit after. That sequence
 * is the same one `DisplayUnitProvider` and `QuoteProvider` already use for `localStorage`,
 * for the same reason.
 *
 * `history.replaceState` writes changes back, rather than `router.replace`: the URL is a
 * bookmark of an interaction here, not a request for a different document, and a router
 * navigation would ask the server for a page it already has.
 */
export function CatalogBrowser({ cards, rows, initialCountLabel }: CatalogBrowserProps): ReactElement {
  const { t, f } = useLocale();
  const isDesktop = useIsDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(emptyFilters());

  // The category facet from the deep link, once, after mount. Never during render — see
  // the note above, and spec section 12, which this round is not spending.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).getAll('category');
    if (fromUrl.length === 0) return;
    setFilters((previous) => ({ ...previous, categoryIds: fromUrl }));
  }, []);

  const changeFilters = (next: CatalogFilters) => {
    setFilters(next);

    const params = new URLSearchParams(window.location.search);
    params.delete('category');
    for (const id of next.categoryIds) params.append('category', id);
    const query = params.toString();
    window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
  };

  const colorFacets = useMemo(() => colorFacetsFrom(rows), [rows]);
  const bounds = useMemo(() => priceBoundsFrom(rows), [rows]);

  /*
   * ⛔ Filtered over the **rows the page handed in**, not over `@wewin/core/fixtures`.
   *
   * This used to import the fixture array directly, and the reason given was sound while the
   * catalogue was only that array: a `Product` holds `bigint` micrometres, a `bigint` does
   * not serialise, and a second predicate would be a second definition of "what matches".
   *
   * What it also did, once the page started adding products from the database, was render
   * **only the 81 seeded ones** — the rest were serialised into the payload and never shown,
   * while the count label, computed on the server from the real list, said 83. Reported as
   * "the product I added is not on this page", and it genuinely was not.
   *
   * A `FacetRow` carries the four fields the predicate reads and no `bigint`. The second
   * definition does now exist, and `facet-rows.test.ts` runs it and core's over every seeded
   * product across a matrix of filters and asserts identical selections — so drift fails the
   * suite instead of quietly hiding stock.
   */
  const results = useMemo(() => filterRows(rows, filters), [rows, filters]);

  const cardsById = useMemo(
    () => new Map(cards.map((entry) => [entry.id, entry.card])),
    [cards],
  );

  const active = isFilterActive(filters);

  const panel = (
    <FilterPanel
      filters={filters}
      onChange={changeFilters}
      categories={categories}
      colorFacets={colorFacets}
      bounds={bounds}
    />
  );

  return (
    /*
     * `DisplayUnitProvider` was mounted here through the port and is in
     * `components/shell/AppShell.tsx` now, above every route — which is where the unit
     * belongs, because it follows a customer from the catalogue into the configurator and
     * on into the quote. The cards arrive as already-rendered server nodes and read the
     * unit through the React tree either way; what changed is that the configurator no
     * longer starts from `cm` after the catalogue was set to inches.
     */
    <>
      <div className="mb-6 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-title text-chalk lg:text-display">{t('catalog.heading')}</h1>
        <p className="numeric text-small text-chalk-2" aria-live="polite">
          {active ? t('catalog.resultCount', { count: results.length }) : initialCountLabel}
        </p>
      </div>

      {/* base/md: the filter trigger sits at the top of the page, not in a sidebar. */}
      <div className="mb-4 lg:hidden">
        <Button onClick={() => setSheetOpen(true)} className="w-full">
          <SlidersHorizontal size={18} aria-hidden />
          {t('filter.title')}
          {active ? (
            <span className="numeric rounded-xs bg-sel-bg px-2 text-caption text-chalk">
              {f.integer(filters.categoryIds.length + filters.profileColorCodes.length)}
            </span>
          ) : null}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/*
         * 🔴 **`hidden lg:block`, and not `isDesktop ? … : null`. Measured, not preferred.**
         *
         * This was a JS media query, and `useMediaQuery`'s server snapshot is `false` — so
         * the aside was absent from the prerendered HTML of all eight catalogue pages
         * while the grid template beside it still reserved its 240px column. A grid with
         * two tracks and one child puts that child in track one: every one of the 81 cards
         * rendered into a 240px slot, at desktop width, until hydration moved them. Not a
         * flicker — **CLS 0.425 on `/th/products` through `/zh/products`**, against
         * Google's 0.25 "poor" threshold and the Vite app's 0.001. The measurement is in
         * the phase-6b notes; the layout-shift source is `div.min-w-0` going x=152 w=240 →
         * x=424 w=864.
         *
         * React reports none of this. `useSyncExternalStore` returning a different value
         * on the client than the server is a *sanctioned* re-render, not a hydration
         * mismatch, so there is no warning, no console error and nothing for a test that
         * scans for errors to catch. The only signal is a number on a performance trace.
         *
         * The rule that follows, and it is the same one `useMediaQuery`'s own header
         * states: **CSS decides what is visible, JS decides only what cannot be expressed
         * in CSS.** A hidden-by-CSS sidebar is in the first response, so the grid has both
         * its children from the first paint.
         *
         * The cost the old comment was avoiding is real and is paid differently: below
         * `lg` this panel is `display: none`, which takes it out of the accessibility tree
         * entirely, so a screen reader still meets exactly one set of nine controls even
         * while the sheet below is open.
         */}
        <aside className="hidden lg:block">
          <div className="sticky top-22">{panel}</div>
        </aside>

        <div className="min-w-0">
          {results.length > 0 ? (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {results.map((row) => (
                <li key={row.id} className="min-w-0">
                  {cardsById.get(row.id)}
                </li>
              ))}
            </ul>
          ) : (
            <div className="border border-line bg-panel px-6 py-14 text-center">
              <p className="text-lead text-chalk">{t('catalog.empty.title')}</p>
              <p className="mx-auto mt-2 max-w-[42ch] text-body text-chalk-2">
                {t('catalog.empty.body')}
              </p>
              <div className="mt-6 flex justify-center">
                <Button onClick={() => changeFilters(emptyFilters())}>{t('filter.clear')}</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <BottomSheet
        open={sheetOpen && !isDesktop}
        title={t('filter.title')}
        onClose={() => setSheetOpen(false)}
        footer={
          <Button variant="primary" className="w-full" onClick={() => setSheetOpen(false)}>
            {t('filter.showResults', { count: results.length })}
          </Button>
        }
      >
        {panel}
      </BottomSheet>
    </>
  );
}
