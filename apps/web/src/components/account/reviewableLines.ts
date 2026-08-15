/**
 * ⭐ รีวิวของฉัน — the arithmetic behind the signed-in review surface.
 *
 * ── Why this exists at all, and why it is not the invitation form ────────────────
 *
 * `apps/web` already had a review form: `ReviewFormIsland`, with its copy translated into
 * all eight locales. It is reached from an emailed invitation link and posts
 * `{ token, rating, bodyTh, authorDisplayName }`.
 *
 * ⚠️ **That form has never been able to submit anything.** The API's
 * `writeReviewRequestSchema` is a `z.strictObject` taking `{ quoteLineId, rating, bodyTh,
 * authorDisplayName }` — so the storefront's body loses twice: `quoteLineId` is missing and
 * `token` is an unrecognised key. Proved against a running server: 400, both issues named.
 * The two halves were written to two different contracts and neither could reach the other.
 *
 * On top of that, nothing mints an invitation token. `review-invitation.ts` records the
 * deferral: there is no invitation table, no rule row in `notification_rules` and no
 * `order.review_invitation.customer` template, so the email is never sent and the link never
 * exists. Nobody has been hitting a broken page, because nobody has been given one.
 *
 * So this surface uses the path the API actually implements and has tests for: a signed-in
 * customer asks `GET /reviews/reviewable-lines` for the delivered lines that are theirs, and
 * posts `{ quoteLineId, … }`. It needs no token scheme, and deciding what the emailed link
 * should carry stays the owner's call rather than one made accidentally here.
 */

/** One delivered line, as `GET /reviews/reviewable-lines` returns it. */
export interface ReviewableLine {
  readonly quoteLineId: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly productId: string;
  readonly productNameTh: string;
  readonly deliveredAt: string;
  /** Non-null once this line has been reviewed — one review per line. */
  readonly reviewId: string | null;
}

export interface ReviewableSplit {
  /** Still open to a review, newest delivery first. */
  readonly pending: readonly ReviewableLine[];
  /** Already reviewed. Kept, because "I already did that one" is an answer. */
  readonly written: readonly ReviewableLine[];
}

/**
 * Split the list, newest delivery first within each half.
 *
 * ⚠️ The written half is kept rather than filtered away, and that is the whole reason this is
 * a function instead of a `.filter()` at the call site. A customer who reviewed something last
 * month and comes back looking for it needs to be told it is done — a list that silently drops
 * it reads as "the system lost my review", which is the complaint the reviewed-state badge
 * exists to prevent.
 *
 * The spread before `sort` is load-bearing: the argument is the array held in React state and
 * `sort` mutates in place.
 */
export function splitReviewable(lines: readonly ReviewableLine[]): ReviewableSplit {
  const newestFirst = (a: ReviewableLine, b: ReviewableLine): number =>
    b.deliveredAt.localeCompare(a.deliveredAt);

  return {
    pending: [...lines].filter((line) => line.reviewId === null).sort(newestFirst),
    written: [...lines].filter((line) => line.reviewId !== null).sort(newestFirst),
  };
}

/** A rating is 1–5 and a review cannot be sent without one. */
export const REVIEW_RATINGS = [1, 2, 3, 4, 5] as const;

export type ReviewRating = (typeof REVIEW_RATINGS)[number];

export const isReviewRating = (value: number): value is ReviewRating =>
  (REVIEW_RATINGS as readonly number[]).includes(value);

/**
 * The body for `POST /reviews`, built so the shape is stated in one place.
 *
 * ⚠️ `bodyTh` and `authorDisplayName` are **omitted when blank rather than sent as `''`**.
 * `optionalProse` refuses an empty string, so sending one turns "I gave five stars and no
 * words" — the commonest review there is — into a 400 the customer cannot act on.
 */
export function writeReviewBody(
  quoteLineId: string,
  rating: ReviewRating,
  bodyTh: string,
  authorDisplayName: string,
): Readonly<Record<string, unknown>> {
  const text = bodyTh.trim();
  const name = authorDisplayName.trim();

  return {
    quoteLineId,
    rating,
    ...(text === '' ? {} : { bodyTh: text }),
    ...(name === '' ? {} : { authorDisplayName: name }),
  };
}
