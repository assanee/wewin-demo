import { reviewsApiBaseUrl } from './api';

/**
 * The two calls the review **form** makes, from the browser, with the invitation token.
 *
 * ── The token is opaque here, and that is the design ─────────────────────────────
 *
 * Plan 9.2 says the invitation goes out once, N days after delivery. Nothing in this phase
 * mints one: packages/db deliberately built no invitation table and no scheduler, because
 * the outbox's only producer is `order_events` and a second producer is a schema change
 * with a CHECK behind it. So the shape of what the emailed link carries is apps/api's to
 * decide, and this storefront's job is to **not have an opinion about it**: `t` comes out
 * of the URL as a string, goes back up as a string, and is never parsed, validated,
 * decoded or stored here. If it turns out to be a JWT, a nonce or a signed line id, not one
 * line of this app changes.
 *
 * What that buys is the thing worth protecting: there is no authorisation logic on the
 * storefront. The server decides whether this token may write a review for that line, and
 * a client that cannot tell a good token from a bad one cannot be tricked into believing
 * one.
 *
 * 🔗 **The seam.** Two endpoints, stated so a mismatch is a conversation rather than a
 * silent blank page:
 *
 *     GET  {API}/reviews/invitations/{token}  → 200 { productSlug, size, submitted }
 *                                             → 404 when the token is unknown or spent
 *     POST {API}/reviews                       { token, rating, bodyTh, authorDisplayName }
 *                                             → 201
 *
 * Anything else is a refusal, and the form says so in the customer's language rather than
 * showing them a status code.
 */

/** What the form needs in order to say what it is a review *of*. */
export interface InvitationWire {
  /** The catalogue slug, so the form can name the product from the compiled-in fixtures. */
  readonly productSlug: string;
  /** The exact window, for the same reason the review card prints it — plan 9.1. */
  readonly size: { readonly widthUm: bigint; readonly heightUm: bigint } | null;
  /** One review per line (`reviews_line_key`). A spent invitation says so up front. */
  readonly submitted: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asBigInt = (value: unknown): bigint | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
};

/** `null` rather than a throw: every failure on this screen has the same one answer. */
export function decodeInvitation(body: unknown): InvitationWire | null {
  if (!isRecord(body)) return null;

  const productSlug = body['productSlug'];
  if (typeof productSlug !== 'string' || productSlug === '') return null;

  const rawSize = body['size'];
  let size: InvitationWire['size'] = null;
  if (isRecord(rawSize)) {
    const widthUm = asBigInt(rawSize['widthUm']);
    const heightUm = asBigInt(rawSize['heightUm']);
    if (widthUm !== null && heightUm !== null) size = { widthUm, heightUm };
  }

  return { productSlug, size, submitted: body['submitted'] === true };
}

/** The invitation behind a token, or `null` for every reason a customer cannot act on. */
export async function fetchInvitation(token: string): Promise<InvitationWire | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) return null;

  try {
    const response = await fetch(
      `${base}/reviews/invitations/${encodeURIComponent(token)}`,
      /*
       * `no-store`, and it is not a formality. This response is about one person's order
       * and it is keyed by a secret in a URL — a browser cache entry or, worse, a shared
       * one, is somebody else's window and somebody else's size.
       */
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    );
    if (!response.ok) return null;
    return decodeInvitation(await response.json());
  } catch {
    return null;
  }
}

export interface ReviewSubmission {
  readonly rating: number;
  /** Empty means "a rating and no words", which the schema allows and this app must too. */
  readonly bodyTh: string;
  readonly authorDisplayName: string;
}

/**
 * Send it. `true` only for a response the server accepted.
 *
 * Blank optional fields are **omitted rather than sent as empty strings**: apps/api parses
 * request bodies with `strictObject`, and `''` is not the same value as absent — one is a
 * customer who chose to publish an empty name, the other is a customer who did not answer.
 * The same distinction `quote-api.ts` makes for `noteTh`.
 */
export async function submitReview(token: string, review: ReviewSubmission): Promise<boolean> {
  const base = reviewsApiBaseUrl();
  if (base === null) return false;

  const bodyTh = review.bodyTh.trim();
  const authorDisplayName = review.authorDisplayName.trim();

  try {
    const response = await fetch(`${base}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        token,
        rating: review.rating,
        ...(bodyTh === '' ? {} : { bodyTh }),
        ...(authorDisplayName === '' ? {} : { authorDisplayName }),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
