import type { QuoteLine } from '@wewin/core/quote';
import type { Locale } from '../../i18n/locales';

/**
 * Where "edit this line" goes.
 *
 * ## Locale-prefixed — and the contrast with a share link is the point
 *
 * Two links leave this app carrying a configuration and they are prefixed differently
 * on purpose, so it is worth writing down once rather than discovering later:
 *
 * | link | path | who chooses the language |
 * |---|---|---|
 * | edit this line | `/de/products/awn-4t?line=…` | the reader, already — they are here |
 * | share this window | `/products/awn-4t?v=3&width=…` | the *recipient*, via `src/proxy.ts` |
 *
 * An internal navigation must keep the language the reader is in; dropping the prefix
 * would send a German customer through the proxy and back to whatever their cookie says,
 * which is at best a redirect and at worst a different language mid-session. A share link
 * must **not** carry it, because it is going to somebody else — `useLocale.tsx` in the
 * Vite app put it plainly: pinning a language into a link means a German customer sending
 * a drawing to a Thai installer and the installer getting German.
 *
 * ## `productId`, not `slug`
 *
 * A stored line records `productId`; the configurator route is keyed by slug. They are the
 * same string — `packages/core/src/data/products.ts` builds every product with
 * `id: row.slug` — and this is the only place in the quote screen that depends on it. Said
 * out loud here because it is the kind of coincidence that stops being true quietly: if
 * ids ever stop being slugs, this is the call site that breaks, and it breaks as a 404
 * rather than as a wrong window.
 *
 * ## A template literal, so `typedRoutes` can check it — and no cast
 *
 * `next.config.ts` turns `typedRoutes` on, which means `Link`'s `href` is the union of
 * routes that *exist*. Built through `localeHref` this would be a plain `string` and
 * `Link` would reject it; the usual escape is `as Route`, which is exactly the kind of
 * silent widening the house rules forbid. Written as a template literal instead, the
 * compiler matches it against the generated
 * `` `/${SafeSlug}/products/${SafeSlug}` `` plus a `?…` suffix, and a typo in the segment
 * — or the day this route is renamed — is a compile error at this line.
 *
 * `ButtonLink` next door is still a plain `<a>` with a note saying the routes did not
 * exist yet. They do now, and it can follow; that is not this file's to change.
 */
export const configureHref = (
  locale: Locale,
  line: QuoteLine,
): `/${Locale}/products/${string}?line=${string}` =>
  `/${locale}/products/${line.productId}?line=${line.lineId}`;
