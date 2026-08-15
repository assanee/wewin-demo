import { z } from 'zod';

/**
 * Customer reviews on the wire — phase 7, plan section 9.
 *
 * ── The one shape decision, and it is plan 9.1 ───────────────────────────────────
 *
 * **A review names an order line, never a product.** Every request below carries a
 * `quoteLineId` and none carries a `productId`, because the line is what proves the
 * purchase, what knows the size and the glass the customer actually chose, and what stops a
 * two-star "too small" being read as a verdict on the product rather than on a dimension
 * the customer typed. A `productId` on a write request would be a second answer to "what is
 * this about", and the first client to send a mismatched pair would be writing a review of a
 * window nobody bought.
 *
 * The *read* side is the other way round, and that asymmetry is deliberate: a storefront
 * page is about a product, so `ProductReviewStatsWire` and `PublishedReviewWire` carry a
 * `productId` that the database derives through `product_versions` in a view. Derived on
 * the read, never accepted on the write.
 *
 * ── Never an average without its count — plan 9.5 ────────────────────────────────
 *
 * `ProductReviewStatsWire` has `ratingSum` and `ratingCount` and **no `average` field**.
 * That is the same refusal `product_review_stats` makes in Postgres, restated here so that a
 * client cannot get one without holding the other: "5.0 ★" from a single review reads as
 * advertising, and the only structural way to stop it being rendered is to make the division
 * something the caller has to perform while looking at the denominator.
 *
 * And a product nobody has reviewed has **no stats object at all** — `null`, not a zeroed
 * one. With 81 products and no orders yet, "ยังไม่มีรีวิว" on 81 pages is worse than silence
 * (plan 9.5 again), and `stats === null` is the shape that gets rendered correctly by
 * accident: `if (!stats) return null`.
 *
 * ── No status field on a review, because there is no status column ───────────────
 *
 * Publication is arithmetic, not a job (plan 9.3): a review is public when nobody hid it and
 * either somebody published it or its moderation window elapsed. Nothing flips a flag, so
 * there is no `status` to put on the wire. What a moderator's queue needs instead is
 * `publishesAt` — the moment the review publishes itself if nobody acts — which is a
 * deadline a person can read, and the difference between a queue with an SLA and the refund
 * queue plan 7.12 records as never draining.
 *
 * ── Restated, not imported ───────────────────────────────────────────────────────
 *
 * `@wewin/db` is server-only, so the closed sets below are copies of the schema's, on the
 * same terms as `ORDER_STATUSES_WIRE`. `apps/api/tests/reviews/contract-drift.pg.test.ts`
 * compares them member for member with `REVIEW_HIDDEN_REASONS` and with the rating bounds,
 * so a vocabulary that grows on one side and not the other is a red test rather than a
 * dashboard with a blank chip.
 */

/* ------------------------------------------------------------------ *
 * Closed sets and bounds
 * ------------------------------------------------------------------ */

/**
 * Why a review was hidden. ⚠️ A default vocabulary, not a decision — see the schema.
 *
 * `other` is not a loophole: a note is required with it, both here and in Postgres.
 */
export const REVIEW_HIDDEN_REASONS_WIRE = [
  'abusive',
  'personal_data',
  'off_topic',
  'spam',
  'other',
] as const;

export type ReviewHiddenReasonWire = (typeof REVIEW_HIDDEN_REASONS_WIRE)[number];

/** 1–5. Anything finer is a precision the reader cannot supply and the writer cannot mean. */
export const REVIEW_RATING_MIN_WIRE = 1;
export const REVIEW_RATING_MAX_WIRE = 5;

/**
 * The longest review this API accepts, in characters.
 *
 * ⚠️ Not a plan 13 number — the plan does not ask it. It is a bound on a `text` column that
 * has none, chosen so that a customer can describe a rainy season (plan 9.2) and a script
 * cannot post a megabyte. It is stated as the bound of the request rather than as a rule
 * about reviews, the same distinction `REVIEW_MODERATION_HOURS_MAX` draws.
 */
export const REVIEW_BODY_MAX_LENGTH = 4000;

