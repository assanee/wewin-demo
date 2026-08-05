import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { formattersFor } from '../i18n/format';
import { resolveContent } from '../i18n/content';
import { isLocale, negotiateLocale, SOURCE_LOCALE, type Locale } from '../i18n/locales';
import { renderMessage } from '../i18n/messages';
import { translatorFor } from '../i18n/translate';
import { LocaleCtx, type LocaleContextValue } from './localeContext';

const STORAGE_KEY = 'aluform.locale.v1';

/**
 * The language the site is *read* in — presentation, and nothing else.
 *
 * This is the display-unit rule (see `useDisplayUnit.tsx`) restated for language, and
 * it is the property this round has to protect:
 *
 *   **Changing the language must not move a number.**
 *
 * A price is ฿8,791 in all eight. Burmese writes it `၈,၇၉၁` and Hindi groups it by
 * lakh; neither is a different amount. The guarantee is structural rather than
 * careful — money stays `bigint` satang and lengths stay `bigint` micrometres until
 * they reach `Formatters`, every arithmetic step inside it is core's, and the locale
 * is not an argument to any of them. `numerals.test.ts` is where that is pinned, the
 * same way phase 2 pinned it for units.
 *
 * ## Deliberately outside the configurator's History
 *
 * The provider sits above the routes, so `useConfigurator` never sees a locale change
 * and Ctrl+Z cannot take one back. Undo exists to retract an edit, and reading a
 * drawing in German is not one — burying a real size change under three language
 * switches is how undo stops being worth pressing. Word for word the argument
 * `useDisplayUnit` makes, because it is the same argument.
 *
 * ## And deliberately not in the share link
 *
 * `buildShareUrl` carries the sizes and the units they were typed in, and neither the
 * display unit nor the language. A link is the *configuration*; the recipient reads it
 * in whatever they themselves prefer. Pinning a language into a link would mean a
 * German customer sending a drawing to a Thai installer and the installer getting
 * German.
 *
 * ## What this is *not* enough for
 *
 * Plan 10.6 splits two cases: a notification renders in the recipient's preference at
 * the moment it is sent, and a document renders in the locale pinned at
 * `submit_for_payment`, because a quotation reprinted next year in another language is
 * not the same document. This preference is the first of those. Nothing in this app
 * issues a document yet — the quote list is a cart, and its stored lines carry
 * locale-free `Message` values precisely so they can be read in whatever the customer
 * prefers *today*. The pin belongs with the other seven frozen values in plan 7.13, on
 * the API side, and is not built here rather than built here and left uncalled.
 */
export function LocaleProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<{ locale: Locale; hydrated: boolean }>({
    locale: SOURCE_LOCALE,
    hydrated: false,
  });

  // Read on mount rather than in the initialiser, the way the display unit and the
  // quote both do: localStorage during render closes off the SSR path spec section 12
  // keeps open. The consequence is deliberate and identical — the first paint is
  // always Thai and a saved preference lands one commit later.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode. No preference is the default preference, not a broken page.
    }

    // A stored value we do not recognise is a preference from a build with a different
    // locale set, or one somebody hand-edited. Falling back beats throwing over a key
    // the customer cannot see, let alone repair.
    const restored = isLocale(stored)
      ? stored
      : // Nothing stored: ask the browser once, and only once. After a choice has been
        // made, the browser's list is no longer evidence of anything — a visitor who
        // picked Thai on a German laptop meant it.
        (negotiateLocale(typeof navigator === 'undefined' ? [] : navigator.languages) ??
        SOURCE_LOCALE);

    setState((previous) => (previous.hydrated ? previous : { locale: restored, hydrated: true }));
  }, []);

  // The document's own language, so the browser hyphenates and a screen reader picks
  // the right voice. Individual fallbacks to Thai mark themselves `lang="th"` at the
  // element — see `CatalogText` and `IssuePanel` — which is what makes a German page
  // reading a Thai product name announce it in Thai rather than mangle it.
  //
  // The `<title>` and the description move with it, and that is a fix rather than a
  // flourish. Both are hard-coded Thai in `index.html`, so before this every locale's
  // browser tab, bookmark, share card and search snippet was Thai — with no way to mark
  // it, because nothing inside `<head>` can carry a `lang`. `document.title` is the only
  // handle a Vite SPA has on it; the Next.js move (6b) replaces this with `generateMetadata`
  // and can then serve it in the response rather than after hydration.
  useEffect(() => {
    document.documentElement.lang = state.locale;

    // ⚠️ Still not honest enough, and the gap is structural rather than an omission: in
    // six of the eight these two are the Thai fallback, and there is no `lang` anywhere in
    // `<head>` to say so. A crawler reading Thai prose under `lang="de"` is being told
    // something false. Nothing in a Vite SPA can fix that; a served `<html lang>` per
    // route can, which is 6b's to do.
    const { t } = translatorFor(state.locale);
    document.title = t('meta.title');

    const description = document.querySelector('meta[name="description"]');
    if (description !== null) description.setAttribute('content', t('meta.description'));
  }, [state.locale]);

  const setLocale = useCallback((next: Locale) => {
    setState({ locale: next, hydrated: true });

    // Persisted here rather than from an effect on `locale`: that effect would also
    // run on mount holding the default, and would overwrite the stored preference
    // before the read above ever saw it. A person clicking is the only thing that may
    // move this key.
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Quota or private mode. The choice still holds for the rest of the session.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(() => {
    const { t, td } = translatorFor(state.locale);

    return {
      locale: state.locale,
      setLocale,
      t,
      td,
      f: formattersFor(state.locale),
      message: (item) => renderMessage(item, state.locale),
      content: (ref, th) => resolveContent(ref, th, state.locale),
    };
  }, [state.locale, setLocale]);

  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}
