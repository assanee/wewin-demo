import { Injectable, Logger } from '@nestjs/common';
import { REVIEW_MODERATION_HOURS_DEFAULT } from '@wewin/db/schema';
import type { ReviewHiddenReason } from '@wewin/db/schema';
import type {
  ModeratedReviewWire,
  ModerationQueueWire,
  OwnReviewWire,
  ProductReviewScheduleWire,
  ProductReviewsWire,
  PublishedReviewWire,
  ReviewPhotoUploadResultWire,
  ReviewPhotoWire,
  ReviewableLineListWire,
  WriteReviewRequestWire,
} from '@wewin/contract/review';
import { REVIEW_PHOTO_MAX_COUNT } from '@wewin/contract/review';

import { AppError } from '../common/errors/app-error';
import type { Scope } from '../rbac';
import { PhotoRejected, prepareReviewPhoto } from './review-photo.pipeline';
import { ReviewPhotoStore } from './review-photo.store';
import { reviewerReach, type ReviewReach } from './review-reach';
import {
  ReviewRepository,
  type OwnedLine,
  type PhotoRow,
  type ReviewRow,
} from './review.repository';
import { translateReviewError } from './pg-errors';

/**
 * Writing, moderating and reading reviews.
 *
 * ── Where authorisation is, and where it is not ─────────────────────────────────
 *
 * There is no `if (review.authorUserId !== scope.userId)` anywhere in this file, and there is
 * no place one could go. Every load takes a `ReviewReach`, the reach becomes a term in the
 * WHERE clause, and a row the caller could not reach never arrives — plan 7.4 trap 2, which
 * this codebase has been bitten by once. What this file decides is everything *else*: whether
 * the order has been delivered, whether the line still exists, whether the review already
 * exists, and what to say when it does.
 *
 * ── Missing and forbidden are the same answer, except where they are not ────────
 *
 * `ScopedOrderRepository` collapses "no such order" and "not yours" into one 404, because two
 * status codes are an oracle for counting the company's orders. The same reasoning applies to
 * a review id and a photo id, and this file does the same.
 *
 * It deliberately does **not** apply to the *state* of a row the caller already owns. A
 * customer asking to review their own undelivered line gets "this order has not been
 * delivered yet" and not a 404 — the ownership term already ran, so there is nobody on the
 * other side of that sentence who did not already know it. Collapsing that into a 404 would
 * be politeness toward an attacker who cannot reach the row, paid for by a customer who
 * cannot understand the answer.
 *
 * ── The three deadline reads that are not in this file ──────────────────────────
 *
 * Nothing here computes whether a review is published. `review_is_public()` is a Postgres
 * function, the two views call it, the repository selects it, and this file reads a boolean.
 * A TypeScript reimplementation would be a second definition of "published" evaluated against
 * a different clock — the failure plan 7.13 opens with, and here it would show as a page
 * rendering a review the API calls pending.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger('ReviewsService');

  constructor(
    private readonly repository: ReviewRepository,
    private readonly photos: ReviewPhotoStore,
  ) {}

  /* ---------------------------------------------------------------- *
   * The customer
   * ---------------------------------------------------------------- */

  /**
   * Every delivered line this caller could review — what an invitation link lands on.
   *
   * Returns an empty list rather than a 403 for a caller with no referent: `reviewerReach`
   * gives them `none`, `authorFilter` compiles that to `false`, and the query returns
   * nothing. There is no branch here for "not allowed", because the query already answered.
   */
  async reviewableLines(scope: Scope): Promise<ReviewableLineListWire> {
    const reach = reviewerReach(scope, 'write');
    const lines = await this.repository.listReviewableLines(reach, 100);

    return {
      items: lines.flatMap((line) =>
        line.productVersionId === null || line.productId === null || line.productNameTh === null
          ? []
          : [
              {
                quoteLineId: line.quoteLineId,
                orderId: line.orderId,
                orderNo: line.orderNo,
                productId: line.productId,
                productVersionId: line.productVersionId,
                productNameTh: line.productNameTh,
                deliveredAt: line.deliveredAt.toISOString(),
                reviewId: line.reviewId,
              },
            ],
      ),
    };
  }

  /**
   * Write the review — plan 9.1, and every fact about it comes from the line.
   *
   * The request carries a rating, some prose and a name. It does **not** carry an order id, a
   * product id or a product version id, and it could not: those come from the row the
   * ownership-filtered query returned. That is what makes "the purchase is provable" true
   * without a verified-buyer table — there is nothing on the wire to forge.
   */
  async write(scope: Scope, request: WriteReviewRequestWire): Promise<OwnReviewWire> {
    const reach = reviewerReach(scope, 'write');
    const line = await this.requireOwnedLine(reach, request.quoteLineId);

    /*
     * ⭐ The window opens at `delivered` and never closes — plan 9.2. Aluminium is judged
     * after a rainy season, so nothing here expires; `delivered` is terminal, so the guard
     * that opens the window can never be the thing that shuts it.
     */
    if (line.orderStatus !== 'delivered') {
      throw AppError.conflict('รีวิวได้เมื่อคำสั่งซื้อถูกส่งมอบแล้วเท่านั้น', {
        reason: 'order-not-delivered',
        status: line.orderStatus,
      });
    }

    if (line.removedAt !== null) {
      throw AppError.conflict(
        'รายการนี้ถูกนำออกจากคำสั่งซื้อระหว่างการแก้แบบ จึงไม่มีสินค้าที่ส่งมอบให้รีวิว',
        { reason: 'line-removed-in-redesign' },
      );
    }

    /*
     * A `freeform` line has no `product_version_id`, so the composite foreign key has nothing
     * to match and the insert would fail — see `reviews_line_version_fk`. Caught here so a
     * customer trying to review a delivery charge is told what it is rather than shown a
     * constraint name.
     */
    if (line.productVersionId === null) {
      throw AppError.conflict(
        'รายการนี้ไม่ใช่สินค้าในแคตตาล็อก จึงรีวิวไม่ได้ (เช่น ค่าขนส่งหรือค่าบริการ)',
        { reason: 'freeform-line-is-not-reviewable' },
      );
    }

    if (line.reviewId !== null) {
      throw AppError.conflict('รายการนี้ถูกรีวิวไปแล้ว — หนึ่งรายการต่อหนึ่งรีวิว', {
        reason: 'one-review-per-line',
        reviewId: line.reviewId,
      });
    }

    const row = await this.write2(reach, line, request);
    return this.toOwnReview(row, []);
  }

  /**
   * A review the caller wrote, with its photographs and its deadline.
   *
   * Reachable while it is still pending, which is the point: the honest answer to "where is
   * my review?" is a date, and `publishesAt` is it.
   */
  async ownReview(scope: Scope, reviewId: string): Promise<OwnReviewWire> {
    const reach = reviewerReach(scope, 'write');
    const row = await this.repository.findReview(reach, reviewId);
    if (row === undefined) throw notFound();

    const photos = await this.repository.listPhotos([row.id]);
    return this.toOwnReview(row, photos.get(row.id) ?? []);
  }

  /* ---------------------------------------------------------------- *
   * Photographs — plan 9.4
   * ---------------------------------------------------------------- */

  /**
   * Strip, verify, store, record. In that order, and the order is the safety property.
   *
   * ⓵ **`prepareReviewPhoto` runs before anything is written anywhere.** It strips the
   *    metadata and then checks its own work three ways (see `review-photo.pipeline.ts`). A
   *    file that fails verification never reaches the bucket, so there is no window in which
   *    a customer's coordinates exist in object storage and a later step is supposed to
   *    clean up.
   *
   * ⓶ **The object is written before the row**, on `MediaService.upload`'s reasoning: a
   *    crash between them leaves bytes nobody references, which is a reconciliation job,
   *    while the reverse leaves a row pointing at nothing, which is a broken image on a
   *    published page with no undo. Here the trade is sharper in one direction — an orphaned
   *    object is a *photograph of somebody's house with no row to erase it by* — so the key
   *    is logged at warn when the insert fails, which is the only way a sweep can find it.
   *
   * ⓷ **The row is inserted inside a transaction that first locks the review**, so two
   *    uploads racing for `seq` serialise rather than collide on
   *    `review_photos_review_seq_key`.
   *
   * The photo count ceiling is checked here and nowhere else — it is a product decision with
   * no constraint behind it, and it is said so rather than implied.
   */
  async uploadPhoto(scope: Scope, reviewId: string, bytes: Buffer): Promise<ReviewPhotoUploadResultWire> {
    const reach = reviewerReach(scope, 'write');
    const review = await this.repository.findReview(reach, reviewId);
    if (review === undefined) throw notFound();

    const existing = (await this.repository.listPhotos([review.id])).get(review.id) ?? [];
    if (existing.length >= REVIEW_PHOTO_MAX_COUNT) {
      throw AppError.conflict(`แนบรูปได้สูงสุด ${String(REVIEW_PHOTO_MAX_COUNT)} รูปต่อหนึ่งรีวิว`, {
        reason: 'too-many-photos',
        max: REVIEW_PHOTO_MAX_COUNT,
      });
    }

    const prepared = photoRejectionToAppError(() => prepareReviewPhoto(bytes), this.logger);
    const key = this.photos.keyFor(review.id, prepared.extension);

    await this.photos.put(key, prepared.bytes, prepared.contentType);

    const row = await (async (): Promise<PhotoRow> => {
      try {
        return await this.repository.transaction(async (tx) => {
          const seq = await this.repository.nextPhotoSeq(tx, review.id);
          const inserted = await this.repository.insertPhoto(tx, seq, {
            reviewId: review.id,
            storageKey: key,
            contentType: prepared.contentType,
            byteSize: BigInt(prepared.bytes.byteLength),
            width: prepared.width,
            height: prepared.height,
            checksumSha256: prepared.checksumSha256,
            sourceChecksumSha256: prepared.sourceChecksumSha256,
            stripRecipe: prepared.stripRecipe,
            altTextTh: null,
          });
          if (inserted === undefined) throw notFound();
          return inserted;
        });
      } catch (error) {
        /*
         * The bytes are in the bucket and no row names them. Logged with the key because
         * that is the only handle a sweep will ever have — and a photograph of somebody's
         * house that no row can erase is the worst orphan this system can produce.
         */
        this.logger.warn(`Stored ${key} but its row was not written; it is now unreferenced`);
        throw translateReviewError(error);
      }
    })();

    /*
     * Logged as well as returned, on `MediaService`'s reasoning with a sharper edge: plan 9.4
     * is a promise about every file that goes through here, and a promise nobody can audit
     * after the fact is a slogan. `stripped` empty is not suspicious on its own — it means
     * the file carried nothing — but it is worth being able to count.
     */
    this.logger.log(
      `Review photo ${row.id} stored (${prepared.contentType}, recipe ${prepared.stripRecipe})` +
        (prepared.stripped.length > 0 ? ` after removing: ${prepared.stripped.join(', ')}` : ''),
    );

    return {
      photo: toPhotoWire(row),
      stripped: prepared.stripped,
      verified: prepared.verified,
      stripRecipe: prepared.stripRecipe,
    };
  }

  /**
   * Delete the photograph. The rating survives — plan 9.4(2).
   *
   * The row goes first and the object second, `MediaService.delete`'s ordering: a crash
   * between them leaves bytes nobody references, and the reverse would leave, for the length
   * of one failed statement, a row pointing at an object that is gone.
   *
   * This is the only DELETE in the feature, and `review_photos_guard_write()` is what makes
   * it the only one — the same trigger refuses DELETE on `reviews` outright.
   */
  async deletePhoto(scope: Scope, photoId: string): Promise<void> {
    const reach = reviewerReach(scope, 'write');
    const row = await this.repository.deletePhoto(reach, photoId);
    if (row === undefined) throw notFound();

    if (row.storageKey !== null) await this.photos.forget(row.storageKey);
  }

  /**
   * The bytes, for the serving route.
   *
   * ⚠️ **Publication is the access rule, and it is read from the same function the views
   * use.** A photograph attached to a review that is still inside its moderation window is
   * not public — the whole point of the window is that nobody has looked at it yet — so it is
   * served to a moderator and to nobody else. Once the review is public the photograph is
   * public, because the customer published it.
   *
   * A hidden review's photographs are not served. That is not the same decision as the rating
   * (which keeps counting, plan 9.3): the rating is a number with nobody in it, and a
   * photograph is a picture of somebody's house that a moderator has just decided should not
   * be on the page.
   */
  async photoBytes(
    scope: Scope,
    photoId: string,
  ): Promise<{ readonly photo: PhotoRow; readonly body: AsyncIterable<Uint8Array>; readonly contentType: string }> {
    const found = await this.repository.findPhotoForServing(photoId);
    if (found === undefined) throw notFound();

    const moderator = reviewerReach(scope, 'moderate').kind === 'all';
    if (!found.isPublic && !moderator) throw notFound();

    if (found.photo.storageKey === null) {
      /*
       * The bytes were removed by an erasure or a retention sweep and the row stayed, saying
       * a photograph existed. 410 and not 404: the difference is "there was one and it is
       * gone" versus "there never was", and only the first is true.
       */
      throw new AppError('NOT_FOUND', 410, 'รูปนี้ถูกลบออกจากระบบแล้ว', { reason: 'bytes-erased' });
    }

    const object = await this.photos.open(found.photo.storageKey);
    return { photo: found.photo, body: object.body, contentType: found.photo.contentType };
  }

  /* ---------------------------------------------------------------- *
   * Moderation — plan 9.3
   * ---------------------------------------------------------------- */

  /**
   * What is still inside its window, soonest deadline first.
   *
   * The queue contains only reviews nobody has acted on **and** whose window has not elapsed.
   * A review that published itself is not in it and cannot be put back — which is the SLA
   * working, and is exactly the property that makes this queue different from the refund
   * queue plan 7.12 records as never draining. A moderator who ignores this queue does not
   * accumulate a backlog; they lose the ability to have acted.
   */
  async moderationQueue(
    scope: Scope,
    limit: number,
    offset: number,
    state: 'pending' | 'hidden' = 'pending',
  ): Promise<ModerationQueueWire> {
    const reach = this.requireModerator(scope);
    const { items, total } = await this.repository.moderationQueue(reach, limit, offset, state);
    const photos = await this.repository.listPhotos(items.map((item) => item.id));
    const now = Date.now();

    return {
      total,
      items: items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        orderNo: item.orderNo,
        productId: item.productId,
        productNameTh: item.productNameTh,
        rating: item.rating,
        bodyTh: item.bodyTh,
        authorDisplayName: item.authorDisplayName,
        createdAt: item.createdAt.toISOString(),
        publishesAt: item.publishesAt.toISOString(),
        /*
         * Computed here and not in SQL, and it is the one time-derived number in this file
         * that may be: it is a *display* value on a row whose authoritative deadline
         * (`publishesAt`) is already on the wire beside it. A client that disagrees with this
         * figure by a second renders a different countdown; a client that disagreed with
         * `publishesAt` would render a different SLA.
         */
        hoursRemaining: Math.max(0, Math.round(((item.publishesAt.getTime() - now) / 3_600_000) * 10) / 10),
        photos: (photos.get(item.id) ?? []).map(toPhotoWire),
      })),
    };
  }

  /**
   * Hide it — with a reason and a name on it. Plan 9.3.
   *
   * The rating goes on counting, and that is not this method's doing: `product_review_stats`
   * does not filter on `hidden_at`, and `reviews_guard_write()` freezes the rating once the
   * review is moderated so the moderator who hides a two-star review cannot also make it a
   * five. This method's contribution is that all three columns are written in one statement,
   * so a hidden review with nobody attached is not a state that exists.
   */
  async hide(
    scope: Scope,
    reviewId: string,
    reason: ReviewHiddenReason,
    noteTh: string | null,
  ): Promise<ModeratedReviewWire> {
    const { reach, userId } = this.requireModeratorUser(scope);

    return this.moderate(reach, reviewId, async (tx, review) => {
      if (review.hiddenAt !== null) {
        throw AppError.conflict('รีวิวนี้ถูกซ่อนอยู่แล้ว', { reason: 'already-hidden' });
      }
      return this.repository.hide(tx, review.id, userId, reason, noteTh);
    });
  }

  /**
   * Un-hide it.
   *
   * ⚠️ The reason and the person who hid it are cleared with it, because
   * `reviews_hidden_shape` makes the three columns one fact. **The table records current
   * moderation state and not its churn**, so this destroys the record that the review was
   * ever hidden. Stated in three places now — schema, repository, here — because this is the
   * method a reviewer of the audit trail will look for and not find.
   */
  async unhide(scope: Scope, reviewId: string): Promise<ModeratedReviewWire> {
    const reach = this.requireModerator(scope);

    return this.moderate(reach, reviewId, async (tx, review) => {
      if (review.hiddenAt === null) {
        throw AppError.conflict('รีวิวนี้ไม่ได้ถูกซ่อนอยู่', { reason: 'not-hidden' });
      }
      return this.repository.unhide(tx, review.id);
    });
  }

  /**
   * Publish it now rather than waiting for the window to elapse.
   *
   * ⚠️ **This is the only publication that is an action.** The other one — the deadline —
   * has no writer, no worker and no row change: `review_is_public()` starts answering true
   * and the views start returning the row. So a review that has already gone public by
   * elapsing cannot be "published", and this refuses rather than stamping a decision onto
   * something nobody decided.
   */
  async publish(scope: Scope, reviewId: string): Promise<ModeratedReviewWire> {
    const { reach, userId } = this.requireModeratorUser(scope);

    return this.moderate(reach, reviewId, async (tx, review) => {
      if (review.publishedAt !== null) {
        throw AppError.conflict('รีวิวนี้ถูกเผยแพร่ไปแล้ว', { reason: 'already-published' });
      }
      if (review.isPublic) {
        throw AppError.conflict(
          'รีวิวนี้ขึ้นเองแล้วเมื่อครบกำหนดกลั่นกรอง — ไม่มีอะไรให้กดเผยแพร่',
          { reason: 'published-by-the-deadline', publishesAt: review.publishesAt.toISOString() },
        );
      }
      return this.repository.publish(tx, review.id, userId);
    });
  }

  /**
   * The company's one reply — plan 9.3, *"one reply per review; no threads"*.
   *
   * Enforced by the row's shape rather than by this check: three columns on `reviews` can
   * hold one reply, so "no threads" needs no unique index and no count. The check here is
   * for the message; the `reply_th is null` term in the repository's WHERE clause is what
   * makes two salespeople answering at the same instant produce one reply.
   */
  async reply(scope: Scope, reviewId: string, bodyTh: string): Promise<ModeratedReviewWire> {
    const { reach, userId } = this.requireModeratorUser(scope);

    return this.moderate(reach, reviewId, async (tx, review) => {
      if (review.replyTh !== null) {
        throw AppError.conflict('รีวิวนี้ถูกตอบกลับไปแล้ว — ตอบได้หนึ่งครั้งต่อหนึ่งรีวิว', {
          reason: 'one-reply-per-review',
        });
      }
      const replied = await this.repository.reply(tx, review.id, userId, bodyTh);
      if (replied === undefined) {
        /* Lost the race with another salesperson between the lock and the UPDATE. */
        throw AppError.conflict('รีวิวนี้ถูกตอบกลับไปแล้ว — ตอบได้หนึ่งครั้งต่อหนึ่งรีวิว', {
          reason: 'one-reply-per-review',
        });
      }
      return replied;
    });
  }

  /* ---------------------------------------------------------------- *
   * The storefront — plan 9.5
   * ---------------------------------------------------------------- */

  /**
   * A product's review block, or the absence of one.
   *
   * `stats: null` when nothing has been moderated, because `product_review_stats` produces no
   * row for a product with nothing to say. That is the whole of plan 9.5's last paragraph:
   * with 81 products and no orders, "ยังไม่มีรีวิว" on 81 pages is worse than silence, and
   * `if (!stats) return null` is the rendering that happens by accident.
   *
   * There is no `average` on the wire and there is none in the view. A caller who wants one
   * divides, and to divide it must be holding the count.
   */
  async productReviews(
    productId: string,
    limit: number,
    cursor: Date | undefined,
  ): Promise<ProductReviewsWire> {
    const [stats, rows] = await Promise.all([
      this.repository.productStats(productId),
      this.repository.publishedReviews(productId, limit + 1, cursor),
    ]);

    const page = rows.slice(0, limit);
    const photos = await this.repository.listPhotos(page.map((row) => row.id));
    const last = page.at(-1);

    const items: PublishedReviewWire[] = page.map((row) => ({
      id: row.id,
      productId: row.productId,
      rating: row.rating,
      bodyTh: row.bodyTh,
      authorDisplayName: row.authorDisplayName,
      contentErased: row.contentErasedAt !== null,
      replyTh: row.replyTh,
      repliedAt: row.repliedAt === null ? null : row.repliedAt.toISOString(),
      publicSince: row.publicSince.toISOString(),
      photos: (photos.get(row.id) ?? []).map(toPhotoWire),
    }));

    return {
      productId,
      stats:
        stats === undefined
          ? null
          : {
              productId: stats.productId,
              ratingCount: stats.ratingCount,
              ratingSum: stats.ratingSum,
              visibleCount: stats.visibleCount,
              visibleWithTextCount: stats.visibleWithTextCount,
              newestReviewAt: stats.newestReviewAt.toISOString(),
            },
      items,
      nextCursor: rows.length > limit && last !== undefined ? last.publicSince.toISOString() : null,
    };
  }

  /**
   * When a cached product page will change with nobody having written anything.
   *
   * ⭐ This is the answer to the cache trap plan 8.2 does not name. Every other writer in
   * this system is a request: the dashboard publishes a version and calls `revalidateTag`,
   * the API accepts a review and calls it. **A review that publishes itself has no writer** —
   * no request, no row update, no transaction at that moment to hang the call on — and
   * `apps/web` runs `revalidate = false`, so the page stands until something asks it not to.
   *
   * This endpoint is what lets the storefront *schedule* a revalidation rather than discover
   * the drift. It does not make the revalidation happen, and saying so is the point: a view
   * nobody reads is a fact nobody has.
   */
  async publicationSchedule(withinHours: number): Promise<ProductReviewScheduleWire> {
    const entries = await this.repository.publicationSchedule(withinHours);
    return {
      asOf: new Date().toISOString(),
      entries: entries.map((entry) => ({
        productId: entry.productId,
        nextPublicationAt: entry.nextPublicationAt.toISOString(),
        pendingCount: entry.pendingCount,
      })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Shared
   * ---------------------------------------------------------------- */

  private async requireOwnedLine(reach: ReviewReach, quoteLineId: string): Promise<OwnedLine> {
    const line = await this.repository.findOwnedLine(reach, quoteLineId);
    if (line === undefined) throw notFound();
    return line;
  }

  private async write2(
    reach: ReviewReach,
    line: OwnedLine,
    request: WriteReviewRequestWire,
  ): Promise<ReviewRow> {
    if (line.productVersionId === null) throw notFound();

    try {
      const row = await this.repository.insertReview(reach, {
        orderId: line.orderId,
        quoteLineId: line.quoteLineId,
        productVersionId: line.productVersionId,
        rating: request.rating,
        bodyTh: request.bodyTh,
        authorDisplayName: request.authorDisplayName,
        /*
         * ⚠️ Passed on every insert rather than inherited from a column default — plan 13's
         * three days, in hours, marked in the schema as a default and not an answer.
         * `reviews.moderation_window_hours` is NOT NULL with no DDL default precisely so that
         * the number travels through a layer that had to think about it.
         */
        moderationWindowHours: REVIEW_MODERATION_HOURS_DEFAULT,
      });
      if (row === undefined) throw notFound();
      return row;
    } catch (error) {
      throw translateReviewError(error);
    }
  }

  /**
   * The moderator's write path: lock, decide, write, read back — in one transaction.
   *
   * The lock is what makes the "already hidden" / "already replied" checks mean anything.
   * Without it two moderators read the same row, both see `hidden_at IS NULL`, and the second
   * UPDATE silently replaces the first one's reason and name with their own.
   */
  private async moderate(
    reach: ReviewReach,
    reviewId: string,
    act: (
      tx: Parameters<Parameters<ReviewRepository['transaction']>[0]>[0],
      review: ReviewRow,
    ) => Promise<ReviewRow | undefined>,
  ): Promise<ModeratedReviewWire> {
    const row = await (async (): Promise<ReviewRow> => {
      try {
        return await this.repository.transaction(async (tx) => {
          const review = await this.repository.lockReview(tx, reach, reviewId);
          if (review === undefined) throw notFound();

          const updated = await act(tx, review);
          if (updated === undefined) throw notFound();
          return updated;
        });
      } catch (error) {
        throw translateReviewError(error);
      }
    })();

    const photos = await this.repository.listPhotos([row.id]);

    return {
      id: row.id,
      rating: row.rating,
      bodyTh: row.bodyTh,
      authorDisplayName: row.authorDisplayName,
      createdAt: row.createdAt.toISOString(),
      publishesAt: row.publishesAt.toISOString(),
      isPublic: row.isPublic,
      publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
      hiddenAt: row.hiddenAt === null ? null : row.hiddenAt.toISOString(),
      hiddenReason: row.hiddenReason,
      hiddenNoteTh: row.hiddenNoteTh,
      replyTh: row.replyTh,
      repliedAt: row.repliedAt === null ? null : row.repliedAt.toISOString(),
      photos: (photos.get(row.id) ?? []).map(toPhotoWire),
    };
  }

  /**
   * A moderator's reach, or a refusal.
   *
   * The route guard already demands `reviews.moderate`, so this is the second lock — the one
   * that still holds if a route is ever declared wrongly. It throws rather than returning an
   * empty reach because a moderation *action* with no reach would be a silent no-op, and the
   * failure mode of a silent no-op is a moderator who believes they hid something.
   */
  private requireModerator(scope: Scope): ReviewReach {
    const reach = reviewerReach(scope, 'moderate');
    if (reach.kind !== 'all') {
      throw new AppError('FORBIDDEN', 403, 'ต้องมีสิทธิ์กลั่นกรองรีวิวจึงจะทำรายการนี้ได้');
    }
    return reach;
  }

  /**
   * The same, plus the user id the action has to be recorded against.
   *
   * Plan 9.3: hiding takes a person. `hidden_by_user_id` is NOT NULL whenever `hidden_at` is,
   * so an action by a scope with no user — the `system` scope, which `reviewerReach` does
   * widen to `all` for reads — has nowhere to write the name. Refused here rather than
   * arriving as a CHECK violation, and refused *by shape*: there is no fallback user id and
   * no "system" sentinel, because a hiding attributed to the process is a hiding with nobody
   * accountable for it.
   */
  private requireModeratorUser(scope: Scope): { readonly reach: ReviewReach; readonly userId: string } {
    const reach = this.requireModerator(scope);
    if (scope.kind !== 'user') {
      throw new AppError('FORBIDDEN', 403, 'การกลั่นกรองต้องบันทึกชื่อผู้กด จึงต้องทำโดยผู้ใช้ที่ลงชื่อเข้าใช้');
    }
    return { reach, userId: scope.userId };
  }

  private toOwnReview(row: ReviewRow, photos: readonly PhotoRow[]): OwnReviewWire {
    return {
      id: row.id,
      quoteLineId: row.quoteLineId,
      orderId: row.orderId,
      rating: row.rating,
      bodyTh: row.bodyTh,
      authorDisplayName: row.authorDisplayName,
      createdAt: row.createdAt.toISOString(),
      publishesAt: row.publishesAt.toISOString(),
      isPublic: row.isPublic,
      isHidden: row.hiddenAt !== null,
      photos: photos.map(toPhotoWire),
    };
  }
}

/** The path the serving route lives at. One definition, so a client and this file agree. */
export function reviewPhotoPath(photoId: string): string {
  return `/reviews/photos/${photoId}`;
}

function toPhotoWire(row: PhotoRow): ReviewPhotoWire {
  return {
    id: row.id,
    /*
     * Null when the bytes are gone. A client renders the gap rather than a broken image, and
     * "a photograph existed and was removed" stays a fact the wire can express — the same
     * split `payment_slips.storage_key_erased_at` makes for a slip image.
     */
    path: row.storageKey === null ? null : reviewPhotoPath(row.id),
    width: row.width,
    height: row.height,
    altTextTh: row.altTextTh,
  };
}

/**
 * The same 404 for every reason a row was not returned.
 *
 * Thai, because it reaches a customer, and deliberately not "or you may not see it": a
 * message that distinguishes the two cases is the same oracle as two status codes.
 */
function notFound(): AppError {
  return AppError.notFound('ไม่พบรีวิวหรือรายการนี้');
}

/**
 * A photograph this API will not store.
 *
 * 415 for the file's fault — the request was well-formed and the *media type* was wrong,
 * which is what 415 means and is a distinction a client can act on ("convert the file" rather
 * than "fix the form"). `strip-not-verified` is 500, because it is not the file's fault: the
 * pipeline failed its own check, the customer can do nothing about it, and it must page
 * somebody rather than teaching a support agent to say "ask them to try a different photo".
 */
function photoRejectionToAppError<T>(run: () => T, logger: Logger): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PhotoRejected) {
      if (error.reason === 'strip-not-verified') {
        logger.error(`📍 EXIF stripping failed verification and the photo was refused: ${error.message}`);
        throw new AppError('INTERNAL', 500, error.messageTh, { reason: error.reason });
      }
      throw new AppError('BAD_REQUEST', 415, error.messageTh, { reason: error.reason });
    }
    throw error;
  }
}
