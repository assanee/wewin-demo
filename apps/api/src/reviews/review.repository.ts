import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { orders, products, productVersions, quoteLines, reviewPhotos, reviews } from '@wewin/db/schema';
import type { OrderStatus, ReviewHiddenReason } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, asc, desc, eq, inArray, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
import { authorColumns, authorFilter, type ReviewReach } from './review-reach';

/**
 * The only thing in this application that reads or writes `reviews` and `review_photos`.
 *
 * ── The one rule ────────────────────────────────────────────────────────────────
 *
 * Every method that can return a row a caller is not entitled to takes a `ReviewReach` and
 * puts `authorFilter(reach)` **in the WHERE clause**. There is no method that takes an id
 * without a reach, no overload that omits one, and no `findByIdUnsafe` kept for a debugging
 * script. Plan 7.4 trap 2 answered structurally rather than by review: not "remember to
 * check the owner" but "the row you did not own was never in the result set".
 *
 * The one place a reach is absent is `publishedReviews` / `productStats` / `schedule`, and
 * the absence is the design: they read `published_reviews` and `product_review_stats`, which
 * are views whose WHERE clause is `review_is_public(r)` and which do not project
 * `author_user_id` or `author_guest_id` at all. There is no person in the result to scope
 * by, and that is checked in Postgres rather than promised here.
 *
 * ── Views rather than the query builder, for three reads ────────────────────────
 *
 * `published_reviews`, `product_review_stats` and `product_review_schedule` live in
 * `drizzle/0020_review_guards.sql` and have no drizzle table object. Raw SQL is not a
 * shortcut here — it is the point. Restating `review_is_public(r)` in TypeScript would be a
 * second definition of "published", and the failure mode plan 7.13 opens with is six
 * mechanisms pretending to be one. The view is the definition; this file selects from it.
 *
 * ── Time comes from the database, never from this process ───────────────────────
 *
 * Every `now()` below is Postgres's, on `notifications.repository.ts`'s reasoning and with a
 * sharper edge: publication *is* a comparison against `now()` (plan 9.3), so a container
 * whose clock has drifted would not merely poll early — it would disagree with the database
 * about whether a review is published, which is a page that shows a review the API says is
 * pending. The only value this process supplies is an interval.
 */

/** Drizzle names the transaction type nowhere public; read off the callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A line the caller owns, loaded by a query that filtered on ownership.
 *
 * `orderStatus` is carried rather than filtered on, and that is deliberate: the ownership
 * term is already in the query, so the caller *is* entitled to know that their own order has
 * not been delivered yet. Refusing that with the same 404 as "no such line" would be
 * politeness toward an attacker who, by construction, cannot reach this row.
 */
export interface OwnedLine {
  readonly quoteLineId: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly orderStatus: OrderStatus;
  /** Null on a `freeform` line — a delivery charge has no version and cannot be reviewed. */
  readonly productVersionId: string | null;
  readonly productId: string | null;
  readonly productNameTh: string | null;
  readonly removedAt: Date | null;
  readonly deliveredAt: Date;
  /** Non-null when this line already has a review. One per line. */
  readonly reviewId: string | null;
}

export interface ReviewRow {
  readonly id: string;
  readonly orderId: string;
  readonly quoteLineId: string;
  readonly productVersionId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly contentErasedAt: Date | null;
  readonly moderationWindowHours: number;
  readonly publishedAt: Date | null;
  readonly hiddenAt: Date | null;
  readonly hiddenReason: ReviewHiddenReason | null;
  readonly hiddenNoteTh: string | null;
  readonly replyTh: string | null;
  readonly repliedAt: Date | null;
  readonly createdAt: Date;
  /** `created_at + moderation_window_hours`, computed by Postgres. The SLA, as a date. */
  readonly publishesAt: Date;
  /** `review_is_public(r)`, evaluated by Postgres against Postgres's clock. */
  readonly isPublic: boolean;
}

export interface PhotoRow {
  readonly id: string;
  readonly reviewId: string;
  readonly seq: number;
  readonly storageKey: string | null;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly altTextTh: string | null;
}

export interface QueueRow extends ReviewRow {
  readonly orderNo: string | null;
  readonly productId: string;
  readonly productNameTh: string;
}

