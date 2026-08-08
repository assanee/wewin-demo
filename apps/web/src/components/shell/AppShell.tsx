'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Locale } from '../../i18n/locales';
import { LocaleProvider } from '../../state/LocaleProvider';
import { QuoteProvider } from '../../state/QuoteContext';
import { SessionProvider } from '../../state/SessionProvider';
import { DisplayUnitProvider } from '../../state/useDisplayUnit';
import { useLocale } from '../../state/localeContext';
import { ToastProvider } from '../common/Toast';
import { AppFooter } from './AppFooter';
import { showsFooter } from './footer-routes';
import { AppHeader } from './AppHeader';

/**
 * The four providers and the chrome, mounted **once**, above every route.
 *
 * ## Why this file exists at all
 *
 * Through the port each island mounted its own copy — `ConfiguratorIsland`, `QuoteScreen`
 * and `CatalogBrowser` each wrapped themselves in what they needed, because three agents
 * were porting three routes onto one layout at the same time and the layout was the file
 * they would all have collided in. Every one of them left the same note: *these move up as
 * a set*. This is that move, and "as a set" is the load-bearing half of it — two
 * `QuoteProvider`s in one tree are two independent carts writing `aluform.quote.v1` over
 * each other, and the symptom is a line that disappears when you navigate rather than an
 * error anybody could search for. `tests/quote-cart.test.ts` fails if a second mount
 * appears anywhere.
 *
 * ## Order, which is an argument and not an accident
 *
 * Locale is outermost: everything below it reads its words from there, the unit picker's
 * own labels included. `DisplayUnitProvider` and `QuoteProvider` are both *preferences of
 * a reader* and both sit above the routes rather than inside a page, because the unit
 * follows a customer from the catalogue into the configurator and the cart follows them
 * everywhere — which is exactly where `apps/web/src/App.tsx` put them for four phases.
 *
 * ## `children` is a server tree, and it stays one
 *
 * This component is `'use client'`; the pages it wraps are not. Passing a server-rendered
 * tree through a client component as `children` keeps it server-rendered — the boundary is
 * where the *element* is created, not where it is placed. So `/th/products` still ships 81
 * server-rendered `<article>` elements inside a header and footer that hydrate.
 *
 * ## The one thing that is not here
 *
 * There is no `<main>` element and no `id="main"` wrapper around a route's own `<main>`;
 * the skip link points at the wrapper below and each page keeps whatever landmark it had.
 * Nesting a `<main>` inside a `<main>` is invalid and a screen reader announces the outer
 * one, which would make the skip link land above the header it was meant to skip.
 */
export function AppShell({
  locale,
  children,
}: {
  /** Narrowed from the `[locale]` segment by the layout. Never guessed, never stored. */
  readonly locale: Locale;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <LocaleProvider locale={locale}>
      <DisplayUnitProvider>
        <QuoteProvider>
          <SessionProvider>
          <ToastProvider>
            {/* Subtract the sticky bar's reservation from the full-height shell. A plain
                min-h-dvh is measured against the viewport and ignores the body padding, so
                on a short page the footer gets pushed to the viewport bottom and lands
                underneath the bar even though the space below it was reserved. */}
            <div className="flex min-h-[calc(100dvh-var(--sticky-bar-height,0px))] flex-col">
              <SkipLink />
              <AppHeader />
              <div id="main" className="flex-1">
                {children}
              </div>
              {/*
                ⭐ The shop front, on the three pages somebody is still deciding on.

                ⚠️ `usePathname` and not `useSearchParams`. `state/useUrlSearch.ts` explains
                the difference at length: a search parameter only exists per request and
                reading one makes a statically rendered route dynamic. A pathname is part of
                the route itself, which is why `AppHeader` already reads it for its active
                state and why the eight prerendered shells stay prerendered.
              */}
              {showsFooter(pathname) ? <AppFooter /> : null}
            </div>
          </ToastProvider>
          </SessionProvider>
        </QuoteProvider>
      </DisplayUnitProvider>
    </LocaleProvider>
  );
}

/**
 * Its own component only because it needs the locale, and the locale comes from a provider
 * `AppShell` itself renders — a hook call up there would be reading the context from
 * outside it.
 */
function SkipLink() {
  const { t } = useLocale();

  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-sel-line focus:bg-panel focus:px-4 focus:py-2 focus:text-body"
    >
      {t('a11y.skipToContent')}
    </a>
  );
}
