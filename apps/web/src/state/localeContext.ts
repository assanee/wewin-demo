import { createContext, useContext } from 'react';
import type { Message } from '@wewin/core/message';
import type { Formatters } from '../i18n/format';
import type { ContentRef, ResolvedContent } from '../i18n/content';
import type { Locale } from '../i18n/locales';
import type { RenderedMessage } from '../i18n/messages';
import type { Translate, TranslateDetailed } from '../i18n/translate';

/**
 * The context and its hook, apart from the provider component.
 *
 * The same split as `displayUnitContext.ts`/`useDisplayUnit.tsx`, `QuoteContext.tsx`/
 * `useQuote.ts` and `Toast.tsx`/`useToast.ts`, and for the same reason: React Fast
 * Refresh only remounts cleanly when a module exports components *or* plain values,
 * never both.
 */

export interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;

  /** The app's own prose. Params are values; the catalogue entry renders them. */
  t: Translate;
  /** The same lookup, plus whether it fell back to Thai — for `lang` marking. */
  td: TranslateDetailed;
  /** Every number on the screen, in this locale. */
  f: Formatters;
  /** A core `Message` — an issue, an option tooltip, a breakdown row. */
  message: (value: Message) => RenderedMessage;
  /** Catalogue content: product names, category labels, group and option labels. */
  content: (ref: ContentRef, th: string) => ResolvedContent;
}

export const LocaleCtx = createContext<LocaleContextValue | null>(null);

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleCtx);
  if (!value) throw new Error('useLocale must be used inside <LocaleProvider>');
  return value;
}
