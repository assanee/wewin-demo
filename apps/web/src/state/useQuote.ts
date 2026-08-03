import { createContext, useContext } from 'react';
import type { QuoteLine } from '@wewin/core/quote';

/**
 * Consumer side of the quote context.
 *
 * Split from QuoteContext.tsx so that file exports only a component: mixing a
 * component and a hook in one module breaks React Fast Refresh, which silently
 * turns every edit into a full reload and drops the state you were testing.
 */
export interface QuoteContextValue {
  lines: QuoteLine[];
  /** Pieces, not rows — what the header badge shows. */
  itemCount: number;
  total: number;
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
