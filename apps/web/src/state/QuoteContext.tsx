import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import {
  emptyQuote,
  parseStoredQuote,
  quoteItemCount,
  quoteReducer,
  quoteTotal,
  serialiseQuote,
  QUOTE_STORAGE_KEY,
  type QuoteLine,
} from '@wewin/core/quote';
import { QuoteCtx, type QuoteContextValue } from './useQuote';

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `line-${Math.random().toString(36).slice(2)}`;

/**
 * The quote lives here and is mirrored into localStorage under `aluform.quote.v1`.
 *
 * Ids and timestamps are minted in this layer, never inside the reducer — that is
 * what keeps the reducer deterministic and testable without stubbing crypto or Date.
 */
export function QuoteProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(quoteReducer, undefined, emptyQuote);

  // Read once on mount rather than in the reducer initialiser: touching
  // localStorage during render would close off the SSR path spec section 12 asks
  // us to keep open, and would run twice under StrictMode.
  useEffect(() => {
    dispatch({ type: 'hydrate', lines: parseStoredQuote(localStorage.getItem(QUOTE_STORAGE_KEY)) });
  }, []);

  useEffect(() => {
    // Guarded by the flag inside `state`, not by a ref. Both mount effects run in
    // the same commit, so a ref set by the effect above would already be true here
    // while `state` is still the empty initial value — and this would write that
    // empty quote straight over the customer's saved one.
    if (!state.hydrated) return;

    try {
      localStorage.setItem(QUOTE_STORAGE_KEY, serialiseQuote(state));
    } catch {
      // Private mode or a full quota. Losing persistence is survivable — the quote
      // still works for this session — so this must not take the page down.
    }
  }, [state]);

  const addLine = useCallback((line: Omit<QuoteLine, 'lineId' | 'addedAt'>) => {
    dispatch({ type: 'add', line: { ...line, lineId: newId(), addedAt: new Date().toISOString() } });
  }, []);

  const updateLine = useCallback((lineId: string, line: Omit<QuoteLine, 'lineId' | 'addedAt'>) => {
    dispatch({ type: 'update', lineId, line: { ...line, lineId, addedAt: new Date().toISOString() } });
  }, []);

  const value = useMemo<QuoteContextValue>(
    () => ({
      lines: state.lines,
      itemCount: quoteItemCount(state.lines),
      total: quoteTotal(state.lines),
      ready: state.hydrated,
      addLine,
      updateLine,
      setQty: (lineId, qty) => dispatch({ type: 'setQty', lineId, qty }),
      removeLine: (lineId) => dispatch({ type: 'remove', lineId }),
      duplicateLine: (lineId) =>
        dispatch({ type: 'duplicate', lineId, newLineId: newId(), addedAt: new Date().toISOString() }),
      getLine: (lineId) => state.lines.find((line) => line.lineId === lineId),
    }),
    [state.lines, state.hydrated, addLine, updateLine],
  );

  return <QuoteCtx.Provider value={value}>{children}</QuoteCtx.Provider>;
}
