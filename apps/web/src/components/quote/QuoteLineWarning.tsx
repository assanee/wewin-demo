'use client';

import { AlertTriangle } from 'lucide-react';
import type { QuoteLine } from '@wewin/core/quote';
import { useLocale } from '../../state/localeContext';

/**
 * The first warning carried by a saved quote line.
 *
 * One component rather than the two near-identical blocks the row and the card each
 * had: it is now a `Message` that has to be rendered rather than a string that could
 * be printed, and two copies of a render call are two chances for the desktop table
 * and the mobile card to disagree about what a line says.
 *
 * ## Why a stored warning renders in *today's* language
 *
 * Plan 10.6 splits the two cases. A notification uses the recipient's preference at
 * the moment it is sent; a document uses the locale pinned when it was submitted,
 * because a quotation reprinted next year in another language is not the same
 * document. The quote list is neither — it is a cart, and the customer is reading it
 * now. So the line stores a locale-free `Message` (which is exactly why core made it
 * one, and why `QUOTE_SCHEMA_VERSION` went to 4 to keep the `bigint`s inside it
 * intact through `JSON.stringify`) and this renders it in whatever the customer
 * prefers today. Switching language re-reads the warning; it does not rewrite it.
 *
 * The pin belongs with the other seven frozen values in plan 7.13, on the API side, at
 * the point a quote is actually submitted. Nothing here fakes it.
 */
export function QuoteLineWarning({ line, className }: { line: QuoteLine; className?: string }) {
  const { message } = useLocale();

  const first = line.warnings[0];
  if (!first) return null;

  const rendered = message(first.message);

  return (
    <p className={`flex items-start gap-1.5 text-warn ${className ?? ''}`}>
      <AlertTriangle size={13} aria-hidden className="mt-[3px] shrink-0" />
      <span className="min-w-0" {...(rendered.fallback ? { lang: 'th' } : {})}>
        {rendered.text}
      </span>
    </p>
  );
}