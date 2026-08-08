import { aboutHref, catalogHref, localeHome } from '../../lib/routing';
import { LOCALES, type Locale } from '../../i18n/locales';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHICH PAGES CARRY THE SHOP FRONT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The footer is the address, the three telephone numbers, the LINE handle and the opening
 * hours — marketing, for somebody who is still deciding. It belongs on the home page, the
 * catalogue and the about page, and not underneath a cart being filled in, a quotation being
 * read, or a form being typed into.
 *
 * ── ⚠️ Whole paths, never a prefix ───────────────────────────────────────────
 *
 * `AppHeader` states this rule and the reason it learned it: comparing whole hrefs rather
 * than testing a suffix is what keeps `/de/products/awn-4t` from lighting up the catalogue
 * link, because a product page is not the catalogue and `startsWith` would say it was.
 *
 * The same distinction decides the same way. `/products` is for browsing; a product page is
 * a configurator with a price and an "add" button, and it belongs with the cart.
 *
 * ── Why a function and not a list in the component ───────────────────────────
 *
 * Eight locales times three routes is twenty-four strings, and every one of them has to agree
 * with `lib/routing` or the footer disappears from a page nobody thought to check. Built from
 * the same builders `typedRoutes` checks, and tested against `LOCALES` so adding a ninth
 * language cannot leave it behind.
 */

/** Every path that carries it, for all eight locales, built from the routing helpers. */
const WITH_FOOTER: ReadonlySet<string> = new Set(
  LOCALES.flatMap((locale: Locale) => [localeHome(locale), catalogHref(locale), aboutHref(locale)]),
);

/**
 * ⚠️ A trailing slash is stripped, and nothing else is.
 *
 * A pasted `/th/products/` is the catalogue; `/th/products/awn-4t` is not, and no amount of
 * tidying should turn one into the other. `'/'` is not a rendered page at all — the proxy
 * redirects it to a locale — and defaulting to *showing* would put the shop front on whatever
 * a mistake produced.
 *
 * ⚠️ **`string | null`, though `usePathname` is typed `string`.** It answers `null` outside a
 * router, which is every server-side render in `tests/configurator-render.test.ts` and was a
 * crash the moment this shipped. The same shape of mistake as a zod rule claiming more than
 * the column holds, one floor up: a type that overstates what the runtime guarantees, quiet
 * at compile time and loud at render.
 */
export function showsFooter(pathname: string | null): boolean {
  if (pathname === null || pathname === '') return false;

  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;

  return WITH_FOOTER.has(path);
}
