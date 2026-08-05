import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import { categories, products } from '@wewin/core/fixtures';
import {
  emptyFilters,
  filterProducts,
  isFilterActive,
  priceBounds,
  profileColorFacets,
  type CatalogFilters,
} from '@wewin/core/filters';
import { Button } from '../components/common/Button';
import { BottomSheet } from '../components/common/BottomSheet';
import { FilterPanel } from '../components/catalog/FilterPanel';
import { ProductCard } from '../components/catalog/ProductCard';
import { useIsDesktop } from '../state/useMediaQuery';
import { useLocale } from '../state/localeContext';

export function Catalog() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const { t, f } = useLocale();

  // The category facet lives in the URL so a category card links straight into a
  // filtered catalog and the result stays shareable. The rest is local state.
  const [localFilters, setLocalFilters] = useState<CatalogFilters>(emptyFilters());

  // Keyed on `searchParams` rather than on `getAll(...)`: useSearchParams returns a
  // stable instance that only changes when the URL does, whereas getAll allocates a
  // fresh array every render and would defeat both this memo and the one below it.
  const filters = useMemo<CatalogFilters>(
    () => ({ ...localFilters, categoryIds: searchParams.getAll('category') }),
    [localFilters, searchParams],
  );

  const setFilters = (next: CatalogFilters) => {
    setLocalFilters({ ...next, categoryIds: [] });

    const params = new URLSearchParams(searchParams);
    params.delete('category');
    for (const id of next.categoryIds) params.append('category', id);
    setSearchParams(params, { replace: true });
  };

  const colorFacets = useMemo(() => profileColorFacets(products), []);
  const bounds = useMemo(() => priceBounds(products), []);
  const results = useMemo(() => filterProducts(products, filters), [filters]);

  const clearAll = () => setFilters(emptyFilters());

  const panel = (
    <FilterPanel
      filters={filters}
      onChange={setFilters}
      categories={categories}
      colorFacets={colorFacets}
      bounds={bounds}
    />
  );

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="mb-6 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-title text-chalk lg:text-display">{t('catalog.heading')}</h1>
        <p className="numeric text-small text-chalk-2" aria-live="polite">
          {t('catalog.resultCount', { count: results.length })}
        </p>
      </div>

      {/* base/md: the filter trigger sits at the top of the page, not in a sidebar. */}
      <div className="mb-4 lg:hidden">
        <Button onClick={() => setSheetOpen(true)} className="w-full">
          <SlidersHorizontal size={18} aria-hidden />
          {t('filter.title')}
          {isFilterActive(filters) ? (
            <span className="numeric rounded-xs bg-sel-bg px-2 text-caption text-chalk">
              {f.integer(filters.categoryIds.length + filters.profileColorCodes.length)}
            </span>
          ) : null}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* Exactly one FilterPanel exists at a time. Rendering both and hiding one
            with CSS would put nine duplicate form controls in the DOM and, once the
            sheet is open, leave a second identical set of them behind it. */}
        {isDesktop ? (
          <aside>
            <div className="sticky top-22">{panel}</div>
          </aside>
        ) : null}

        <div className="min-w-0">
          {results.length > 0 ? (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {results.map((product) => (
                <li key={product.id} className="min-w-0">
                  <ProductCard product={product} />
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
                <Button onClick={clearAll}>{t('filter.clear')}</Button>
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
    </main>
  );
}
