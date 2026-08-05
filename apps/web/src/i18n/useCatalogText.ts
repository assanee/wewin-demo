import type { ContentRef } from './content';
import { useLocale } from '../state/localeContext';

/**
 * Catalogue content as a plain string, for the places that cannot hold an element —
 * `aria-label`, `title`, a value passed into a message param.
 *
 * The `lang="th"` marker `CatalogText` applies is unavailable here by construction: an
 * attribute value has no element to hang it on. That is a real loss, so the component
 * is preferred wherever the text is visible and this is used only where it cannot be.
 *
 * Its own module rather than a second export from `CatalogText.tsx`: React Fast
 * Refresh only remounts cleanly when a file exports components *or* plain values — the
 * same split `displayUnitContext.ts` and `useToast.ts` already make, and oxlint
 * enforces it.
 */
export function useCatalogText(): (at: ContentRef, th: string) => string {
  const { content } = useLocale();
  return (at, th) => content(at, th).text;
}
