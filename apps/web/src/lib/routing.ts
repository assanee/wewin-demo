import { INTL_TAG, LOCALES, SOURCE_LOCALE, isLocale, type Locale } from '@wewin/i18n/locales';

/**
 * Locale routing — the shape of every URL in this app, and the reason it is a path
 * segment rather than anything else.
 *
 * ── All eight are prefixed, Thai included ────────────────────────────────────────
 *
 * `/th/products/fold-nt-12`, not `/products/fold-nt-12`. The alternative — Thai served
 * unprefixed as the default and the other seven prefixed — is the more common pattern and
 * it is wrong for this app on three counts:
 *
 *   1. **The cache key.** Plan 8.7(2): "ISR without locale in the key serves the German
 *      page to a Thai reader." A path segment puts the locale in every cache key that
 *      exists — Next's, a CDN's, a browser's — *structurally*, because they are different
 *      URLs. Nothing has to remember to add it, and no `Vary: Accept-Language` has to be
 *      trusted. An unprefixed default reopens exactly that hole for the largest audience.
 *   2. **Two URLs for one document.** An unprefixed default means `/products/x` and
 *      `/th/products/x` are the same page, which is a canonicalisation problem across
 *      81 products before it is anything else.
 *   3. **`la`.** The segment `la` is Lao here and Latin in BCP 47 (see
 *      `@wewin/i18n/locales`). Keeping the project tag in the path and the ICU tag in
 *      `lang`/`hreflang` is only possible if there is a path segment to keep it in.
 *
 * The cost is that `wewin.example/` is a redirect rather than a page. `src/proxy.ts`
 * pays it once per visitor.
 *
 * ── Pure on purpose ──────────────────────────────────────────────────────────────
 *
 * Nothing here imports from `next/*`. It is called from `src/proxy.ts` (its own runtime),
 * from server components, and from tests that run under plain Node — a `notFound()` in the
 * middle of it would make two of those three impossible.
 */

/**
 * A locale's home route, as a type `typedRoutes` accepts.
 *
 * Next generates `RouteImpl<T>` from the routes that *exist*, and it is strict about it:
 * with only `src/app/[locale]/page.tsx` in the tree, `` `/${Locale}` `` type-checks and
 * `` `/${Locale}/${string}` `` does not, because there is no two-segment page to point at
 * yet. That is the check earning its keep rather than getting in the way — a link written
 * today to a page that arrives next week is a 404 that ships.
 *
 * So `Link` takes `localeHome`, and `localeHref` — which builds URLs for metadata and for
 * the proxy's redirect, neither of which goes through `Link` — stays a plain string. As
 * routes are ported, each gets its own helper with its own literal type, and the union
 * grows with the app instead of ahead of it.
 */
export type LocaleHome = `/${Locale}`;

/** The one route that exists today, typed so `Link` will accept it. */
export const localeHome = (locale: Locale): LocaleHome => `/${locale}`;

/**
 * Where a *chosen* language is remembered — a cookie, not `localStorage`.
 *
 * The Vite app keeps the choice in `localStorage` under `aluform.locale.v1`, which the
 * server cannot read, so the first paint is always Thai and the preference lands one
 * commit later (`useLocale.tsx` says so in as many words). That was acceptable when
 * nothing was rendered on a server. It is not acceptable now: the whole return on this
 * move is a crawlable, prerendered page per locale, and a preference the middleware cannot
 * see means the redirect from `/` ignores a choice the visitor has already made.
 *
 * So the language picker writes this cookie **as well as** the existing key — the cookie
 * is what the middleware reads, the storage key is what the client island reads before
 * hydration finishes. Writing the picker is a porting agent's job; naming the cookie once,
 * here, is what stops it being named twice.
 *
 * `Lax` and not `None`: it is read on a top-level navigation, which `Lax` sends.
 */
export const LOCALE_COOKIE = 'wewin.locale';

/** What the `[locale]` dynamic segment hands a layout or a page, before it is checked. */
export interface LocaleRouteParams {
  readonly locale: string;
}

/**
 * The eight, as `generateStaticParams` wants them.
 *
 * Paired with `export const dynamicParams = false` in the locale layout, this is what
 * makes the set of locales closed: a request for `/xx/products` 404s at the router
 * instead of rendering a page whose every string fell back to Thai.
 */
export const localeStaticParams = (): { readonly locale: Locale }[] =>
  LOCALES.map((locale) => ({ locale }));

/**
 * Narrow a raw segment to one of the eight, or `null`.
 *
 * Deliberately *not* falling back to `SOURCE_LOCALE`. A fallback here would turn an
 * unknown segment into a Thai page served at that segment's URL, which is the same
 * silently-plausible-wrong-answer failure `@wewin/i18n` documents for `Intl` and `la`.
 * The caller decides — the middleware redirects, the layout 404s.
 */
export const localeFromSegment = (segment: string): Locale | null =>
  isLocale(segment) ? segment : null;

/** The first path segment of a pathname, `''` for `/`. */
export const firstSegment = (pathname: string): string => pathname.split('/')[1] ?? '';

/**
 * A locale-prefixed href.
 *
 * `path` is the part *after* the locale. `localeHref('de', '/')` is `/de` and **not**
 * `/de/`: a trailing slash is a second URL for the same document, and Next redirects it,
 * costing a round trip on every link that carries one.
 *
 * It normalises the join rather than requiring the caller to have got it right, because
 * the two callers hand it two different things — a literal from a component, and
 * `nextUrl.pathname` from the proxy — and the alternative is a type assertion at the one
 * call site that has no literal to offer.
 */
