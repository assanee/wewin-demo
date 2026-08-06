/**
 * What the storefront reads from apps/api, **decoded rather than cast**.
 *
 * ── This is the first fetch this app has ever had ────────────────────────────────
 *
 * Worth saying out loud, because every cache decision below follows from it. Until this
 * phase, `grep -rn "fetch("` over `apps/web` returned nothing: the catalogue is compiled in
 * from `@wewin/core/fixtures`, and `ProductCard`'s long note explains why that means
 * `revalidateTag` had nothing to invalidate and was therefore deliberately not built. A
 * review cannot come from a fixture — it is written by a customer after delivery — so it is
 * the first thing on this storefront that arrives over a wire, and it is why the
 * invalidation half becomes buildable in the same round.
 *
 * ── The decoder is the contract, and the contract is stated here ─────────────────
 *
 * `apps/web` does not depend on `@wewin/contract` (it never needed to: nothing crossed a
 * wire). Rather than add the dependency for one endpoint and inherit a package's release
 * cadence into a storefront's bundle, the shape is written out here and *checked* — the
 * same rule `apps/dashboard/src/lib/api/client.ts` states for its own decoders: the
 * shorthand `body as ProductReviews` is how a field renamed six weeks ago becomes
 * `undefined` three components deep instead of a message at the point it was read.
 *
 * 🔗 **The seam.** The endpoint below is what this app asks for. If apps/api ships review
 * wire schemas in `@wewin/contract`, this file is the one to delete — its types replaced by
 * the package's, its `decodeProductReviews` by the package's parser. Until then a mismatch
 * shows up as a `MALFORMED` reason from `lib/reviews/api.ts` and a hidden review block,
 * never as a wrong page.
 *
 *     GET {API}/products/{productId}/reviews
 *     → 200 { productId, stats, reviews[], nextPublicationAt, pendingCount }
 *
 * The fields mirror `published_reviews` and `product_review_stats` in packages/db, which is
 * where the reasoning for each of them lives.
 *
 * ── Counts are bigint on the wire, whatever JSON did to them ─────────────────────
 *
 * `count(*)::bigint` and `sum(r.rating)::bigint` are what the views return, and a bigint
 * becomes a JSON string in most serialisers and a JSON number in the rest. Both are
 * accepted and both become `bigint` here, so nothing downstream has to know which one the
 * API happened to send. A non-integer, a negative or a `NaN` is a decode failure — not a
 * silent `0`, which would render as "no reviews" on a product that has some.
 */

/* ------------------------------------------------------------------ *
 * The shapes
 * ------------------------------------------------------------------ */

/** One photograph the customer attached, already stripped and re-encoded by the API. */
export interface ReviewPhotoWire {
  readonly id: string;
  /** Absolute or root-relative; this app never constructs one. */
  readonly url: string;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
}

/** The exact window this review is about — plan 9.1's whole payoff. */
export interface ReviewSizeWire {
  readonly widthUm: bigint;
  readonly heightUm: bigint;
}

/** One published review. Mirrors the `published_reviews` view, minus the author columns it omits. */
export interface PublishedReviewWire {
  readonly id: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  /**
   * Set when the prose and the name were removed under an erasure request, which is a
   * different fact from a customer who wrote a rating and no words. The card says so
   * rather than rendering an anonymous blank — see `ReviewCard`.
   */
  readonly contentErasedAt: string | null;
  readonly replyTh: string | null;
  readonly repliedAt: string | null;
  /** `COALESCE(published_at, created_at + moderation_window)` — the honest publication date. */
  readonly publicSince: string;
  readonly size: ReviewSizeWire | null;
  readonly photos: readonly ReviewPhotoWire[];
}

/** `product_review_stats` for one product. Note the absence of an average — plan 9.5. */
export interface ReviewStatsWire {
  /** Every moderated rating, **hidden ones included**. This is the average's denominator. */
  readonly ratingCount: bigint;
  readonly ratingSum: bigint;
  /** Not hidden. Fewer than `ratingCount` is normal and is not an error. */
  readonly visibleCount: bigint;
  readonly visibleWithTextCount: bigint;
}

export interface ProductReviewsWire {
  readonly productId: string;
  /** `null` when the product has no moderated review at all — `GROUP BY` returns no row. */
  readonly stats: ReviewStatsWire | null;
  readonly reviews: readonly PublishedReviewWire[];
  /**
   * From `product_review_schedule`: when the next review publishes itself with **no writer
   * anywhere** (plan 9.3 — the passage of time is the publisher). `null` when nothing is
   * pending. `lib/reviews/api.ts` turns it into this fetch's cache lifetime, which is the
   * only mechanism available to a page that must not wait for a request that never comes.
   */
  readonly nextPublicationAt: string | null;
  readonly pendingCount: number;
}

/* ------------------------------------------------------------------ *
 * The decoder
 * ------------------------------------------------------------------ */