/** The name shown beside a review. Short because it is a name, not a sentence. */
export const REVIEW_AUTHOR_NAME_MAX_LENGTH = 80;

/** A moderator's note explaining a hiding. Long enough to be a reason, short enough to read. */
export const REVIEW_MODERATION_NOTE_MAX_LENGTH = 1000;

/** The company's one reply. One per review — there are no threads (plan 9.3). */
export const REVIEW_REPLY_MAX_LENGTH = 2000;

/** How many photographs one review may carry. A window has a small number of interesting angles. */
export const REVIEW_PHOTO_MAX_COUNT = 6;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * Prose, or nothing at all. Never an empty string.
 *
 * An empty string is a form field somebody's browser posted, and it is not the same fact as
 * "this customer gave a rating and no words" — which is a complete review. The transform
 * collapses both blank and absent to `null` here rather than in a service, so every caller
 * of this schema agrees, and `reviews_body_not_blank` in Postgres is the second lock.
 */
const optionalProse = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    });

const requiredProse = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'must not be blank')
    .max(max);

export interface WriteReviewRequestWire {
  /** The line — plan 9.1. The order it belongs to is read from the line, never sent. */
  readonly quoteLineId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  /**
   * How the customer wants to be credited, or nothing.
   *
   * Not read from the account: somebody may want "ส." rather than their full name on a
   * public page, and a guest has no account to read a name from at all.
   */
  readonly authorDisplayName: string | null;
}

export const writeReviewRequestSchema: z.ZodType<WriteReviewRequestWire> = z.strictObject({
  quoteLineId: z.uuid(),
  /*
   * `z.int()` and a range, and the range is restated from the constants above rather than
   * from the database — `reviews_rating_range` is the enforcement, this is the 400 that
   * stops a 4.5 reaching a `smallint` and arriving as a rounding nobody chose.
   */
  rating: z.int().min(REVIEW_RATING_MIN_WIRE).max(REVIEW_RATING_MAX_WIRE),
  bodyTh: optionalProse(REVIEW_BODY_MAX_LENGTH),
  authorDisplayName: optionalProse(REVIEW_AUTHOR_NAME_MAX_LENGTH),
});

export interface HideReviewRequestWire {
  readonly reason: ReviewHiddenReasonWire;
  /** Required when `reason` is `other`; optional otherwise. Checked here and in Postgres. */
  readonly noteTh: string | null;
}

/**
 * Plan 9.3: hiding costs a reason and a name. The name is the caller's and is never sent —
 * it comes from the session, because a moderator naming somebody else is the failure the
 * whole "recorded person" requirement exists to stop.
 */
export const hideReviewRequestSchema: z.ZodType<HideReviewRequestWire> = z
  .strictObject({
    reason: z.enum(REVIEW_HIDDEN_REASONS_WIRE),
    noteTh: optionalProse(REVIEW_MODERATION_NOTE_MAX_LENGTH),
  })
  .refine((value) => value.reason !== 'other' || value.noteTh !== null, {
    message: "reason 'other' needs a note saying what the other reason was",
    path: ['noteTh'],
  });

export interface ReplyToReviewRequestWire {
  readonly bodyTh: string;
}

