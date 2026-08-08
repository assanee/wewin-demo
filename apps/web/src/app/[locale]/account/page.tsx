import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AccountScreen } from '@/components/account/AccountScreen';
import { localeBundle } from '@/i18n/server';
import { type LocaleRouteParams, localeFromSegment, localeStaticParams } from '@/lib/routing';

/**
 * `/[locale]/account` — sign in, and see what has been asked for.
 *
 * Eight prerendered shells and nothing else: everything personal arrives after hydration, from
 * a session this bundle has to *ask* the API about, because the refresh cookie is `__Host-`
 * prefixed and belongs to the API's origin.
 *
 * ⚠️ It is a route rather than a panel in the cart because a customer who has already submitted
 * has an **empty cart** — the cart is cleared on success, deliberately — so the cart was the
 * one place the door could not be. `AppFooter` records the same lesson from the dashboard's
 * `/quotes`: a screen reachable only by typing a URL is a screen nobody uses.
 *
 * `noindex`: there is nothing here for a crawler, and the eight URLs without a session are
 * eight copies of a sign-in form.
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
    title: localeBundle(locale).t('account.myQuotations'),
    robots: { index: false, follow: true },
  };
}

export default async function AccountPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  if (localeFromSegment((await params).locale) === null) notFound();

  return (
    <main className="container-page py-6 md:py-8 lg:py-10">
      <div className="max-w-130">
        <AccountScreen />
      </div>
    </main>
  );
}