const fail = (what: string): never => {
  throw new TypeError(`reviews wire: ${what}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const field = (source: Readonly<Record<string, unknown>>, name: string): unknown => source[name];

const asString = (value: unknown, name: string): string =>
  typeof value === 'string' ? value : fail(`${name} is not a string`);

const asNullableString = (value: unknown, name: string): string | null =>
  value === null || value === undefined ? null : asString(value, name);

/**
 * A whole number that arrived as either a JSON number or a JSON string.
 *
 * Rejecting rather than coercing is the point: `Number('12abc')` is `NaN` and `BigInt('')`
 * is `0n`, and both of those render as a plausible page.
 */
const asBigInt = (value: unknown, name: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return fail(`${name} is not a whole number`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return fail(`${name} is not an integer`);
};

const asCount = (value: unknown, name: string): bigint => {
  const parsed = asBigInt(value, name);
  return parsed < 0n ? fail(`${name} is negative`) : parsed;
};

const asRating = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`${name} is not an integer`);
  // 1–5, the bounds `reviews_rating_range` enforces. A 0 or a 6 is a server this client
  // does not understand, and five stars is not a scale that can absorb one quietly.
  return value >= 1 && value <= 5 ? value : fail(`${name} is outside 1–5`);
};

const decodePhoto = (value: unknown): ReviewPhotoWire => {
  if (!isRecord(value)) return fail('photo is not an object');
  const widthPx = field(value, 'widthPx');
  const heightPx = field(value, 'heightPx');
  return {
    id: asString(field(value, 'id'), 'photo.id'),
    url: asString(field(value, 'url'), 'photo.url'),
    widthPx: typeof widthPx === 'number' && Number.isInteger(widthPx) ? widthPx : null,
    heightPx: typeof heightPx === 'number' && Number.isInteger(heightPx) ? heightPx : null,
  };
};

const decodeSize = (value: unknown): ReviewSizeWire | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return fail('size is not an object');
  return {
    widthUm: asBigInt(field(value, 'widthUm'), 'size.widthUm'),
    heightUm: asBigInt(field(value, 'heightUm'), 'size.heightUm'),
  };
};

const decodeReview = (value: unknown): PublishedReviewWire => {
  if (!isRecord(value)) return fail('review is not an object');

  const photos = field(value, 'photos');
  if (photos !== undefined && photos !== null && !Array.isArray(photos)) {
    return fail('review.photos is not an array');
  }

  return {
    id: asString(field(value, 'id'), 'review.id'),
    rating: asRating(field(value, 'rating'), 'review.rating'),
    bodyTh: asNullableString(field(value, 'bodyTh'), 'review.bodyTh'),
    authorDisplayName: asNullableString(field(value, 'authorDisplayName'), 'review.authorDisplayName'),
    contentErasedAt: asNullableString(field(value, 'contentErasedAt'), 'review.contentErasedAt'),
    replyTh: asNullableString(field(value, 'replyTh'), 'review.replyTh'),
    repliedAt: asNullableString(field(value, 'repliedAt'), 'review.repliedAt'),
    publicSince: asString(field(value, 'publicSince'), 'review.publicSince'),
    size: decodeSize(field(value, 'size')),
    photos: Array.isArray(photos) ? photos.map(decodePhoto) : [],
  };
};

const decodeStats = (value: unknown): ReviewStatsWire | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return fail('stats is not an object');

  const ratingCount = asCount(field(value, 'ratingCount'), 'stats.ratingCount');
  const ratingSum = asCount(field(value, 'ratingSum'), 'stats.ratingSum');

  /*
   * A count of zero with no reviews is `null` in this app's vocabulary, not a stats object
   * full of zeroes. The view produces no row for a product nobody has reviewed, so a zeroed
   * object means the API invented one — and the difference matters because `null` hides the
   * block (plan 9.5) while a zero would render "0.0 ★ from 0 reviews" on 81 pages.
   */
  if (ratingCount === 0n) return null;

  // Five stars maximum, one minimum: a sum outside those bounds is not a rounding
  // disagreement, it is a different denominator than the one being sent.
  if (ratingSum < ratingCount || ratingSum > ratingCount * 5n) {
    return fail('stats.ratingSum is impossible for stats.ratingCount');
  }

  const visibleCount = asCount(field(value, 'visibleCount'), 'stats.visibleCount');
  if (visibleCount > ratingCount) return fail('stats.visibleCount exceeds stats.ratingCount');

  return {
    ratingCount,
    ratingSum,
    visibleCount,
    visibleWithTextCount: asCount(field(value, 'visibleWithTextCount'), 'stats.visibleWithTextCount'),
  };
};

/** The whole body, or a `TypeError` naming the field that was wrong. */
export function decodeProductReviews(body: unknown): ProductReviewsWire {
  if (!isRecord(body)) return fail('body is not an object');

  const reviews = field(body, 'reviews');
  if (!Array.isArray(reviews)) return fail('reviews is not an array');

  const pendingCount = field(body, 'pendingCount');

  return {
    productId: asString(field(body, 'productId'), 'productId'),
    stats: decodeStats(field(body, 'stats')),
    reviews: reviews.map(decodeReview),
    nextPublicationAt: asNullableString(field(body, 'nextPublicationAt'), 'nextPublicationAt'),
    pendingCount:
      typeof pendingCount === 'number' && Number.isInteger(pendingCount) && pendingCount >= 0
        ? pendingCount
        : 0,
  };
}
