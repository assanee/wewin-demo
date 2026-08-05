import type { ReactElement } from 'react';
import type { ContentRef } from '../../i18n/content';
import { useLocale } from '../../state/localeContext';

interface CatalogTextProps {
  /** Which catalogue string this is — see `ContentRef`. Not named `ref`: React owns that. */
  at: ContentRef;
  /** The Thai source, which is also the fallback. Required, and never empty. */
  th: string;
  className?: string;
}

/**
 * A piece of catalogue content — a product name, a category label, a group label.
 *
 * It exists for one line of output: `lang="th"` on the fallback.
 *
 * With six of the eight catalogues empty, every product name on a German page is Thai
 * today. Rendering that inside a document declared `lang="de"` tells a screen reader
 * to read Thai script with a German voice, which produces noise rather than a name.
 * Marking the element is the cheapest honest thing available — it costs one attribute,
 * it fixes pronunciation, it lets `:lang(th)` pick a font that can draw the script,
 * and it makes "this bit is not translated yet" a fact in the page rather than a note
 * in a README.
 *
 * When a translated catalogue arrives (phase 6b brings it down with the product), the
 * attribute disappears on its own for the strings that have one. Nothing at the call
 * sites changes.
 */
export function CatalogText({ at, th, className }: CatalogTextProps): ReactElement {
  const { content } = useLocale();
  const resolved = content(at, th);

  return (
    <span className={className} {...(resolved.fallback ? { lang: 'th' } : {})}>
      {resolved.text}
    </span>
  );
}
