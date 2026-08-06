import { tagsForProduct } from './tags';
import { decodeProductReviews, type ProductReviewsWire } from './wire';

/**
 * The read half of plan 9.5, and the first cached fetch this storefront has.
 *
 * ── `cache: 'force-cache'` plus tags, and never a time ───────────────────────────
 *
 * Three properties have to hold at once and only one arrangement gives all three:
 *
 *   ⓵ **The product page stays prerendered.** Since Next 15 an untagged, uncached `fetch`
 *      inside a server component opts its route out of the prerender — silently, the same
 *      way `searchParams` does (plan 8.2 trap 2, and `tests/cache-policy.test.ts` is the
 *      guard). 648 static documents are the entire return on phase 6b, and a review block
 *      is not a reason to spend them. `force-cache` keeps them.
 *
 *   ⓶ **No time-based revalidation.** The locale layout spends sixteen lines on why, and
 *      the argument is about prices rather than reviews — but an interval here would still
 *      mean re-fetching 81 products' reviews for ever on a site whose honest answer is
 *      "there are none yet, and there will be none for months". The cost of the correct
 *      answer is zero requests; the cost of an interval is 81 requests per interval, for
 *      nothing.
 *
 *   ⓷ **A published review reaches the page deliberately.** That is `next.tags` plus
 *      `app/api/revalidate/route.ts`. Both halves land in this commit, which is what the
 *      layout's note said the condition was: an invalidation endpoint that nothing calls
 *      reads as coverage while leaving the window open.
 *
 * ── ⚠️ The direction that still has no writer, stated rather than papered over ───
 *
 * A review publishes itself when its moderation window elapses (plan 9.3 — the passage of
 * time is the publisher; there is no worker, so there is no worker to fail). **That change
 * has no HTTP request behind it**, so there is nothing for this app to hang a
 * `revalidateTag` on. `nextPublicationAt` in the response says when the next such silent
 * change is due, per product, straight out of `product_review_schedule` — and a `fetch`
 * cannot set its own expiry from its own response body, so this module cannot act on it
 * alone. What closes it is a caller with the schedule in hand poking
 * `POST /api/revalidate`; until one exists, a self-published review appears on a cached
 * page at the next moderation write for that product. Named here, and in the route
 * handler, and in the phase report — not left to be discovered.
 *
 * ── Every failure is the same failure: the block is not rendered ─────────────────
 *
 * `next build` must not require a running API. This app builds 648 pages from compiled-in
 * fixtures and it still will; a review block is additive, so an unreachable, unconfigured
 * or unrecognisable API is answered by *not rendering the block* — which is exactly what
 * plan 9.5 asks for on a site with no reviews anyway ("hide the whole block rather than
 * printing 'no reviews yet' on 81 pages"). The reason is returned rather than swallowed so
 * that a test can assert which one happened, and logged once so a misconfigured deployment
 * says so in a build log instead of being silently review-less for ever.
 */

/** The port apps/api listens on by default, for a fresh checkout running `pnpm dev`. */
const DEVELOPMENT_FALLBACK = 'http://localhost:3000';

/**
 * Where apps/api is, or `null`.
 *
 * `apps/dashboard/src/lib/api/config.ts` *throws* on a missing value in production and is
 * right to: every screen there is an API call, so a dashboard that cannot reach the API is
 * not a dashboard. This storefront is the opposite — the catalogue is compiled in — so
 * throwing here would refuse to build 648 working pages because an optional block could not
 * be configured. It returns `null` and the block disappears.
 */
export function reviewsApiBaseUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production' ? null : DEVELOPMENT_FALLBACK;
}

export type ReviewsFailure =
  /** No API base URL in the environment. In production this is a deployment mistake. */
  | 'unconfigured'
  /** The network, DNS, or a build machine with no API running beside it. */
  | 'unreachable'
  /** A response that was not 2xx. */
  | 'refused'
  /** 2xx whose body this bundle does not recognise — see `wire.ts`. */
  | 'malformed';

export type ReviewsResult =
  | { readonly ok: true; readonly data: ProductReviewsWire }
  | { readonly ok: false; readonly reason: ReviewsFailure; readonly detail: string };

/** The one path this app asks apps/api for. Stated once; the seam note is in `wire.ts`. */
export const reviewsPath = (productId: string): string =>
  `/products/${encodeURIComponent(productId)}/reviews`;

const warned = new Set<string>();

/** Once per reason per process — a build log with 648 identical lines is a log nobody reads. */
function warnOnce(reason: ReviewsFailure, detail: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[reviews] block hidden on every product page: ${reason} — ${detail}`);
}

/**
 * One product's public reviews, from the cache when there is one.
 *
 * `force-cache` and `next.tags` together are what make the entry both permanent and
 * invalidatable. The tags come from `tagsForProduct` and are never spelled here — see
 * `tags.ts` for why that is load-bearing rather than tidy.
 */
export async function loadProductReviews(productId: string): Promise<ReviewsResult> {
  const base = reviewsApiBaseUrl();
  if (base === null) {
    const detail = 'NEXT_PUBLIC_API_BASE_URL is not set';
    warnOnce('unconfigured', detail);
    return { ok: false, reason: 'unconfigured', detail };
  }

  let response: Response;
  try {
    response = await fetch(`${base}${reviewsPath(productId)}`, {
      headers: { accept: 'application/json' },
      cache: 'force-cache',
      next: { tags: [...tagsForProduct(productId)] },
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warnOnce('unreachable', detail);
    return { ok: false, reason: 'unreachable', detail };
  }

  if (!response.ok) {
    const detail = `HTTP ${response.status}`;
    warnOnce('refused', detail);
    return { ok: false, reason: 'refused', detail };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warnOnce('malformed', detail);
    return { ok: false, reason: 'malformed', detail };
  }

  try {
    return { ok: true, data: decodeProductReviews(body) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warnOnce('malformed', detail);
    return { ok: false, reason: 'malformed', detail };
  }
}
