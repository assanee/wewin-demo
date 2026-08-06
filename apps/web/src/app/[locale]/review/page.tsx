import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReviewFormIsland } from '@/components/reviews/ReviewFormIsland';
import { localeBundle } from '@/i18n/server';
import {
  type LocaleRouteParams,
  localeFromSegment,
  localeStaticParams,
} from '@/lib/routing';

/**
 * `/[locale]/review` — where an invitation lands.
 *
 * Eight prerendered shells and nothing else, exactly like `/[locale]/quote`: the thing that
 * makes this URL personal is `?t=<token>`, and the token is read in the browser by the
 * island. The page therefore has no dynamic segment, no `searchParams`, and nothing in its
 * cached HTML that belongs to one customer.
 *
 * `revalidate` is not restated — `false` in the locale layout, inherited, and on this route
 * not even load-bearing: there is nothing in the response that could go stale.
 *
 * **`noindex`, and unlike `/quote` there is no hreflang set either.** The cart's eight
 * shells are at least a real destination a crawler may reach from an indexed page; this one
 * is only ever reached from an email, with a token, and the eight URLs without one are
 * eight copies of a form nobody can submit. `follow` stays, because the links out of the
 * island go to the catalogue.
 */

export const generateStaticParams = localeStaticParams;

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  return {
    title: localeBundle(locale).t('review.meta.title'),
    robots: { index: false, follow: true },
  };
}

export default async function WriteReviewPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  // Checked and dropped: the segment must be one of the eight or this URL is a 404, and
  // the island reads the locale from `AppShell`'s provider — which the layout built from
  // this same segment. Passing it twice would be two sources of truth for one fact.
  if (localeFromSegment((await params).locale) === null) notFound();

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="max-w-[640px]">
        <ReviewFormIsland />
      </div>
    </main>
  );
}
