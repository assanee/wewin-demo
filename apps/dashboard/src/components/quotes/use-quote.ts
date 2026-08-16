'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { QuotePreconditionWire, QuoteWire } from '@wewin/contract/quote';

import {
  conflictOf,
  failureMessage,
  getQuote,
  isForbidden,
  preconditionOf,
  reissueQuote,
  type ConflictKind,
} from './quote-api';
import { foldQuote, type QuoteView } from './quote-model';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who holds the revision token.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The sibling of `products/use-product.ts`, and the same arrangement for the same reason:
 * `quote-api.ts` takes `expect` as an argument on every write and keeps no copy, because a
 * cached handle is a stale handle and a client that quietly reuses one has disabled the
 * concurrency check while appearing to perform it. This hook is the one place that holds the
 * current `quoteRevision`, for exactly as long as one screen is looking at one quote.
 *
 * ### One difference from the product editor, and it is the whole feature
 *
 * A draft mutation there is followed by a re-read, because the response is not enough to keep
 * the screen honest. Here every write **answers with the whole quote** — lines, money,
 * overrides, the concession, the ceiling and the stale list — so the response is applied
 * directly and there is no second round trip. That is not an optimisation. A re-read would
 * open a window in which the screen shows a total from one revision beside an override from
 * another, on the one screen whose entire job is that a person can trust which figure came
 * from where.
 *
 * ### A conflict is not a failure to retry
 *
 * `conflictOf` splits a 409 four ways and only one of them is "reload and carry on". A
 * catalogue publish under a promise needs a person to look at each affected line. The hook
 * records which one happened so the banner can say so, rather than turning all four into a
 * toast that says "conflict".
 *
 * A 500 is *not* one of them, deliberately: the integrity case — `core` changed under a
 * pinned document — arrives as a 500 with a request id, because there is nothing a caller can
 * do. It shows as an ordinary failure here, and the same condition is detected independently
 * out of the fold, where it becomes an alarm the screen will not quote past.
 */

export type QuoteState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly view: QuoteView };

export interface QuoteEditor {
  readonly state: QuoteState;
  readonly busy: boolean;
  /** The last conflict this screen hit, until it is cleared or superseded by a clean write. */
  readonly conflict: ConflictKind | null;
  readonly dismissConflict: () => void;
  readonly reload: () => void;
  /**
   * Run one write against the current revision and apply what it answers.
   *
   * `label` is the Thai name of what was done, used in the confirmation. Returns whether it
   * succeeded, so a caller can close a dialog only when it did.
   */
  readonly write: (
    label: string,
    run: (expect: QuotePreconditionWire) => Promise<QuoteWire>,
  ) => Promise<boolean>;
  /**
   * ⭐ Send the edited quotation to the customer.
   *
   * Not a `write`, and the difference is the whole reason it has a method of its own: every
   * other action here answers with a quote and this one answers with an **order**. There is
   * nothing to apply, so it reloads — which is also what fetches the `issued` block this call
   * exists to move.
   */
  readonly reissue: () => Promise<boolean>;
}

export function useQuoteEditor(orderId: string): QuoteEditor {
  const [state, setState] = useState<QuoteState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictKind | null>(null);

  /*
   * Every load is stamped and a response whose stamp is not the current one is dropped. Two
   * reloads settling in whichever order the network chose is a screen that silently reverts
   * to a revision nobody is in — and on this screen a stale revision is a stale price.
   */
  const generation = useRef(0);

  const apply = useCallback((wire: QuoteWire, stamp: number): void => {
    if (generation.current === stamp) setState({ status: 'ready', view: foldQuote(wire) });
  }, []);

  const reload = useCallback(() => {
    const stamp = ++generation.current;
    setState({ status: 'loading' });

    void getQuote(orderId)
      .then((wire) => apply(wire, stamp))
      .catch((error: unknown) => {
        if (generation.current === stamp) setState({ status: 'error', error });
      });
  }, [apply, orderId]);

  useEffect(reload, [reload]);

  const fail = useCallback(
    (error: unknown): void => {
      const kind = conflictOf(error);
      if (kind !== null) {
        setConflict(kind);
        /*
         * Reloaded for every conflict. Unlike the products screen there is no arm here that
         * must *not* reload: the API's own integrity case never arrives as a 409, so a fresh
         * quote is always the more accurate thing to be looking at — and for a stale baseline
         * it is the thing that carries the per-line list a person has to work through.
         */
        reload();
        return;
      }
      if (isForbidden(error)) {
        toast.error('สิทธิ์ของคุณไม่ครอบคลุมการกระทำนี้');
        return;
      }
      toast.error(failureMessage(error));
    },
    [reload],
  );

  const write = useCallback(
    async (
      label: string,
      run: (expect: QuotePreconditionWire) => Promise<QuoteWire>,
    ): Promise<boolean> => {
      /*
       * `busy` is a lock, not a spinner. Two writes in flight would both have been handed the
       * same revision token, and the second would come back `quote_stale` — correctly, but as
       * a confusing refusal of something the person did not do twice.
       */
      if (busy) return false;
      if (state.status !== 'ready') {
        toast.error('ยังโหลดใบเสนอราคาไม่เสร็จ');
        return false;
      }

      setBusy(true);
      const stamp = ++generation.current;

      try {
        const wire = await run(preconditionOf(state.view.wire));
        apply(wire, stamp);
        setConflict(null);
        toast.success(label);
        return true;
      } catch (error: unknown) {
        fail(error);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply, busy, fail, state],
  );

  const reissue = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    if (state.status !== 'ready') {
      toast.error('ยังโหลดใบเสนอราคาไม่เสร็จ');
      return false;
    }

    setBusy(true);
    try {
      await reissueQuote(orderId, preconditionOf(state.view.wire));
      setConflict(null);
      toast.success('ออกใบเสนอราคาใหม่แล้ว — ลูกค้าเห็นยอดใหม่');
      /*
       * Reloaded rather than patched. The re-issue moves the order's totals, its pinned
       * document and its instalments; the only thing this screen can say about that afterwards
       * is what the server says, and the `issued` block it comes back with is the assertion
       * that the send actually landed.
       */
      reload();
      return true;
    } catch (error: unknown) {
      fail(error);
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, fail, orderId, reload, state]);

  const dismissConflict = useCallback(() => setConflict(null), []);

  return { state, busy, conflict, dismissConflict, reload, write, reissue };
}