/** One reply per review, so this is a create and never an update. See the service. */
export const replyToReviewRequestSchema: z.ZodType<ReplyToReviewRequestWire> = z.strictObject({
  bodyTh: requiredProse(REVIEW_REPLY_MAX_LENGTH),
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface ReviewPhotoWire {
  readonly id: string;
  /**
   * Where the bytes are, as a path and not an absolute URL — `MediaObjectWire.path`'s
   * reasoning, which is that an absolute URL frozen into a client outlives the hostname.
   *
   * Null when the bytes have been removed: a photo whose `storageKey` was cleared by an
   * erasure or a retention sweep keeps its row so the record that a photo existed survives
   * (plan 9.4(2)), and a client renders the gap rather than a broken image.
   */
  readonly path: string | null;
  readonly width: number;
  readonly height: number;
  readonly altTextTh: string | null;
}

/**
 * One review as the storefront sees it.
 *
 * `authorUserId` and `authorGuestId` are not on this type and cannot be added to it: the
 * database view this comes from (`published_reviews`) omits both columns, so there is
 * nothing to serialise even if somebody adds a join. Plan 9.4's worry is a review page that
 * publishes more about the customer than the customer meant to.
 */
export interface PublishedReviewWire {
  readonly id: string;
  readonly productId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  /**
   * True when this review's prose and name were erased on the author's request.
   *
   * Surfaced rather than hidden, and it is the difference between "a customer gave five
   * stars and no words" and "a customer withdrew what they wrote": a page that rendered
   * both as an empty body would be telling the reader the first thing about the second.
   */
  readonly contentErased: boolean;
  readonly replyTh: string | null;
  readonly repliedAt: string | null;
  /** When it actually became visible — the moderator's stamp, or the moment the window elapsed. */
  readonly publicSince: string;
  readonly photos: readonly ReviewPhotoWire[];
}

/**
 * The numbers under a product's review block — plan 9.5.
 *
 * **There is no `average`.** Divide `ratingSum` by `ratingCount`, which you cannot do
 * without holding the count, which is the entire point.
 *
 * `ratingCount` counts hidden reviews and `visibleCount` does not, and the gap between them
 * is honest rather than embarrassing: plan 9.3 requires the rating to keep counting when the
 * text comes down, or hiding becomes a way of dressing the score. A page that wants to say
 * "eleven ratings, nine with text you can read" has both numbers to say it with.
 */
export interface ProductReviewStatsWire {
  readonly productId: string;
  readonly ratingCount: number;
  readonly ratingSum: number;
  readonly visibleCount: number;
  readonly visibleWithTextCount: number;
  readonly newestReviewAt: string;
}

/**
 * A product's review block, or the absence of one.
 *
 * `stats` is null exactly when nothing has been moderated yet, which is the state all 81
 * products are in today and will be in for months. See the module comment.
 */
export interface ProductReviewsWire {
  readonly productId: string;
  readonly stats: ProductReviewStatsWire | null;
  readonly items: readonly PublishedReviewWire[];
  readonly nextCursor: string | null;
}

/**
 * When a product's cached page will change without anybody writing anything — plan 8.2's
 * trap arriving from the direction plan 9.5 does not name.
 *
 * `apps/web` runs `revalidate = false`, so a page stands until something calls
 * `revalidateTag`. A review that publishes itself three days after it was written has **no
 * writer**: no request, no row update, no transaction to hang the call on. This is the
 * schedule the storefront needs in order to schedule a revalidation instead of discovering
 * the drift, and a product with nothing pending has no entry at all.
 */
export interface ProductReviewScheduleEntryWire {
  readonly productId: string;
  readonly nextPublicationAt: string;
  readonly pendingCount: number;
}

export interface ProductReviewScheduleWire {
  readonly entries: readonly ProductReviewScheduleEntryWire[];
  /** When this answer was computed, so a caller can tell a stale poll from an empty one. */
  readonly asOf: string;
}

/**
 * A line the caller may review, and whether they already have.
 *
 * This is what an invitation link lands on. It is scoped by the query that loads it — a
 * caller only ever sees their own delivered lines — and `reviewId` being non-null is how the
 * client knows to render the review rather than the form, without a second request that
 * could answer differently.
 */
export interface ReviewableLineWire {
  readonly quoteLineId: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly productId: string;
  readonly productVersionId: string;
  readonly productNameTh: string;
  readonly deliveredAt: string;
  /** Non-null when this line has already been reviewed — one review per line. */
  readonly reviewId: string | null;
}

export interface ReviewableLineListWire {
  readonly items: readonly ReviewableLineWire[];
}

/**
 * A review as its author sees it, immediately after writing it.
 *
 * It carries `publishesAt` because the honest answer to "where is my review?" is a date: it
 * is not published yet, nobody has to act for it to be, and this is when. A client that had
 * only `isPublic: false` would have to invent the sentence.
 */
export interface OwnReviewWire {
  readonly id: string;
  readonly quoteLineId: string;
  readonly orderId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: string;
  /** The moment it publishes itself if nobody acts. In the past once that has happened. */
  readonly publishesAt: string;
  readonly isPublic: boolean;
  readonly isHidden: boolean;
  readonly photos: readonly ReviewPhotoWire[];
}

/**
 * One row of the moderation queue — plan 9.3's SLA, as something a person can read.
 *
 * `publishesAt` is the deadline and `hoursRemaining` is it in the unit the policy is written
 * in. Both are here because a queue sorted by "oldest first" and a queue sorted by "publishes
 * soonest" are the same order only while every review shares one window, and
 * `moderation_window_hours` is per row precisely so that they need not.
 */
export interface ModerationQueueItemWire {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly productId: string;
  readonly productNameTh: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: string;
  readonly publishesAt: string;
  readonly hoursRemaining: number;
  readonly photos: readonly ReviewPhotoWire[];
}

export interface ModerationQueueWire {
  readonly items: readonly ModerationQueueItemWire[];
  /**
   * How many are in the queue at all, beside the page.
   *
   * A queue whose length is not shown is a queue nobody knows is growing, which is the
   * refund-queue failure plan 7.12 records almost word for word.
   */
  readonly total: number;
}

/** A moderated review, as the dashboard sees it after acting. */
export interface ModeratedReviewWire {
  readonly id: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: string;
  readonly publishesAt: string;
  readonly isPublic: boolean;
  readonly publishedAt: string | null;
  readonly hiddenAt: string | null;
  readonly hiddenReason: ReviewHiddenReasonWire | null;
  readonly hiddenNoteTh: string | null;
  readonly replyTh: string | null;
  readonly repliedAt: string | null;
  readonly photos: readonly ReviewPhotoWire[];
}

/**
 * What an upload did to the file, echoed back — the same field `MediaUploadResultWire` has
 * and for a sharper reason here.
 *
 * "We strip EXIF" is a claim that is either true of the file this customer just uploaded or
 * not, and plan 9.4 makes it the difference between publishing a photograph and publishing
 * an address. `stripped` names the containers that were removed (`Exif`, `XMP`, `tEXt`,
 * `trailing bytes after EOI`); `verified` is the second pass over the *stored* bytes, so the
 * answer is what came back out of the pipeline rather than what the pipeline reported.
 */
export interface ReviewPhotoUploadResultWire {
  readonly photo: ReviewPhotoWire;
  readonly stripped: readonly string[];
  readonly verified: boolean;
  readonly stripRecipe: string;
}

/* ------------------------------------------------------------------ *
 * Query shapes
 * ------------------------------------------------------------------ */

export const publishedReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  /** Opaque; pass back as `?cursor=`. It is the previous page's last `publicSince`. */
  cursor: z.iso.datetime({ offset: true }).optional(),
});

