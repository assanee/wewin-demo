import type { Message } from '@wewin/core/message';

import { resolveContent, type ContentRef, type ResolvedContent } from './content';
import { formattersFor, type Formatters } from './format';
import type { Locale } from './locales';
import { renderMessage, type RenderedMessage } from './messages';
import { translatorFor, type Translate, type TranslateDetailed } from './translate';

/**
 * The locale layer as a **value**, for components that run on the server.
 *
 * ## Why this exists at all
 *
 * The Vite app reaches the same six things through `useLocale()`, a React context read.
 * A context read is a client-side mechanism: a server component has no provider above it
 * and no hooks at all, so `useLocale()` cannot be what a prerendered catalogue page calls.
 * The alternative that suggests itself — mark every page `'use client'` so the context
 * works — spends the entire return on this move, because a client page is not a
 * prerendered one.
 *
 * So the *shape* survives and the *mechanism* changes, which is the same trade
 * `i18n/format.ts` records making with `Formatters`: `{ locale, t, td, f, message, content }`
 * is field-for-field `LocaleContextValue` minus `setLocale`, so a ported component's body
 * is unchanged apart from where the object came from. That matters more than it looks —
 * the port is meant to be reviewable as a diff, and a diff in which every call site also
 * changed shape hides the ones that changed meaning.
 *
 * `setLocale` is the one field deliberately absent. On the server the locale is not
 * state — it is the URL (`/[locale]/…`, see `lib/routing.ts`), and a setter here would be
 * a function that cannot do anything, offered to code that would reasonably call it.
 * Changing language is a navigation.
 *
 * ## Memoised, and why that is safe
 *
 * Eight entries, immutable, derived from pure functions over compiled-in catalogues.
 * There is no request state in here and nothing a request can write, so the map cannot
 * leak one visitor's anything to another — which is the failure plan 8.2(3) is about, and
 * the reason to say so explicitly rather than to leave a module-level cache unremarked in
 * a server render path.
 *
 * `formattersFor` already memoises for the same reason (`Intl` construction is not cheap);
 * this adds the two closures `translatorFor` allocates.
 */

export interface LocaleBundle {
  readonly locale: Locale;

  /** The app's own prose. Params are values; the catalogue entry renders them. */
  readonly t: Translate;
  /** The same lookup, plus whether it fell back to Thai — for `lang` marking. */
  readonly td: TranslateDetailed;
  /** Every number on the screen, in this locale. */
  readonly f: Formatters;
  /** A core `Message` — an issue, an option tooltip, a breakdown row. */
  readonly message: (value: Message) => RenderedMessage;
  /** Catalogue content: product names, category labels, group and option labels. */
  readonly content: (ref: ContentRef, th: string) => ResolvedContent;
}

const bundles = new Map<Locale, LocaleBundle>();

/** Everything a server component needs to write one locale's page. */
export function localeBundle(locale: Locale): LocaleBundle {
  const cached = bundles.get(locale);
  if (cached) return cached;

  const { t, td } = translatorFor(locale);

  const created: LocaleBundle = {
    locale,
    t,
    td,
    f: formattersFor(locale),
    message: (value) => renderMessage(value, locale),
    content: (ref, th) => resolveContent(ref, th, locale),
  };

  bundles.set(locale, created);
  return created;
}
