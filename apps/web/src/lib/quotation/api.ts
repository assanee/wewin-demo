import { pinnedDocumentFrom, type PinnedDocument } from '@wewin/core/quotation';

import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The quotation, fetched with the token out of the emailed link.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The token is opaque here, and that is the design ─────────────────────────
 *
 * Exactly the arrangement `reviews/invitation.ts` argues for, and for the same reason: `t`
 * comes out of the URL as a string, goes back up as a string, and is never parsed, decoded,
 * validated or stored. It happens to be a signed JWT today; if it becomes a nonce tomorrow,
 * not one line here changes.
 *
 * What that buys is worth stating plainly: **there is no authorisation logic on the
 * storefront.** The server decides whether this token may read that order, and a client that
 * cannot tell a good token from a bad one cannot be talked into believing one.
 *
 * ── ⚠️ Client-side only, and never cached ────────────────────────────────────
 *
 * The URL *is* the credential. A server render would put one customer's quotation into a
 * response whose whole design is that it is cached and shared, and `cache: 'no-store'` here
 * is the same instinct as the API's `Cache-Control: private, no-cache` on the way out.
 *
 * ── ⚠️ The shape is decoded by `@wewin/core`, not here ───────────────────────
 *
 * The first version of this file had its own decoder, written from an *assumption* about the
 * payload: money as digits, lines carrying an `options` array. Both were wrong — money is
 * `{unit: 'THB.satang', digits}` and the option labels live under `price.lines[].label.params`
 * — and because the unit tests were written against that same invented fixture, they passed
 * while the page failed on the first real response.
 *
 * `pinnedDocumentFrom` is the decoder the dashboard already used against real payloads. Two
 * decoders would be two documents before either app rendered a character, which is the same
 * argument plan 10.6 makes about two renderers.
 *
 * 🔗 **The seam**, stated so a mismatch is a conversation rather than a blank page:
 *
 *     GET {API}/orders/documents/{token}
 *       → 200 { orderNo, status, contactName, submittedAt, document }
 *       → 404 for every refusal, deliberately
 */

export interface LinkedQuotation {
  readonly orderNo: string | null;
  readonly status: string;
  readonly document: PinnedDocument;
}

export type QuotationFailure =
  /** No API base URL. In production a deployment mistake; the page says so plainly. */
  | 'unconfigured'
  /** No `?t=` in the URL at all — somebody opened the bare path. */
  | 'no-token'
  /** The network, or an API that is not running. Retrying may work. */
  | 'unreachable'
  /**
   * ⚠️ **The API's one answer to four different problems.**
   *
   * Expired, mistyped, revoked by a key rotation, or an order that never existed — the server
   * refuses to say which, on purpose, because distinguishing them would let somebody holding
   * one valid link learn about ids they do not hold. The page therefore cannot say "your link
   * has expired" however much it would like to, and offers the one action that always works:
   * ask the sales team for a fresh one.
   */
  | 'refused'
  /** 2xx whose body this bundle cannot read — including unreadable money. */
  | 'malformed';

export type QuotationResult =
  | { readonly ok: true; readonly data: LinkedQuotation }
  | { readonly ok: false; readonly reason: QuotationFailure };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * ⚠️ A throw from `pinnedDocumentFrom` becomes `malformed`, and that is the strict half.
 *
 * It throws on money it cannot read, and the alternative — defaulting a missing total to zero
 * — would render a quotation for ฿0.00 that is indistinguishable from a real one, in front of
 * somebody who transfers the printed figure. A refusal is the only safe answer.
 */
export function decodeQuotation(body: unknown): LinkedQuotation | null {
  if (!isRecord(body) || !isRecord(body['document'])) return null;

  try {
    return {
      orderNo: asString(body['orderNo']),
      status: asString(body['status']) ?? 'unknown',
      document: pinnedDocumentFrom(body['document'], {
        orderNo: asString(body['orderNo']),
        contactName: asString(body['contactName']),
        submittedAt: asString(body['submittedAt']),
      }),
    };
  } catch {
    return null;
  }
}

export async function fetchQuotation(token: string): Promise<QuotationResult> {
  if (token === '') return { ok: false, reason: 'no-token' };

  const base = reviewsApiBaseUrl();
  if (base === null) return { ok: false, reason: 'unconfigured' };

  let response: Response;
  try {
    response = await fetch(`${base}/orders/documents/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      /* The URL is the credential; nothing about this response may be reused for anyone. */
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (!response.ok) return { ok: false, reason: 'refused' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const data = decodeQuotation(body);
  return data === null ? { ok: false, reason: 'malformed' } : { ok: true, data };
}
