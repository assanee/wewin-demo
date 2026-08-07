import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { QuotationIsland } from '@/components/quotation/QuotationIsland';
import { localeBundle } from '@/i18n/server';
import { type LocaleRouteParams, localeFromSegment, localeStaticParams } from '@/lib/routing';

/**
 * `/[locale]/orders` — where an emailed quotation link lands.
 *
 * Eight prerendered shells and nothing else, exactly like `/[locale]/review` and for exactly
 * the same reason: what makes this URL personal is `?t=<token>`, and the token is read in the
 * browser by the island. No dynamic segment, no `searchParams`, and nothing in the cached HTML
 * that belongs to one customer.
 *
 * ⚠️ **The order id is not in the path**, though it would read better. `/orders/{id}?t=…`
 * would put a real order id in a URL that gets forwarded, pasted into a chat and logged by
 * every proxy between here and the customer — and it would invite exactly the handler shape
 * `document-link.controller.ts` refuses, where the id comes from the path and the signature is
 * merely checked beside it. The token names the order; nothing else needs to.
 *
 * `revalidate` is not restated — `false` in the locale layout, inherited, and not load-bearing
 * here because there is nothing in the response that could go stale.
 *
 * **`noindex`, and no hreflang set.** This URL is only ever reached from an email with a
 * token, and the eight URLs without one are eight copies of a page with nothing on it.
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
    title: localeBundle(locale).t('quotation.meta.title'),
    robots: { index: false, follow: false },
  };
}

export default async function QuotationPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  /*
   * Checked and dropped: the segment must be one of the eight or this is a 404, and the island
   * reads the locale from `AppShell`'s provider — built from this same segment. Passing it
   * twice would be two sources of truth for one fact.
   */
  if (localeFromSegment((await params).locale) === null) notFound();

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="max-w-[860px]">
        <QuotationIsland />
      </div>
    </main>
  );
}
