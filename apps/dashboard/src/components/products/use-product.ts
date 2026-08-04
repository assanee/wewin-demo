'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  AdminOptionGroupWire,
  AdminProductWire,
  CategoryWire,
  ProductWire,
} from '@wewin/contract';

import {
  failureMessage,
  getProduct,
  getPublishedDocumentOf,
  isForbidden,
  isStaleDraft,
  listCategories,
  listOptionGroups,
} from './catalog-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who owns the draft hash.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `catalog-api.ts` takes `expectedDocumentHash` as an argument on every mutation and keeps
 * no copy of it, and its header says why: a cached hash is a stale hash, and a client that
 * quietly reuses one has disabled the concurrency check while appearing to perform it. This
 * hook is the other half of that arrangement — the one place that holds the current hash,
 * for exactly as long as one screen is looking at one draft.
 *
 * ### Every mutation is followed by a re-read, and that is not laziness
 *
 * A draft mutation answers with a fresh `DraftWire`, which is enough to keep editing. It is
 * *not* enough to keep the screen honest: `unpublishedFields` — which product-level fields
 * have moved away from the published document — is computed by the server from the `products`
 * row against the frozen document, and no mutation response carries it. A screen that
 * applied the returned draft and stopped would show a correct option list beside a
 * "saved but not published" banner that had quietly stopped counting.
 *
 * So a mutation is: send, then `GET /admin/catalog/products/:id`, then render that. It costs
 * a round trip on an internal tool used by a handful of people, and it buys a screen with
 * one source of truth instead of two that agree until they do not. It also picks up a
 * colleague's concurrent edit at the first moment we could have known about it.
 *
 * ### One mutation at a time
 *
 * `busy` is a lock, not a spinner. Two mutations in flight would both have been handed the
 * same hash, and the second would come back 409 — correctly, but as a confusing failure of
 * something the person did not do twice. Reordering needs several writes, so the runner
 * hands the caller the hash and lets it chain: each step's response carries the hash the
 * next one needs.
 */

export interface ProductResource {
  readonly product: AdminProductWire;
  /** The frozen document customers are served, or `null` before the first publish. */
  readonly publishedDocument: ProductWire | null;
}

export interface Reference {
  readonly catalogue: readonly AdminOptionGroupWire[];
  readonly categories: readonly CategoryWire[];
}

export type ResourceState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly resource: ProductResource };

export interface ProductEditor {
  readonly state: ResourceState;
  /** The option catalogue and the category list. `null` until they have loaded. */
  readonly reference: Reference | null;
  readonly busy: boolean;
  readonly reload: () => void;
  /**
   * Run one or more draft writes against the current hash, then re-read.
   *
   * `label` is the Thai name of what was done, used in the confirmation. Returns whether it
   * succeeded, so a caller can close a dialog only when it did.
   */
  readonly withDraft: (
    label: string,
    run: (expectedDocumentHash: string) => Promise<unknown>,
  ) => Promise<boolean>;
  /** For the writes that are not draft mutations: opening a draft, publishing. */
  readonly withProduct: (label: string, run: () => Promise<unknown>) => Promise<boolean>;
}

async function loadResource(productId: string): Promise<ProductResource> {
  const product = await getProduct(productId);
  const document = await getPublishedDocumentOf(productId, product.slug);
  return { product, publishedDocument: document?.product ?? null };
}

export function useProductEditor(productId: string): ProductEditor {
  const [state, setState] = useState<ResourceState>({ status: 'loading' });
  const [reference, setReference] = useState<Reference | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Every load is stamped, and a response whose stamp is not the current one is dropped. A
   * `reload()` fired while an earlier one is still in flight would otherwise settle in
   * whichever order the network chose, and the older answer landing second is a screen that
   * silently reverts to a state nobody is in.
   */
  const generation = useRef(0);

  const reload = useCallback(() => {
    const stamp = ++generation.current;
    setState({ status: 'loading' });

    void loadResource(productId)
      .then((resource) => {
        if (generation.current === stamp) setState({ status: 'ready', resource });
      })
      .catch((error: unknown) => {
        if (generation.current === stamp) setState({ status: 'error', error });
      });
  }, [productId]);

  useEffect(reload, [reload]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [groups, categories] = await Promise.all([listOptionGroups(), listCategories()]);
        if (!cancelled) setReference({ catalogue: groups.groups, categories });
      } catch (error: unknown) {
        /*
         * Not fatal, and deliberately not promoted into `state`. The catalogue and the
         * category list are what the *pickers* need; a person who came to read a draft or
         * to publish one can do both without them, and blanking the screen would take away
         * the publish button because a dropdown failed to load.
         */
        if (!cancelled) toast.error(`โหลดรายการอ้างอิงไม่สำเร็จ — ${failureMessage(error)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(
    async (label: string, stamp: number): Promise<void> => {
      const resource = await loadResource(productId);
      if (generation.current === stamp) setState({ status: 'ready', resource });
      toast.success(label);
    },
    [productId],
  );

  const fail = useCallback(
    (error: unknown): void => {
      if (isStaleDraft(error)) {
        toast.error('มีผู้อื่นแก้ไขฉบับร่างนี้ไปแล้ว — โหลดข้อมูลล่าสุดให้แล้ว กรุณาทำรายการอีกครั้ง');
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

  const withProduct = useCallback(
    async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      const stamp = ++generation.current;

      try {
        await run();
        await finish(label, stamp);
        return true;
      } catch (error: unknown) {
        fail(error);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, fail, finish],
  );

  const withDraft = useCallback(
    async (label: string, run: (expectedDocumentHash: string) => Promise<unknown>): Promise<boolean> => {
      const draft = state.status === 'ready' ? state.resource.product.draft : null;
      if (draft === null) {
        /*
         * Not an assertion. Every button that reaches here is rendered only when a draft
         * exists, so this fires when the draft was discarded in another tab — a message
         * beats a stack trace, and the reload puts the screen back in a state that matches.
         */
        toast.error('ไม่มีฉบับร่างให้แก้ไข — อาจถูกทิ้งไปแล้ว');
        reload();
        return false;
      }

      return withProduct(label, () => run(draft.documentHash));
    },
    [reload, state, withProduct],
  );

  return { state, reference, busy, reload, withDraft, withProduct };
}
