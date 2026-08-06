'use client';

import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import { formattersFor } from '../i18n/format';
import { resolveContent } from '../i18n/content';
import type { Locale } from '../i18n/locales';
import { renderMessage } from '../i18n/messages';
import { translatorFor } from '../i18n/translate';
import { LOCALE_COOKIE, localeHref } from '../lib/routing';
import { LocaleCtx, type LocaleContextValue } from './localeContext';

/**
 * The language the page is *read* in — presentation, and nothing else.
 *
 * ## What changed from `apps/web/src/state/useLocale.tsx`, and why it is the whole point
 *
 * The Vite provider **discovers** the locale: it starts at Thai, reads
 * `aluform.locale.v1` from `localStorage` in a mount effect, falls back to
 * `navigator.languages`, and then writes `document.documentElement.lang` and
 * `document.title` from a second effect. Every one of those steps is a browser fact
 * arriving after the first paint, which is exactly why plan 8.7(1) records that six of
 * the eight locales served Thai prose while claiming to be another language.
 *
 * Here the locale is a **prop**, narrowed from the `[locale]` path segment by the
 * server component that renders this. That single change removes four things at once:
 *
 *   1. **The hydration hazard.** A value read from `localStorage`, `navigator` or a
 *      cookie differs between the server render and the client render, and React
 *      answers a mismatch by silently re-rendering rather than by telling you. A prop
 *      that came out of the URL is the same value on both sides *by construction* —
 *      the URL is the one piece of state both halves can see.
 *   2. **The first-paint flash.** There is no "always Thai for one commit" any more.
 *   3. **`<html lang>`.** Written by the root layout from the same segment, in the
 *      response. Nothing here touches `document`.
 *   4. **`document.title`.** `generateMetadata` per route, served rather than assigned.
 *
 * There is deliberately **no `localStorage` read at all**. A stored preference that
 * disagrees with the URL is not a preference to honour — it is a request to be at a
 * different URL, and answering it by re-rendering this page in another language would
 * leave `<html lang>`, the canonical link and every `hreflang` describing a page that
 * is no longer on screen.
 *
 * ## `setLocale` is a navigation, and that is not a workaround
 *
 * In the Vite app changing language was a `setState`. Here the language *is* the route,
 * so changing it is a navigation — and it has to be, or the two would disagree. The
 * cookie named in `lib/routing.ts` is written first so that the next visit to an
 * unprefixed URL (`/`) negotiates to the same choice; `src/proxy.ts` is the reader.
 *
 * `window` appears once, in a callback, and never on a render path — the property spec
 * section 12 has kept true for five phases and this round is not spending.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  /** Narrowed from the `[locale]` segment by a server component. Never guessed. */
  readonly locale: Locale;
  readonly children: ReactNode;
}): ReactElement {
  const setLocale = useCallback(
    (next: Locale) => {
      // A year, `Lax`, path `/`. Read by the proxy on the next unprefixed request; see
      // `LOCALE_COOKIE` for why the cookie exists at all rather than a storage key.
      try {
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // A cookie-less browser still gets the navigation below; only the *next*
        // visit to `/` loses the memory of the choice.
      }

      // The same path under the other locale, query string and hash carried, so a
      // shared configuration survives a language switch. A full document load rather
      // than `router.push`: the whole document changes language, including `<html lang>`
      // and the font stack's per-script leading, and those come from the response.
      const { pathname, search, hash } = window.location;
      const rest = pathname.split('/').slice(2).join('/');
      window.location.assign(`${localeHref(next, `/${rest}`)}${search}${hash}`);
    },
    [],
  );

  const value = useMemo<LocaleContextValue>(() => {
    const { t, td } = translatorFor(locale);

    return {
      locale,
      setLocale,
      t,
      td,
      f: formattersFor(locale),
      message: (item) => renderMessage(item, locale),
      content: (ref, th) => resolveContent(ref, th, locale),
    };
  }, [locale, setLocale]);

  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}