export type PublishedReviewsQuery = z.infer<typeof publishedReviewsQuerySchema>;

/**
 * ⭐ `state` added when เลิกซ่อน got a screen.
 *
 * The queue is `not review_is_moderated(...)`, and `review_is_moderated` is true the moment
 * `hidden_at` is set — so hiding a review removed it from the only list that showed it, and
 * `POST :id/unhide` had nowhere to be pressed from. A moderator could hide by mistake and
 * had no way back through any screen.
 *
 * `pending` is the default because that is what the queue has always meant, and every
 * existing caller passes no `state` at all.
 *
 * ⚠️ There is deliberately no `published` state. A published review is public and cannot be
 * brought back into a queue — the note above `moderationQueue` says so, and adding a third
 * value here would imply an action that does not exist.
 */
export const moderationQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  state: z.literal(['pending', 'hidden']).default('pending'),
});

export type ModerationQueueQuery = z.infer<typeof moderationQueueQuerySchema>;

/**
 * How far ahead the storefront asks about silent publications.
 *
 * Bounded because the answer is a scan of every pending review, and unbounded lookahead is
 * the same query with no reason to stop.
 */
export const reviewScheduleQuerySchema = z.object({
  withinHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

export type ReviewScheduleQuery = z.infer<typeof reviewScheduleQuerySchema>;
