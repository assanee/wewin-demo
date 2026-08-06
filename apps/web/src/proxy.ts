import { NextResponse, type NextRequest } from 'next/server';
import { negotiateLocale } from '@wewin/i18n/locales';

import { LOCALE_COOKIE, firstSegment, localeFromSegment, localeHref } from '@/lib/routing';

/**
 * The only thing standing between `/` and a locale-prefixed URL.
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated the older file convention and
 * warns on every build that still uses it. Same request, same hook, one rename.
 *
 * Every page in this app lives under `/[locale]/…` (see `src/lib/routing.ts` for why Thai
 * is prefixed too), so a request that arrives without a prefix has to be given one. That
 * is the whole job. It does not choose content, it does not read the catalogue, and it
 * never rewrites — a rewrite would leave the visitor on an unprefixed URL that is a second
 * address for a page that already has one.
 *
 * ── Three things this deliberately does *not* do ─────────────────────────────────
 *
 * **It does not run on `/[locale]/…`.** The first branch returns immediately. A middleware
 * that touched every request would be a per-request function call in front of 648 pages
 * whose entire point is that they are static.
 *
 * **It does not decide anything a cached page can see.** Plan 8.2's third trap is one
 * reader's preference being cached and served to another. The redirect below depends on a
 * cookie and on `Accept-Language`, so it is `Cache-Control: no-store` and carries the
 * `Vary` that says why. Get this wrong and a shared cache pins the first visitor's
 * language onto `/` for everyone behind it — the same failure as the price one, in the
 * layer above.
 *
 * **It does not fall back silently.** `negotiateLocale` returns `{ rendered, fallback }`;
 * a visitor whose browser asked for Korean lands on Thai *and the response says so*, which
 * is what a "we do not have your language yet" banner will need when somebody writes it.
 */
export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (localeFromSegment(firstSegment(pathname)) !== null) return NextResponse.next();

  /*
   * A choice the visitor made beats a preference their browser was configured with —
   * the same rule `useLocale.tsx` states for the stored key: "a visitor who picked Thai
   * on a German laptop meant it."
   */
  const chosen = request.cookies.get(LOCALE_COOKIE)?.value ?? '';
  const stored = localeFromSegment(chosen);
  const negotiated = negotiateLocale(request.headers.get('accept-language') ?? '');
  const locale = stored ?? negotiated.rendered;

  const url = request.nextUrl.clone();
  url.pathname = localeHref(locale, pathname);

  /*
   * 307 and not 308. A permanent redirect would be cached by the browser against `/`
   * forever, which is precisely wrong for a destination that depends on who is asking:
   * clearing the cookie would then not change where `/` goes.
   */
  const response = NextResponse.redirect(url, 307);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Vary', 'Accept-Language, Cookie');
  if (stored === null) {
    response.headers.set('X-Locale-Negotiated', negotiated.fallback ? 'fallback' : 'matched');
  }
  return response;
}

export const config = {
  /*
   * Everything except Next's own assets, route handlers, and any path with a dot in it
   * (`/favicon.ico`, `/icons.svg`, `/robots.txt`). A `.` is a cheap and complete stand-in
   * for "a file in `public/`", and getting it wrong means `/favicon.ico` redirecting to
   * `/th/favicon.ico` and 404ing.
   */
  matcher: ['/((?!_next/|api/|.*\\.).*)'],
};
