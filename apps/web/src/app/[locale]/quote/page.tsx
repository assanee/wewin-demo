import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { QuoteScreen } from '@/components/quote/QuoteScreen';
import { localeBundle } from '@/i18n/server';
import {
  type LocaleRouteParams,
  languageAlternates,
  localeFromSegment,
  localeHref,
  localeStaticParams,
} from '@/lib/routing';

/**
 * `/[locale]/quote` — the cart.
 *
 * Eight prerendered shells, one per locale, and each one contains the language, the
 * title, the hreflang set and nothing else. The cart itself lives in `localStorage` and
 * arrives after hydration; see `QuoteScreen` for why that is the only place it can live
 * and why it is also the reason this page is safe to cache at all.
 *
 * `revalidate` is not restated here. It is `false` in the locale layout and inherited,
 * which is what the layout's note and `tests/cache-policy.test.ts` are both about — and
 * on this route it is not even load-bearing, because there is nothing in the response
 * that could go stale.
 */

export const generateStaticParams = localeStaticParams;

const PATH = '/quote';

/**
 * `params` only. Never `searchParams` — plan 8.2's second trap, and the layout spells out
 * what it costs. There is nothing in a query string this page would want anyway: the cart
 * is storage, not a URL.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const { t } = localeBundle(locale);

  return {
    title: t('quote.heading'),
    alternates: {
      canonical: localeHref(locale, PATH),
      languages: languageAlternates(PATH),
    },
    /*
     * **`noindex`, and the hreflang set stays anyway.**
     *
     * The two look contradictory and are not. Indexing is refused because the crawlable
     * content of this URL is one heading and an invitation — the eight locales' shells
     * differ only in their prose, and the thing a searcher would be looking for (their
     * own cart) is by construction not in the response. Eight near-identical pages with
     * no unique content is the definition of what `noindex` is for.
     *
     * `alternates` stays because `noindex` governs the index and `hreflang` governs the
     * *mapping between the eight*, which is still true and is still what a crawler should
     * be told when it follows a link here from a page that is indexed. Dropping it would
     * leave the seven other `/…/quote` URLs looking like unrelated documents.
     *
     * `follow` rather than `nofollow`: the links out of here go to the catalogue and the
     * configurator, which are the pages that *should* be crawled.
     */
    robots: { index: false, follow: true },
  };
}

export default async function QuotePage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  // Checked and then dropped: the segment has to be one of the eight or this URL is a
  // 404, but the screen itself reads the locale from `AppShell`'s provider — which the
  // layout built from this same segment. Passing it a second time would be a second
  // source of truth for one fact, and the two would be free to disagree.
  if (localeFromSegment((await params).locale) === null) notFound();

  return <QuoteScreen />;
}