export interface PublishedRow {
  readonly id: string;
  readonly productId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly contentErasedAt: Date | null;
  readonly replyTh: string | null;
  readonly repliedAt: Date | null;
  readonly publicSince: Date;
}

export interface StatsRow {
  readonly productId: string;
  readonly ratingCount: number;
  readonly ratingSum: number;
  readonly visibleCount: number;
  readonly visibleWithTextCount: number;
  readonly newestReviewAt: Date;
}

export interface ScheduleRow {
  readonly productId: string;
  readonly nextPublicationAt: Date;
  readonly pendingCount: number;
}

export interface NewReview {
  readonly orderId: string;
  readonly quoteLineId: string;
  readonly productVersionId: string;
  readonly rating: number;
  readonly bodyTh: string | null;
  readonly authorDisplayName: string | null;
  readonly moderationWindowHours: number;
}

export interface NewPhoto {
  readonly reviewId: string;
  readonly storageKey: string;
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly byteSize: bigint;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly sourceChecksumSha256: string;
  readonly stripRecipe: string;
  readonly altTextTh: string | null;
}

/**
 * `created_at + moderation_window_hours` and `review_is_public(row)`, as select expressions.
 *
 * Both are computed in Postgres for the reason in the module comment. `review_is_public` is
 * called on the *whole row* — the function takes a `reviews` composite — so it cannot be
 * given a subset of columns that happens to look right.
 */
/*
 * `.mapWith` and not a bare `sql<Date>`: the generic is a *claim* to TypeScript and nothing
 * else, so a raw expression arrives from `pg` as whatever the driver parsed — a string, here
 * — and `publishesAt.toISOString()` throws at the serialisation boundary rather than at the
 * query. Borrowing `reviews.createdAt`'s mapper makes the claim true instead of asserted.
 */
const PUBLISHES_AT = sql`(${reviews.createdAt} + make_interval(hours => ${reviews.moderationWindowHours}))`.mapWith(
  reviews.createdAt,
);
const IS_PUBLIC = sql<boolean>`review_is_public(${reviews})`;

const REVIEW_COLUMNS = {
  id: reviews.id,
  orderId: reviews.orderId,
  quoteLineId: reviews.quoteLineId,
  productVersionId: reviews.productVersionId,
  rating: reviews.rating,
  bodyTh: reviews.bodyTh,
  authorDisplayName: reviews.authorDisplayName,
  contentErasedAt: reviews.contentErasedAt,
  moderationWindowHours: reviews.moderationWindowHours,
  publishedAt: reviews.publishedAt,
  hiddenAt: reviews.hiddenAt,
  hiddenReason: reviews.hiddenReason,
  hiddenNoteTh: reviews.hiddenNoteTh,
  replyTh: reviews.replyTh,
  repliedAt: reviews.repliedAt,
  createdAt: reviews.createdAt,
  publishesAt: PUBLISHES_AT,
  isPublic: IS_PUBLIC,
} as const;

/**
 * The line columns, in one place so the two loaders cannot drift.
 *
 * `deliveredAt` is a correlated subquery over the spine rather than a join, because joining
 * `order_events` multiplies the line by every event on its order — and the fix somebody
 * reaches for is a `DISTINCT` that hides what it is hiding. There is no `delivered_at` column
 * on `orders`; the spine is where that fact lives (plan 7.1), so reading it here means the
 * date a client shows and the date `review-invitation.ts` counts from are the same date.
 */
const LINE_COLUMNS = {
  quoteLineId: quoteLines.id,
  orderId: quoteLines.orderId,
  orderNo: orders.orderNo,
  orderStatus: orders.status,
  productVersionId: quoteLines.productVersionId,
  productId: productVersions.productId,
  productNameTh: products.nameTh,
  removedAt: quoteLines.removedAt,
  deliveredAt: sql`(
    select max(e.created_at)
      from order_events e
     where e.order_id = ${orders.id}
       and e.event_type = 'delivered'
  )`.mapWith(orders.createdAt),
  reviewId: reviews.id,
} as const;

