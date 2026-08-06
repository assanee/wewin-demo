import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SettingsScreen } from '@/components/settings/SettingsScreen';
import { localeBundle } from '@/i18n/server';
import {
  type LocaleRouteParams,
  languageAlternates,
  localeFromSegment,
  localeStaticParams,
} from '@/lib/routing';

/**
 * Display settings — language, measurement unit, currency.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THIS FILE IS A SERVER COMPONENT AND MUST STAY ONE. PLAN 8.2, TRAP 3.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The trap: *currency and display unit are per-user preferences and are in no cache key,
 * while `ProductCard` already renders `formatBaht` on the server.* A page about preferences
 * is the single most tempting place in this app to read one during a render — a `cookies()`
 * call, a `fetch` of `/me/preferences`, an `await` on a session — and every one of those
 * silently converts trap 3 into trap 2: no prerender, no ISR, a function invocation per
 * request, and **no error anywhere to say so**. 6b measured it: `const unit = (await
 * cookies()).get('…')?.value` in a server component turned `○ /[locale]/products` into
 * `ƒ /[locale]/products` in the build log, with 243/243 tests still green.
 *
 * So what this file renders is **the same eight documents for every visitor**: eight
 * prerendered pages, one per locale, containing headings and prose and not one byte that
 * depends on who asked. Everything that varies per reader is inside `<SettingsScreen />`,
 * which is `'use client'` and does its work after hydration.
 *
 * `tests/preferences-cache.test.ts` is the guard, and it is deliberately wider than the rule
 * it enforces: it fails on a `fetch(` or a request-time API in any non-client module, on any
 * server module importing `lib/preferences/client`, and it is mutation-tested against a
 * planted violation so it cannot rot into an assertion that always passes.
 *
 * ── How the preference reaches the reader, since none of it happens here ─────────
 *
 * Through the two mechanisms an anonymous visitor already uses, unchanged:
 *
 *   **language** is the first path segment, so it is in every cache key structurally. Choosing
 *   one writes the `wewin.locale` cookie and navigates — `LocaleProvider.setLocale`, which the
 *   header's `LanguagePicker` has always called. The cached page is not modified; a different
 *   cached page is served.
 *
 *   **unit** is `DisplayUnitProvider`'s `localStorage` key, and the server already rendered all
 *   five units into every cached page (`components/catalog/unitVariants.ts`). The island picks
 *   between strings Node produced from `bigint` micrometres; nothing is converted in a browser.
 *
 * An account adds *durability*, not a channel: signing in makes the same two choices survive a
 * new device. That is why nothing about the cached storefront had to move to support it.
 */

export const generateStaticParams = localeStaticParams;

/**
 * `params` only, never `searchParams` — plan 8.2's second trap, and `cache-policy.test.ts`
 * scans for it. There is nothing this page could usefully read from a query string anyway:
 * a preference passed in a URL is a preference that ends up in somebody's shared link.
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
    title: t('settings.meta.title'),
    description: t('settings.intro'),
    alternates: {
      canonical: `/${locale}/settings`,
      languages: languageAlternates('/settings'),
    },
    /*
     * Not a page for a crawler. It has no content of its own — it is a control panel — and
     * eight indexed copies of a settings form compete with the catalogue pages that are the
     * reason this app is prerendered at all.
     */
    robots: { index: false, follow: true },
  };
}

export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}) {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  const { t } = localeBundle(locale);

  return (
    <main className="container-page py-12 md:py-16">
      <div className="max-w-180">
        <h1 className="text-display text-chalk">{t('settings.heading')}</h1>
        <p className="mt-5 text-lead text-chalk-2">{t('settings.intro')}</p>
      </div>

      {/*
       * The island. Everything below this line is decided in the browser: which language is
       * selected, which unit, whether there is a session, and what the API says each setting
       * actually changes.
       *
       * It takes no props. A prop would have to be computed here, on the server, from
       * something — and the only somethings available are the request and a fetch, which are
       * the two doors this file exists to keep shut.
       */}
      <SettingsScreen />
    </main>
  );
}
