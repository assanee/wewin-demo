import { describe, expect, it } from 'vitest';

import { LOCALES } from '../src/i18n/locales';
import { showsFooter } from '../src/components/shell/footer-routes';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE FOOTER IS MARKETING, AND THREE PAGES ARE MARKETING.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The address, the three telephone numbers, the LINE handle, the opening hours: that is a
 * shop front. It belongs on the pages somebody is *deciding* on — the home page, the
 * catalogue and the about page — and not underneath a cart they are filling in, a quotation
 * they are reading, or a form they are typing into.
 *
 * ── ⚠️ Whole paths, never a prefix ───────────────────────────────────────────
 *
 * `AppHeader` states the rule this reuses and the reason: comparing whole hrefs rather than
 * testing a suffix is what keeps `/de/products/awn-4t` from lighting up the catalogue link,
 * because a product page is not the catalogue and `startsWith` would say it was.
 *
 * The same distinction decides the same way here. `/products` is a page for browsing; a
 * product page is a page for configuring, with a price and an "add" button, and it sits with
 * the cart rather than with the shop front.
 */

describe('⭐ three pages carry the footer', () => {
  it.each([...LOCALES])('for %s: home, catalogue, about', (locale) => {
    expect(showsFooter(`/${locale}`)).toBe(true);
    expect(showsFooter(`/${locale}/products`)).toBe(true);
    expect(showsFooter(`/${locale}/about`)).toBe(true);
  });

  it.each([...LOCALES])('and nothing else does, for %s', (locale) => {
    for (const path of ['/quote', '/orders', '/review', '/settings']) {
      expect(showsFooter(`/${locale}${path}`), path).toBe(false);
    }
  });

  it('⭐ a product page is not the catalogue', () => {
    /*
     * The case a `startsWith` would get wrong, and the one `AppHeader` already learned. It is
     * a configurator: a price, a size, an "add to cart". The shop front belongs on the page
     * that led there, not on the page doing the work.
     */
    expect(showsFooter('/th/products/awn-4t')).toBe(false);
    expect(showsFooter('/de/products/lvr-adj')).toBe(false);
  });

  it('⚠️ tolerates a trailing slash, which a pasted link often has', () => {
    expect(showsFooter('/th/products/')).toBe(true);
    expect(showsFooter('/th/')).toBe(true);
  });

  it('⭐ shows nothing when there is no router at all', () => {
    /*
     * `usePathname` is typed `string` and answers `null` outside a router — which is every
     * server-side render in `tests/configurator-render.test.ts`. Shipping this without the
     * guard crashed fourteen of them, and the type said nothing.
     */
    expect(showsFooter(null)).toBe(false);
  });

  it('⚠️ shows nothing for a path with no locale', () => {
    /*
     * `/products` with no locale is the proxy's business, not a rendered page — and defaulting
     * to *showing* would put the shop front on whatever a mistake produced.
     */
    expect(showsFooter('/products')).toBe(false);
    expect(showsFooter('/')).toBe(false);
    expect(showsFooter('')).toBe(false);
  });
});
