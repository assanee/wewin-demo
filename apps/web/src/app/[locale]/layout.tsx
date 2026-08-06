import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { INTL_TAG, LOCALE_SCRIPT, LOCALES } from '@wewin/i18n/locales';

import { AppShell } from '@/components/shell/AppShell';
import { FONT_VARIABLE_CLASSES } from '../fonts';
import '../globals.css';
import { type LocaleRouteParams, localeFromSegment, localeStaticParams } from '@/lib/routing';

/**
 * The **root** layout, and it lives inside a dynamic segment on purpose.
 *
 * There is no `src/app/layout.tsx`. Every route in this app is under `/[locale]`, so this
 * is the first layout on every request — which is the only arrangement in which
 * `<html lang>` can be a fact about the *response*.
 *
 * Plan 8.7(1) is the debt this pays, and it is worth restating because it is easy to read
 * as cosmetic. In the Vite app `document.documentElement.lang` is written from a
 * `useEffect` after hydration, and `<title>` and `<meta description>` are hard-coded Thai
 * in `index.html`. A crawler that reads the first response — which is every crawler —
 * gets Thai for all eight languages, and there is nowhere inside `<head>` to mark it,
 * because `lang` is not an attribute `<head>` children carry. Six of eight locales were
 * therefore serving Thai prose while claiming to be another language. Rendering `<html>`
 * here is what makes that stop being true.
 */

/*
 * The eight, prerendered. `dynamicParams = false` closes the set: `/xx/products` 404s at
 * the router rather than rendering a page whose every string quietly fell back to Thai —
 * which would look like a working page in a language nobody asked for.
 */
export const dynamicParams = false;
export const generateStaticParams = localeStaticParams;

/**
 * **No time-based revalidation anywhere in this app**, and this line is where that is
 * decided rather than merely intended.
 *
 * Plan 8.2 opens with it: ISR at `revalidate = 3600` shows an hour-old price while the API
 * prices from live Postgres, which is risk 1 — "the screen disagrees with the invoice" —
 * reintroduced by a caching decision, in a codebase that spent five phases closing it in
 * the domain. The answer is not a shorter interval. A shorter interval is a smaller window
 * in which the same bug is true, and there is no interval at which it is false.
 *
 * So: pages are cached until something *says* they changed. `false` here is inherited by
 * every route below, and `tests/cache-policy.test.ts` fails the suite if any file under
 * `src/app` exports a numeric `revalidate` — a porting agent reaching for 3600 has to
 * delete a test that says why, in front of a reviewer.
 *
 * ⚠️ **`revalidate = false` is not the same statement as the response's header, and 6b's
 * adversarial pass caught the difference.** Next answers `false` with
 * `Cache-Control: s-maxage=31536000` — a year, which is 8,760× the interval this comment
 * calls unacceptable, addressed to every shared cache between here and a reader. The
 * segment config is the right choice and it is not where that is fixable; `next.config.ts`
 * bounds the header to ten minutes with a day of `stale-while-revalidate`, and
 * `tests/cache-policy.test.ts` fails if that number ever reaches an hour.
 *
 * 🔴 **What is not built, and must be before a price is rendered on a cached page.** The
 * plan requires two things and this is one of them. The other two are somebody else's and
 * are still open:
 *
 *   - `revalidateTag('product:' + id)` called from the dashboard's publish action. There
 *     is deliberately no route handler for it here: an invalidation endpoint that nothing
 *     calls is the exact failure plan 7.18(ข) names as the most expensive of its round —
 *     finished, tested, and wired to nothing — and it would read as coverage while leaving
 *     the window wide open. It gets written in the commit that also calls it.
 *   - `priceVersion` travelling with the payload, and the API refusing an order line whose
 *     version does not match. That is the half that makes a stale page *fail* rather than
 *     quietly bill a different number, and no amount of correct caching substitutes for it.
 *
 * Until both exist, a page under this layout may render a product's name and its shape.
 * It may not render a price **that came from a fetch**. The prices it does render come
 * from `@wewin/core/fixtures`, compiled in by `tsc` — see the long note in `ProductCard`,
 * which was corrected in the commit that closed 6b: the fixture and the database are bound
 * by `apps/api/tests/catalog-fidelity.pg.test.ts` in CI and by nothing at run time, and
 * `revalidateTag` cannot be the remedy for a module read rather than a cached fetch.
 */
