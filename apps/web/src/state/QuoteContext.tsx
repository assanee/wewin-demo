'use client';

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
 * The quote lives here and is mirrored into localStorage under `aluform.quote.v4`.
 *
 * Ids and timestamps are minted in this layer, never inside the reducer — that is
 * what keeps the reducer deterministic and testable without stubbing crypto or Date.
 *
 * ── What the move to the App Router changed, and what it must not ────────────────
 *
 * `'use client'`, and nothing else about the mechanism. That directive is the whole
 * port: `useReducer` and two effects are client concerns, and the boundary has to be
 * declared or the build fails. Everything below the directive is byte-for-byte the
 * Vite provider apart from the read guard noted at its own effect.
 *
 * **`hydrated` is now load-bearing twice, and the second reason is new.** Phase 0 put
 * the flag in reducer state so the persistence effect could not overwrite a saved cart
 * with the empty initial one (the paragraph in `@wewin/core/quote` is the long version,
 * and it is the reason not to "simplify" this into a ref). Under the App Router it also
 * decides what the *prerendered HTML* says. A client component is still rendered on the
 * server for its initial markup, so whatever this provider holds at first render is what
 * gets cached and served to everybody: with `hydrated: false` and `lines: []`, that
 * markup contains no cart, no price and no preference — which is exactly what a cached
 * page is allowed to contain (plan 8.2(3), and the locale layout's "may not render its
 * price" until `revalidateTag` + `priceVersion` exist). The screen renders the *empty*
 * state, never the *emptied* one; see `QuoteScreen`, which reads `ready` before it is
 * allowed to say "your cart is empty".
 *
 * It is also what keeps hydration quiet. Server and client both start from
 * `emptyQuote()`, so the first client render matches the server's markup exactly, and
 * the cart arrives one commit later from the effect. Reading storage during render — the
 * change that looks like it would save a frame — would produce a different tree on the
 * client than the one the server sent, i.e. a hydration mismatch on a page full of
 * money, in a codebase where `my-MM` already renders digits differently in Node and in
 * Chromium (plan 8.7(4)).
 *
 * `crypto.randomUUID` exists in Node 19+ and in every browser this app targets, so the
 * fallback below is for insecure origins rather than for the server. Ids are only minted
 * inside event handlers, never during render, so no id ever crosses the boundary.
 */
export function QuoteProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(quoteReducer, undefined, emptyQuote);

  // Read once on mount rather than in the reducer initialiser: touching
  // localStorage during render would close off the SSR path spec section 12 asks
  // us to keep open, and would run twice under StrictMode.
  useEffect(() => {
    let raw: string | null = null;

    try {
      raw = localStorage.getItem(QUOTE_STORAGE_KEY);
    } catch {
      // Added in the port, and it is not tidying. `getItem` throws outright when a
      // browser is configured to block storage — Safari's Lock Down mode and a
      // third-party iframe both do it — and the write side has been guarded since
      // phase 0 while the read side was not. In the Vite SPA an uncaught throw here
      // cost the one page that was open. Under the App Router this provider mounts
      // above every route, so the same throw reaches the segment's error boundary and
      // replaces the whole app with the error page — on a visit that has a perfectly
      // usable, merely unsaveable, cart. `parseStoredQuote(null)` is `[]`, which is
      // the honest answer: nothing was stored, because nothing could be.
      raw = null;
    }

    dispatch({ type: 'hydrate', lines: parseStoredQuote(raw) });
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