export const localeHref = (locale: Locale, path: string): string => {
  const rest = path.startsWith('/') ? path.slice(1) : path;
  return rest === '' ? `/${locale}` : `/${locale}/${rest}`;
};

/**
 * `alternates.languages` for a route — the hreflang set, keyed by **ICU tag**.
 *
 * The keys are `INTL_TAG` values and not the path segments, and `la` is the whole reason
 * why: emitting `hreflang="la"` would tell every crawler in the world that the Lao pages
 * are written in Latin. The segment stays `la` because that is what the brief names and
 * what `aluform.locale.v1` in the Vite app already stores.
 *
 * `x-default` points at Thai — the source language and the fallback, so it is the one page
 * that is never a translation of anything.
 */
export const languageAlternates = (path: string): Readonly<Record<string, string>> => {
  const entries = LOCALES.map((locale) => [INTL_TAG[locale], localeHref(locale, path)] as const);
  return Object.fromEntries([...entries, ['x-default', localeHref(SOURCE_LOCALE, path)]]);
};

/* ------------------------------------------------------------------ *
 * The typed routes — folded back in from `lib/routes.ts` now the port is finished
 * ------------------------------------------------------------------ */

/**
 * `typedRoutes` builds `RouteImpl<T>` from the pages that **exist**, so a helper may only
 * claim a shape once the page under it is on disk. That is the check earning its keep: a
 * link written to a page arriving next week is a 404 that ships.
 *
 * These lived in `lib/routes.ts` for the length of the port — three agents were appending
 * to this file at once and one of them needed the catalogue's type before the other had
 * written the route. All five pages exist now, so the second file has no reason to and is
 * gone; `productHref` in particular could not be written at all until
 * `/[locale]/products/[slug]` landed, which is why `ProductCard` and `ButtonLink` both
 * shipped plain `<a>` elements with a note saying so.
 */

/** The catalogue — every product, one page per locale. */
export type CatalogRoute = `/${Locale}/products`;

/** One product's configurator page. */
export type ProductRoute = `/${Locale}/products/${string}`;

/** The quote list. */
export type QuoteRoute = `/${Locale}/quote`;

/** The about page. */
export type AboutRoute = `/${Locale}/about`;

/**
 * Display settings — language, unit and currency.
 *
 * `settings` and not `profile`, on all three surfaces (the API answers at `/me/preferences`
 * for the same reason). A "profile" is an account page, and this one holds no identity at
 * all: no name, no address, no contact channel, and it works perfectly well for a visitor
 * who has never signed in. The naming is the first line of defence against somebody putting
 * an email address on it — which is exactly the argument `packages/db/src/schema/profile.ts`
 * makes for keeping `user_preferences` off the `users` row.
 */
export type SettingsRoute = `/${Locale}/settings`;

/**
 * ⭐ Where a customer signs in, and sees what they have asked for.
 *
 * ⚠️ It exists as a *route* rather than as a panel inside the cart because a sign-in reachable
 * only through a cart is a sign-in nobody finds — the same failure `AppFooter` records for the
 * dashboard's `/quotes`, which shipped for a round with no entry in the menu.
 *
 * A customer who has already submitted has an **empty cart**, by design, so the cart is exactly
 * the wrong place to keep the only door.
 */
export type AccountRoute = `/${Locale}/account`;

/**
 * The catalogue with a facet preselected, as the object form `next/link` accepts.
 *
 * A `UrlObject` rather than a string, and the compiler is what decided it: `typedRoutes`
 * builds its union from the *pathnames* that exist, and a template type carrying a query
 * string is not one of them — `` `/de/products?category=${string}` `` is rejected even
 * though `/de/products` is fine. `Link` accepts `UrlObject` for exactly this case, and it
 * encodes the value itself, so there is no hand-rolled escaping to get wrong.
 */
export interface CatalogCategoryRoute {
  readonly pathname: CatalogRoute;
  readonly query: { readonly category: string };
}

export const catalogHref = (locale: Locale): CatalogRoute => `/${locale}/products`;

export const aboutHref = (locale: Locale): AboutRoute => `/${locale}/about`;

export const quoteHref = (locale: Locale): QuoteRoute => `/${locale}/quote`;

export const settingsHref = (locale: Locale): SettingsRoute => `/${locale}/settings`;

export const accountHref = (locale: Locale): AccountRoute => `/${locale}/account`;

/**
 * One product's page.
 *
 * `slug`, never `id`, even though `packages/core/src/data/products.ts` builds every product
 * with `id: row.slug` and the two are the same string today. The URL is the slug's job —
 * the day an id stops being a slug this breaks as a type error at the one call site that
 * passes the wrong field, rather than as a 404 in production.
 */
export const productHref = (locale: Locale, slug: string): ProductRoute =>
  `/${locale}/products/${slug}`;

/**
 * The catalogue with one category preselected.
 *
 * The query string is **not** read on the server — see the note at the top of
 * `app/[locale]/products/page.tsx`. Reading it there would make the route dynamic and hand
 * back the prerendering the move was made for. It is read by the filter island in the
 * browser, which is where a facet selection has lived since phase 2.
 */
export const catalogCategoryHref = (
  locale: Locale,
  categoryId: string,
): CatalogCategoryRoute => ({
  pathname: catalogHref(locale),
  query: { category: categoryId },
});
