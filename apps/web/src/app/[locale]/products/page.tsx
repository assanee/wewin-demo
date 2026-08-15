import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { products } from '@wewin/core/fixtures';

import { loadProductsNotInFixtures } from '@/lib/catalog/published-product';

import { CatalogBrowser, type CatalogCard } from '@/components/catalog/CatalogBrowser';
import { ProductCard } from '@/components/catalog/ProductCard';
import { localeBundle } from '@/i18n/server';
import { LocaleProvider } from '@/state/LocaleProvider';
import {
  type LocaleRouteParams,
  languageAlternates,
  localeFromSegment,
  localeStaticParams,
} from '@/lib/routing';

/**
 * The catalogue — 81 products × 8 locales, prerendered.
 *
 * This is the page the whole phase was costed against. Plan 8.1 says the RSC win is the
 * catalogue and not the configurator, and this file is what that sentence buys: every
 * product name, summary, price, size range and link is in the HTML of the first response,
 * in eight languages, with no JavaScript required to read any of it.
 *
 * ## `generateStaticParams`, and the one line that would undo it
 *
 * Eight params, `dynamicParams = false` inherited from the locale layout, `revalidate =
 * false` likewise. What is **not** here is a `searchParams` argument — not on the page and
 * not on `generateMetadata`. Plan 8.2's second trap is written about `generateMetadata`,
 * and it is worth saying that the page signature is the same trap through a different
 * door: destructuring `searchParams` in either turns a prerendered route into a per-request
 * render, silently, with no error and no warning anywhere.
 *
 * The category facet still works, and `CatalogBrowser` documents how: the deep link from
 * the home page is read in the browser, after mount, which is where a facet selection has
 * lived since phase 2 anyway. What that costs is one commit's delay before a deep-linked
 * facet applies. What it buys is the page.
 *
 * ## Where the split falls
 *
 * `ProductCard` is a server component and is called 81 times here. The cards are handed to
 * the client island as already-rendered nodes, so what reaches the browser from this route
 * is the filter panel, the sheet and the predicate — not `lucide-react`'s icon set for 81
 * cards, not `@wewin/core/elevation`, not the drawing geometry.
 */

export const generateStaticParams = localeStaticParams;

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const { t } = localeBundle(locale);

  return {
    // `catalog.heading` rather than a hard-coded brand: this is the string plan 8.7(1) is
    // about. Six of the eight fall back to Thai and that is the honest state — but the
    // response now says `<html lang="de">` around a Thai title instead of claiming German
    // prose, and the crawler reads a title that belongs to *this* page rather than the one
    // sentence `index.html` had for all of them.
    title: t('catalog.heading'),
    description: t('meta.description'),
    alternates: {
      canonical: `/${locale}/products`,
      languages: languageAlternates('/products'),
    },
  };
}

export default async function CatalogPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const l = localeBundle(locale);

  /*
   * ⭐ The 81 compiled in, then anything the dashboard has published since.
   *
   * ⚠️ Fixtures first and fixtures win — see `loadProductsNotInFixtures`. Their cards are
   * unchanged, so this page's output for the seeded catalogue is what it was; the fetch only
   * ever *adds*. On a machine that cannot reach the API it adds nothing and the page is
   * exactly the one it has always been, which is why this cannot break a build.
   *
   * ⛔ Without this, a product created in the dashboard had a working page that nothing on
   * the site linked to — reachable only by typing its URL. A shop whose catalogue omits a
   * product it will happily sell is a shop that does not sell it.
   */
  const fromDatabase = await loadProductsNotInFixtures(new Set(products.map((p) => p.slug)));
  const shown = [...products, ...fromDatabase];

  const cards: readonly CatalogCard[] = shown.map((product) => ({
    id: product.id,
    card: <ProductCard product={product} l={l} />,
  }));

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      {/*
       * The client island's own locale, handed down from the segment rather than
       * discovered. `LocaleProvider` is the configurator's port of `useLocale` and it takes
       * the locale as a prop for exactly this reason: the URL is the one piece of state the
       * server render and the client render can both see, so a value taken from it cannot
       * disagree across hydration.
       */}
      <LocaleProvider locale={locale}>
        <CatalogBrowser
          cards={cards}
          initialCountLabel={l.t('catalog.resultCount', { count: shown.length })}
        />
      </LocaleProvider>
    </main>
  );
}
