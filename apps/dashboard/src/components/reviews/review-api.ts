import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';
import type { HiddenReason } from './hide-reason';

/**
 * Every call the review-moderation screen makes.
 *
 * ⚠️ Shapes restated from `packages/contract/src/review.ts`. Same boundary debt, plan 12.1.
 */

export interface ReviewPhoto {
  /**
   * Where the bytes are, as a path.
   *
   * ⚠️ Null when the bytes are gone. A photo whose `storageKey` was cleared by an erasure or
   * a retention sweep keeps its row so the *record that a photo existed* survives — plan
   * 9.4(2) — and the client renders the gap rather than a broken image.
   */
  readonly path: string | null;
  readonly width: number;
  readonly height: number;
  readonly altTextTh: string | null;
}

export interface QueueItem {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly productId: string;
  readonly productNameTh: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: string;
  /** When it goes public on its own if nobody touches it. */
  readonly publishesAt: string;
  /** How long a moderator has left. The urgency on this screen, and the only clock that matters. */
  readonly hoursRemaining: number;
  readonly photos: readonly ReviewPhoto[];
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
  return value;
};

const asTextOrNull = (value: unknown, what: string): string | null =>
  value === null || value === undefined ? null : asText(value, what);

const asNumber = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${what}: expected a number`);
  }
  return value;
};

export interface Queue {
  readonly items: readonly QueueItem[];
  readonly total: number;
}

/**
 * ⭐ `state` added when เลิกซ่อน got a screen. `'hidden'` lists the reviews a moderator has
 * taken down — the API's queue is otherwise "nobody has ruled on this yet", and a hidden
 * review left that list the moment it was hidden.
 */
export const listQueue = (state: 'pending' | 'hidden' = 'pending'): Promise<Queue> =>
  apiJson(`/admin/reviews/queue?limit=100&state=${state}`, (body) => {
    const queue = asRecord(body, 'คิวรีวิว');

    return {
      total: asNumber(queue['total'], 'queue.total'),
      items: asArray(queue['items'] ?? [], 'items').map((raw) => {
        const item = asRecord(raw, 'review');
        return {
          id: asText(item['id'], 'review.id'),
          orderId: asText(item['orderId'], 'review.orderId'),
          orderNo: asTextOrNull(item['orderNo'], 'review.orderNo'),
          productId: asText(item['productId'], 'review.productId'),
          productNameTh: asText(item['productNameTh'], 'review.productNameTh'),
          rating: asNumber(item['rating'], 'review.rating'),
          bodyTh: asTextOrNull(item['bodyTh'], 'review.bodyTh'),
          authorDisplayName: asTextOrNull(item['authorDisplayName'], 'review.authorDisplayName'),
          createdAt: asText(item['createdAt'], 'review.createdAt'),
          publishesAt: asText(item['publishesAt'], 'review.publishesAt'),
          hoursRemaining: asNumber(item['hoursRemaining'], 'review.hoursRemaining'),
          photos: asArray(item['photos'] ?? [], 'photos').map((rawPhoto) => {
            const photo = asRecord(rawPhoto, 'photo');
            return {
              path: asTextOrNull(photo['path'], 'photo.path'),
              width: asNumber(photo['width'], 'photo.width'),
              height: asNumber(photo['height'], 'photo.height'),
              altTextTh: asTextOrNull(photo['altTextTh'], 'photo.altTextTh'),
            };
          }),
        };
      }),
    };
  });

const post = async (path: string, body: unknown): Promise<void> => {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};

/** The moderator's name comes from the session and is never in this body — plan 9.3. */
export const hideReview = (
  reviewId: string,
  body: { readonly reason: HiddenReason; readonly noteTh: string | null },
): Promise<void> => post(`/admin/reviews/${reviewId}/hide`, body);

export const unhideReview = (reviewId: string): Promise<void> =>
  post(`/admin/reviews/${reviewId}/unhide`, {});

/**
 * Publish it now instead of waiting out the window.
 *
 * A review is public once `hidden_at IS NULL` and either it was published early or its
 * window elapsed — so this is "I have read it and it is fine", not "make it visible", and
 * the difference is that the clock stops mattering afterwards.
 */
export const publishReview = (reviewId: string): Promise<void> =>
  post(`/admin/reviews/${reviewId}/publish`, {});

/** One reply per review — a create, never an update. */
export const replyToReview = (reviewId: string, bodyTh: string): Promise<void> =>
  post(`/admin/reviews/${reviewId}/reply`, { bodyTh: bodyTh.trim() });