export const revalidate = false;

/**
 * `params` only. **Never `searchParams`** — plan 8.2's second trap.
 *
 * Reading `searchParams` in `generateMetadata` opts the whole route out of static
 * rendering, silently: no prerender, no ISR, a function invocation per request, and no
 * error anywhere to say so. On 648 pages whose only reason to exist in Next.js is that
 * they are crawlable and prerendered, that is the entire return on this move, given away
 * by a destructure.
 *
 * **The choice, stated:** these routes are static, and query strings are read by the
 * client island and nowhere else. That is not a compromise — it is what the configurator
 * already is (plan 8.1). A share link's `?width=…&v=3` is *configuration*, the island
 * computes from it in the browser, and the metadata of the page it lands on describes the
 * product rather than the configuration. `tests/cache-policy.test.ts` scans for a
 * `searchParams` reaching a `generateMetadata` and fails if one does.
 *
 * **`alternates` is deliberately absent here.** Metadata set in a layout is inherited by
 * every page beneath it, so a `canonical` here would give all 81 product pages the home
 * page's URL. Each route calls `languageAlternates(itsOwnPath)` in its own
 * `generateMetadata`; `page.tsx` next door is the worked example.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleRouteParams>;
}): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  return {
    /*
     * `metadataBase` decides whether the hreflang and canonical URLs each route emits come
     * out absolute. Left to a variable rather than hard-coded because a preview deployment
     * that advertises production's canonical URL is worse than one that advertises none.
     */
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3002'),
    /*
     * A brand, not a sentence — the localised default (`meta.title`, `meta.description` in
     * the app's 205-key catalogue) arrives with the catalogue itself, which is a porting
     * agent's to move. Naming a Thai sentence here as the default for all eight would
     * recreate the exact `index.html` problem this layout exists to fix.
     */
    title: { default: 'WEWIN180', template: '%s · WEWIN180' },
    openGraph: {
      locale: INTL_TAG[locale],
      alternateLocale: LOCALES.filter((other) => other !== locale).map((other) => INTL_TAG[other]),
    },
  };
}

export default async function LocaleRootLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<LocaleRouteParams>;
}) {
  const locale = localeFromSegment((await params).locale);
  if (locale === null) notFound();

  return (
    /*
     * `lang` is the **ICU tag**, not the path segment, and `la` is the whole reason. The
     * segment is `la`, which in BCP 47 is Latin, the dead language — `@wewin/i18n/locales`
     * spends a header on what that did to `Intl`. Writing `lang="la"` here would hand a
     * screen reader a Latin voice for Lao text and tell a hyphenation engine the same lie.
     * `INTL_TAG.la` is `lo-LA`.
     *
     * `data-script` carries the one per-script override plan 8.3 allows — the reading
     * leading, dropped for Han only. It is an attribute rather than a class because it is
     * not something a utility may name: see the note in globals.css.
     */
    <html
      lang={INTL_TAG[locale]}
      data-script={LOCALE_SCRIPT[locale]}
      className={FONT_VARIABLE_CLASSES}
    >
      <body>
        {/*
         * The header, the footer and the four providers, mounted once for every route
         * below. Through the port each island mounted its own set because three agents
         * were writing three routes onto this one file; `AppShell`'s header says what
         * "as a set" costs if it is ever undone.
         *
         * `children` is a server tree passed through a client component, which leaves it
         * a server tree: `/th/products` still ships its 81 `<article>` elements in the
         * prerendered HTML.
         */}
        <AppShell locale={locale}>{children}</AppShell>
      </body>
    </html>
  );
}
