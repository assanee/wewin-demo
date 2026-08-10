import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PaymentIsland } from '@/components/payment/PaymentIsland';
import { localeBundle } from '@/i18n/server';
import { type LocaleRouteParams, localeFromSegment, localeStaticParams } from '@/lib/routing';

/**
 * `/[locale]/payment` — where a customer attaches a bank transfer slip to their order.
 *
 * Eight prerendered shells and nothing else, exactly like `/[locale]/orders`: what makes
 * this URL personal is `?order=<id>`, read in the browser by `PaymentIsland` rather than
 * through `params` or `searchParams`. A dynamic segment or a read `searchParams` here would
 * opt this route out of static rendering (plan 8.2 trap 2) for a value that is never the
 * same twice and belongs to exactly one signed-in customer.
 *
 * `revalidate` is not restated — `false` in the locale layout, inherited, and not
 * load-bearing here because there is nothing in the response that could go stale: the page
 * carries no order data at all, only the shell the island fills in.
 *
 * `noindex`, and no hreflang set — a customer's own payment screen, reachable only by
 * somebody signed in who owns the order named in the query string.
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
    title: localeBundle(locale).t('payment.meta.title'),
    robots: { index: false, follow: false },
  };
}

export default async function PaymentPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  /*
   * Checked and dropped: the segment must be one of the eight or this is a 404, and the
   * island reads the locale from `AppShell`'s provider — built from this same segment.
   * Passing it twice would be two sources of truth for one fact.
   */
  if (localeFromSegment((await params).locale) === null) notFound();

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="max-w-[860px]">
        <PaymentIsland />
      </div>
    </main>
  );
}
