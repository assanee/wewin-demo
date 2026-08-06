'use client';

import { createContext, useContext } from 'react';
import type { QuoteLine } from '@wewin/core/quote';

/**
 * Consumer side of the quote context.
 *
 * Split from QuoteContext.tsx so that file exports only a component: mixing a
 * component and a hook in one module breaks React Fast Refresh, which silently
 * turns every edit into a full reload and drops the state you were testing.
 *
 * `'use client'` here as well as on the provider, and it is a guard rather than a
 * formality. Next infers the boundary from whoever imports a module, so without the
 * directive this file would be pulled into a server component's graph on the first
 * import that forgot, and `createContext` would fail with a message about the
 * *importer* rather than about the cart. Marking it says the thing once, at the module
 * that is actually client-only: **the cart cannot be read on the server.** It lives in
 * localStorage, which the server has no access to, and a server component that appeared
 * to read it would be reading an empty cart it then cached for everyone else.
 */
export interface QuoteContextValue {
  lines: QuoteLine[];
  /** Pieces, not rows — what the header badge shows. */
  itemCount: number;
  /** Minor units — satang. Never baht: see @wewin/core/money. */
  total: bigint;
  /** False until localStorage has been read, so the UI never acts on an empty cart. */
  ready: boolean;
  addLine: (line: Omit<QuoteLine, 'lineId' | 'addedAt'>) => void;
  updateLine: (lineId: string, line: Omit<QuoteLine, 'lineId' | 'addedAt'>) => void;
  setQty: (lineId: string, qty: number) => void;
  removeLine: (lineId: string) => void;
  duplicateLine: (lineId: string) => void;
  getLine: (lineId: string) => QuoteLine | undefined;
}

export const QuoteCtx = createContext<QuoteContextValue | null>(null);

export function useQuote(): QuoteContextValue {
  const value = useContext(QuoteCtx);
  if (!value) throw new Error('useQuote must be used inside <QuoteProvider>');
  return value;
}
