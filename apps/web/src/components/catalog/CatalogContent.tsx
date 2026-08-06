import type { ReactElement } from 'react';

import { resolveContent, type ContentRef } from '../../i18n/content';
import { SOURCE_LOCALE, type Locale } from '../../i18n/locales';

interface CatalogContentProps {
  /** The locale this page is being rendered *for*, from the `[locale]` path segment. */
  locale: Locale;
  /** Which catalogue string this is — see `ContentRef`. Not named `ref`: React owns that. */
  at: ContentRef;
  /** The Thai source, which is also the fallback. Required, and never empty. */
  th: string;
  className?: string;
}

/**
 * A piece of catalogue content — a product name, a category label — rendered on the
 * **server**.
 *
 * It exists for one line of output, and it is the same line `components/common/CatalogText`
 * exists for: `lang="th"` on the fallback. With six of the eight catalogues empty, every
 * product name on a German page is Thai today, and rendering that inside a document
 * declared `lang="de"` tells a screen reader to read Thai script with a German voice —
 * noise rather than a name. The attribute costs nothing, fixes pronunciation, lets
 * `:lang(th)` pick a font that can draw the script, and makes "this bit is not translated
 * yet" a fact in the page rather than a note in a README.
 *
 * ## Why there are two of these, and what has to happen to that
 *
 * `CatalogText` reads the resolution out of React context via `useLocale()`, which is a
 * client-side mechanism: a server component has no provider above it. The catalogue pages
 * are the whole reason for this move — 8 locales × 81 products, prerendered and
 * crawlable — so they cannot be client components, and therefore cannot call that hook.
 *
 * So the locale arrives as a prop instead of out of a context, and everything else is the
 * same component. **This is a duplicate and it should not survive the port**: the merge is
 * to give the one component an optional `locale` prop and read the context only when it is
 * absent. That edit belongs to whoever owns `components/common/` after the three parallel
 * ports land, because doing it now means two agents editing one file in the same minute.
 */
export function CatalogContent({
  locale,
  at,
  th,
  className,
}: CatalogContentProps): ReactElement {
  const resolved = resolveContent(at, th, locale);

  return (
    <span className={className} {...(resolved.fallback ? { lang: SOURCE_LOCALE } : {})}>
      {resolved.text}
    </span>
  );
}