const PHOTO_COLUMNS = {
  id: reviewPhotos.id,
  reviewId: reviewPhotos.reviewId,
  seq: reviewPhotos.seq,
  storageKey: reviewPhotos.storageKey,
  contentType: reviewPhotos.contentType,
  width: reviewPhotos.width,
  height: reviewPhotos.height,
  altTextTh: reviewPhotos.altTextTh,
} as const;

/**
 * Any uuid version, checked before the statement rather than after it.
 *
 * `where id = 'nonsense'` against a uuid column is SQLSTATE 22P02 — a 500 for a request that
 * is simply about a review that cannot exist. Same treatment as `isOrderUuid`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isReviewUuid(value: string): boolean {
  return UUID.test(value);
}

@Injectable()
export class ReviewRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** The one door into a transaction, so a caller cannot forget to open one. */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /**
   * One line the caller owns — the query plan 7.4 trap 2 is about.
   *
   * ⚠️ **`authorFilter(reach)` is the second term and it is never optional.** Everything
   * else this method knows — the status, whether the line was removed in a redesign, whether
   * it is a `freeform` charge, whether it has been reviewed already — is *carried back* so
   * the service can give a specific answer. Only ownership is a filter, because only
   * ownership must never be answerable.
   *
   * `delivered_at` comes from `order_events` rather than from a column on the order: there
   * is no `delivered_at` on `orders`, the spine is where the fact lives, and reading it here
   * means the invitation delay in `review-invitation.ts` and the "how long ago" a client
   * shows are the same date.
   */
  async findOwnedLine(reach: ReviewReach, quoteLineId: string): Promise<OwnedLine | undefined> {
    if (!isReviewUuid(quoteLineId)) return undefined;

    const rows = await this.db
      .select(LINE_COLUMNS)
      .from(quoteLines)
      .innerJoin(orders, eq(orders.id, quoteLines.orderId))
      .leftJoin(productVersions, eq(productVersions.id, quoteLines.productVersionId))
      .leftJoin(products, eq(products.id, productVersions.productId))
      .leftJoin(reviews, eq(reviews.quoteLineId, quoteLines.id))
      .where(sql`${eq(quoteLines.id, quoteLineId)} and ${authorFilter(reach)}`)
      .limit(1);

    return rows[0] as OwnedLine | undefined;
  }

  /**
   * Every line this caller could review — what an invitation link lands on.
   *
   * Filtered to `delivered` here, unlike `findOwnedLine`, because this is a list and a list
   * of things you cannot do yet is not a list anybody asked for. `removed_at is null` for
   * the reason `reviews_guard_write()` gives: a line dropped during a redesign was never
   * delivered, and the composite foreign key cannot see that the row is still there.
   */
  async listReviewableLines(reach: ReviewReach, limit: number): Promise<readonly OwnedLine[]> {
    const rows = await this.db
      .select(LINE_COLUMNS)
      .from(quoteLines)
      .innerJoin(orders, eq(orders.id, quoteLines.orderId))
      .innerJoin(productVersions, eq(productVersions.id, quoteLines.productVersionId))
      .innerJoin(products, eq(products.id, productVersions.productId))
      .leftJoin(reviews, eq(reviews.quoteLineId, quoteLines.id))
      .where(
        sql`${authorFilter(reach)}
            and ${eq(orders.status, 'delivered')}
            and ${quoteLines.removedAt} is null`,
      )
      .orderBy(desc(quoteLines.createdAt))
      .limit(limit);

    return rows as readonly OwnedLine[];
  }

  /**
   * Write the review.
   *
   * ⭐ `orderId` and `productVersionId` come from the row `findOwnedLine` returned, never
   * from the request — a client that could name its own order id would be naming somebody
   * else's. The two composite foreign keys in the schema would catch a mismatch, and this is
   * the layer that makes the mismatch unrepresentable rather than merely caught.
   *
   * The author columns come from the reach for the same reason: `authorColumns(reach)`
   * returns `undefined` for anything that is not `owned`, so a moderator's or the process's
   * reach cannot produce an insert at all.
   */
  async insertReview(reach: ReviewReach, review: NewReview): Promise<ReviewRow | undefined> {
    const author = authorColumns(reach);
    if (author === undefined) return undefined;

    const rows = await this.db
      .insert(reviews)
      .values({ ...review, ...author })
      .returning(REVIEW_COLUMNS);

    return rows[0] as ReviewRow | undefined;
  }

  /** One review the caller owns, or one review at all for a moderator. Same predicate, one method. */
  async findReview(reach: ReviewReach, reviewId: string): Promise<ReviewRow | undefined> {
    if (!isReviewUuid(reviewId)) return undefined;

    const rows = await this.db
      .select(REVIEW_COLUMNS)
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .where(sql`${eq(reviews.id, reviewId)} and ${authorFilter(reach)}`)
      .limit(1);

    return rows[0] as ReviewRow | undefined;
  }

  /**
   * The same row, locked, inside a transaction the caller opened.
   *
   * `FOR UPDATE` on `reviews` alone — `.for('update', { of: reviews })` — because the join
   * to `orders` exists to carry the ownership term and locking it would put a moderation
   * action in the way of the order lifecycle. Two moderators hitting hide and reply at the
   * same instant are ordered by this; what they may each write is `reviews_guard_write()`'s.
   */
  async lockReview(tx: Tx, reach: ReviewReach, reviewId: string): Promise<ReviewRow | undefined> {
    if (!isReviewUuid(reviewId)) return undefined;

    const rows = await tx
      .select(REVIEW_COLUMNS)
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .where(sql`${eq(reviews.id, reviewId)} and ${authorFilter(reach)}`)
      .limit(1)
      .for('update', { of: reviews });

    return rows[0] as ReviewRow | undefined;
  }

  /**
   * Hide it — plan 9.3's reason and person, written as one statement so they cannot come apart.
   *
   * `reviews_hidden_shape` requires all three columns or none, and this sets all three. The
   * rating is not in the SET list and could not be: `reviews_guard_write()` freezes it once
   * the review is moderated, which is what stops hide-and-retouch being one UPDATE.
   */
  async hide(
    tx: Tx,
    reviewId: string,
    byUserId: string,
    reason: ReviewHiddenReason,
    noteTh: string | null,
  ): Promise<ReviewRow | undefined> {
    const rows = await tx
      .update(reviews)
      .set({
        hiddenAt: sql`now()`,
        hiddenByUserId: byUserId,
        hiddenReason: reason,
        hiddenNoteTh: noteTh,
        updatedAt: sql`now()`,
      })
      .where(eq(reviews.id, reviewId))
      .returning(REVIEW_COLUMNS);

    return rows[0] as ReviewRow | undefined;
  }

  /**
   * Un-hide it — all three columns back to NULL, together.
   *
   * ⚠️ **This leaves no history, and that is a limit rather than a feature.** The table
   * records the current moderation state, not its churn: a review hidden and restored twice
   * is indistinguishable from one that was never touched, and the person who hid it is gone
   * from the row. Stated here as well as in the schema because this is the method that
   * destroys the evidence. A `review_moderation_events` child table is the answer if it ever
   * matters; nobody has asked for it, and inventing an audit table nobody reads is how the
   * *next* thing that matters gets written to a table nobody reads either.
   *
   * The note is cleared with the rest: `reviews_hidden_note_needs_a_hiding` refuses a note
   * explaining a hiding that is no longer there.
   */
  async unhide(tx: Tx, reviewId: string): Promise<ReviewRow | undefined> {
    const rows = await tx
      .update(reviews)
      .set({
        hiddenAt: null,
        hiddenByUserId: null,
        hiddenReason: null,
        hiddenNoteTh: null,
        updatedAt: sql`now()`,
      })
      .where(eq(reviews.id, reviewId))
      .returning(REVIEW_COLUMNS);

    return rows[0] as ReviewRow | undefined;
  }

  /**
   * Publish it now, rather than waiting for the window — plan 9.3.
   *
   * ⚠️ **Nothing calls this on the deadline path, because there is no deadline path.** A
   * review whose window has elapsed is already public; `review_is_public()` says so, the
   * views say so, and no row is written when it happens. This method exists for the *early*
   * decision — a moderator who has read it and wants it up today — and `published_by_user_id`
   * is what makes that decision have a name on it (`reviews_published_shape`).
   */
  async publish(tx: Tx, reviewId: string, byUserId: string): Promise<ReviewRow | undefined> {
    const rows = await tx
      .update(reviews)
      .set({ publishedAt: sql`now()`, publishedByUserId: byUserId, updatedAt: sql`now()` })
      .where(eq(reviews.id, reviewId))
      .returning(REVIEW_COLUMNS);

    return rows[0] as ReviewRow | undefined;
  }

  /**
   * The company's one reply — plan 9.3, *"one reply per review; no threads"*.
   *
   * `reply_th is null` is in the WHERE clause and not only checked by the service, so two
   * salespeople answering the same review at the same moment produce one reply and one "no
   * rows updated" rather than a lost first answer. That is the same shape as the outbox's
   * conditional claim, and it is why this returns `undefined` rather than throwing.
   */
  async reply(tx: Tx, reviewId: string, byUserId: string, bodyTh: string): Promise<ReviewRow | undefined> {
    const rows = await tx
      .update(reviews)
      .set({ replyTh: bodyTh, repliedByUserId: byUserId, repliedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(reviews.id, reviewId), sql`${reviews.replyTh} is null`))
      .returning(REVIEW_COLUMNS);

    return rows[0] as ReviewRow | undefined;
  }

  /* ---------------------------------------------------------------- *
   * Photographs
   * ---------------------------------------------------------------- */

  async listPhotos(reviewIds: readonly string[]): Promise<ReadonlyMap<string, readonly PhotoRow[]>> {
    if (reviewIds.length === 0) return new Map();

    const rows = await this.db
      .select(PHOTO_COLUMNS)
      .from(reviewPhotos)
      .where(inArray(reviewPhotos.reviewId, [...reviewIds]))
      .orderBy(asc(reviewPhotos.reviewId), asc(reviewPhotos.seq));

    const grouped = new Map<string, PhotoRow[]>();
    for (const row of rows as readonly PhotoRow[]) {
      const list = grouped.get(row.reviewId) ?? [];
      list.push(row);
      grouped.set(row.reviewId, list);
    }
    return grouped;
  }

  /**
   * The next free `seq` for a review, taken inside the caller's transaction under a lock on
   * the parent.
   *
   * `review_photos_review_seq_key` would catch a collision as a 23505; this makes two
   * concurrent uploads by the same customer serialise instead, which is the difference
   * between "one of your photos failed, try again" and both succeeding. The lock is on the
   * `reviews` row rather than on `review_photos`, because a gap-free sequence has to be
   * decided somewhere that exists before the first photo does.
   */
  async nextPhotoSeq(tx: Tx, reviewId: string): Promise<number> {
    await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, reviewId)).for('update');

    const rows = await tx
      .select({ seq: reviewPhotos.seq })
      .from(reviewPhotos)
      .where(eq(reviewPhotos.reviewId, reviewId))
      .orderBy(desc(reviewPhotos.seq))
      .limit(1);

    const highest = rows[0]?.seq;
    return highest === undefined ? 1 : highest + 1;
  }

  async insertPhoto(tx: Tx, seq: number, photo: NewPhoto): Promise<PhotoRow | undefined> {
    const rows = await tx
      .insert(reviewPhotos)
      .values({ ...photo, seq })
      .returning(PHOTO_COLUMNS);

    return rows[0] as PhotoRow | undefined;
  }

  /**
   * Remove a photograph while the review — and therefore the rating — survives. Plan 9.4(2).
   *
   * The only DELETE in this feature, and the only one `review_photos_guard_write()` permits
   * anywhere in the phase. The reach is in the WHERE clause through a correlated exists on
   * the parent review's order, so a customer deleting "photo id X" cannot delete somebody
   * else's by guessing a uuid.
   */
  async deletePhoto(reach: ReviewReach, photoId: string): Promise<PhotoRow | undefined> {
    if (!isReviewUuid(photoId)) return undefined;

    const rows = await this.db
      .delete(reviewPhotos)
      .where(
        sql`${eq(reviewPhotos.id, photoId)}
            and exists (
              select 1
                from ${reviews}
                join ${orders} on ${orders.id} = ${reviews.orderId}
               where ${reviews.id} = ${reviewPhotos.reviewId}
                 and ${authorFilter(reach)}
            )`,
      )
      .returning(PHOTO_COLUMNS);

    return rows[0] as PhotoRow | undefined;
  }

  /**
   * One photograph's bytes, for the serving route — and the two facts that decide who sees it.
   *
   * `isPublic` is `review_is_public()` on the parent, so a moderator's reach and a visitor's
   * reach read the same column rather than two opinions about publication. The service
   * decides; this returns the fact.
   */
  async findPhotoForServing(
    photoId: string,
  ): Promise<{ readonly photo: PhotoRow; readonly isPublic: boolean } | undefined> {
    if (!isReviewUuid(photoId)) return undefined;

    const rows = await this.db
      .select({ ...PHOTO_COLUMNS, isPublic: IS_PUBLIC })
      .from(reviewPhotos)
      .innerJoin(reviews, eq(reviews.id, reviewPhotos.reviewId))
      .where(eq(reviewPhotos.id, photoId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return undefined;

    const { isPublic, ...photo } = row;
    return { photo: photo as PhotoRow, isPublic };
  }

  /* ---------------------------------------------------------------- *
   * The moderation queue — plan 9.3's SLA, as something a person reads
   * ---------------------------------------------------------------- */

  /**
   * What is still inside its window, soonest deadline first.
   *
   * ⚠️ **Ordered by the deadline and not by `created_at`.** They are the same order only
   * while every review shares one window, and `moderation_window_hours` is per row precisely
   * so that they need not be. A queue sorted oldest-first quietly publishes the review with
   * the short window while somebody works through older ones with long windows — which is
   * the SLA being missed by a queue that looks like it is being worked.
   *
   * `not review_is_moderated(r)` and nothing else: a review that has been hidden or
   * published has been acted on and is no longer waiting, and a review whose window elapsed
   * is already public and cannot be brought back into a queue.
   */
  async moderationQueue(
    reach: ReviewReach,
    limit: number,
    offset: number,
    state: 'pending' | 'hidden' = 'pending',
  ): Promise<{ readonly items: readonly QueueRow[]; readonly total: number }> {
    /*
     * ⭐ `hidden` added when เลิกซ่อน got a screen. `review_is_moderated` is true as soon as
     * `hidden_at` is set, so the pending queue is exactly the reviews nobody has ruled on —
     * and a hidden one used to fall out of every list there was, taking the only route to
     * `unhide` with it.
     *
     * Not `not published_at is null and hidden_at is not null`: a review can be hidden after
     * it was published, and that one still belongs on the hidden list because un-hiding is
     * still the move. `hidden_at is not null` is the whole condition.
     */
    const subset =
      state === 'hidden'
        ? sql`${reviews.hiddenAt} is not null`
        : sql`not review_is_moderated(${reviews})`;
    const where = sql`${authorFilter(reach)} and ${subset}`;

    const items = await this.db
      .select({
        ...REVIEW_COLUMNS,
        orderNo: orders.orderNo,
        productId: productVersions.productId,
        productNameTh: products.nameTh,
      })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .innerJoin(productVersions, eq(productVersions.id, reviews.productVersionId))
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(where)
      .orderBy(asc(PUBLISHES_AT), asc(reviews.id))
      .limit(limit)
      .offset(offset);

    const counted = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(reviews)
      .innerJoin(orders, eq(orders.id, reviews.orderId))
      .where(where);

    return { items: items as readonly QueueRow[], total: counted[0]?.total ?? 0 };
  }

  /* ---------------------------------------------------------------- *
   * The public reads — three views, no reach, and no person in them
   * ---------------------------------------------------------------- */

  /**
   * A product's published reviews. `published_reviews` decides what "published" means.
   *
   * The cursor is `public_since` descending, which is the column the view computes as
   * `coalesce(published_at, created_at + window)` — the honest publication date. Paging on
   * `created_at` would put a review published early by a moderator on the wrong page.
   */
  async publishedReviews(
    productId: string,
    limit: number,
    cursor: Date | undefined,
  ): Promise<readonly PublishedRow[]> {
    const result = await this.db.execute(sql`
      select id, product_id, rating, body_th, author_display_name,
             content_erased_at, reply_th, replied_at, public_since
        from published_reviews
       where product_id = ${productId}
         ${cursor === undefined ? sql`` : sql`and public_since < ${cursor.toISOString()}`}
       order by public_since desc, id desc
       limit ${limit}
    `);

    return rowsOf(result).flatMap((row) => {
      const published = toPublished(row);
      return published === undefined ? [] : [published];
    });
  }

  /**
   * The numbers under the block — or nothing at all.
   *
   * `undefined` for a product with no counted review, because `product_review_stats` is a
   * `GROUP BY` and produces no row. That is the shape plan 9.5 asks for: the storefront's
   * "hide the whole block" is `if (!stats) return null`, which is the version that gets
   * written correctly by accident rather than the one that remembers not to print
   * "ยังไม่มีรีวิว" on 81 pages.
   */
  async productStats(productId: string): Promise<StatsRow | undefined> {
    const result = await this.db.execute(sql`
      select product_id, rating_count, rating_sum, visible_count,
             visible_with_text_count, newest_review_at
        from product_review_stats
       where product_id = ${productId}
    `);

    const row = rowsOf(result)[0];
    return row === undefined ? undefined : toStats(row);
  }

  /**
   * When a cached product page will change with nobody having written anything — plan 8.2's
   * trap 1, arriving from the direction plan 9.5 does not name.
   *
   * `withinHours` bounds the answer because the alternative is a scan of every pending review
   * with no reason to stop. `product_review_schedule` has a row only while something is
   * genuinely pending, so this costs nothing on the 81 products that have no reviews at all.
   */
  async publicationSchedule(withinHours: number): Promise<readonly ScheduleRow[]> {
    const result = await this.db.execute(sql`
      select product_id, next_publication_at, pending_count
        from product_review_schedule
       where next_publication_at <= now() + make_interval(hours => ${withinHours})
       order by next_publication_at asc
    `);

    return rowsOf(result).flatMap((row) => {
      const entry = toSchedule(row);
      return entry === undefined ? [] : [entry];
    });
  }

}

/* ------------------------------------------------------------------ *
 * Narrowing what `execute` returns
 * ------------------------------------------------------------------ */

function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return [];
  const { rows } = result as { rows: unknown };
  return Array.isArray(rows) ? rows : [];
}

function recordOf(row: unknown): Record<string, unknown> {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableStringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * `count(*)::bigint` arrives as a string from `pg`, because a bigint does not fit a JS
 * number and the driver refuses to guess. Parsed here rather than cast: these are counts of
 * reviews, which are small, and the parse is the place that says so out loud.
 */
function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function dateOf(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function nullableDateOf(value: unknown): Date | null {
  return dateOf(value) ?? null;
}

function toPublished(row: unknown): PublishedRow | undefined {
  const record = recordOf(row);
  const id = stringOf(record['id']);
  const productId = stringOf(record['product_id']);
  const publicSince = dateOf(record['public_since']);
  if (id === undefined || productId === undefined || publicSince === undefined) return undefined;

  return {
    id,
    productId,
    rating: countOf(record['rating']),
    bodyTh: nullableStringOf(record['body_th']),
    authorDisplayName: nullableStringOf(record['author_display_name']),
    contentErasedAt: nullableDateOf(record['content_erased_at']),
    replyTh: nullableStringOf(record['reply_th']),
    repliedAt: nullableDateOf(record['replied_at']),
    publicSince,
  };
}

function toStats(row: unknown): StatsRow | undefined {
  const record = recordOf(row);
  const productId = stringOf(record['product_id']);
  const newestReviewAt = dateOf(record['newest_review_at']);
  if (productId === undefined || newestReviewAt === undefined) return undefined;

  return {
    productId,
    ratingCount: countOf(record['rating_count']),
    ratingSum: countOf(record['rating_sum']),
    visibleCount: countOf(record['visible_count']),
    visibleWithTextCount: countOf(record['visible_with_text_count']),
    newestReviewAt,
  };
}

function toSchedule(row: unknown): ScheduleRow | undefined {
  const record = recordOf(row);
  const productId = stringOf(record['product_id']);
  const nextPublicationAt = dateOf(record['next_publication_at']);
  if (productId === undefined || nextPublicationAt === undefined) return undefined;

  return { productId, nextPublicationAt, pendingCount: countOf(record['pending_count']) };
}
