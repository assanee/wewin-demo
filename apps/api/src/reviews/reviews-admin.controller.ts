import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  hideReviewRequestSchema,
  moderationQueueQuerySchema,
  replyToReviewRequestSchema,
  type HideReviewRequestWire,
  type ModeratedReviewWire,
  type ModerationQueueWire,
  type ReplyToReviewRequestWire,
} from '@wewin/contract/review';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../rbac';
import { ReviewsService } from './reviews.service';

/**
 * Moderation — plan 9.3, and the shape of the URL space is the argument.
 *
 *     GET  /admin/reviews/queue                    what is still inside its window
 *     POST /admin/reviews/:reviewId/hide           with a reason and a name
 *     POST /admin/reviews/:reviewId/unhide
 *     POST /admin/reviews/:reviewId/publish        early — the deadline needs no route
 *     POST /admin/reviews/:reviewId/reply          one per review; no threads
 *
 * ── ⭐ There is no `DELETE /admin/reviews/:id`, and its absence is the design ─────
 *
 * Plan 9.3 is the sentence the whole feature turns on: *the company may hide, never delete,
 * and the rating counts either way.* A delete route would be the polite option's effective
 * twin — and `reviews_guard_write()` refuses DELETE in Postgres, so writing one would produce
 * a 500 rather than a deletion. This codebase has settled delete-versus-flag twice already
 * (plan 7.15 item 1 for users, plan 7.9(ค) for quote lines); a third answer in the other
 * direction would make the first two arbitrary.
 *
 * ── And no route publishes the deadline ──────────────────────────────────────────
 *
 * `POST …/publish` is the *early* decision, taken by a person, recorded with their name
 * (`reviews_published_shape`). The deadline is not an action and has no route, no worker and
 * no job: `review_is_public()` starts answering true and the views start returning the row.
 * A `POST /admin/reviews/publish-due` endpoint would be the "reviews never appear" failure
 * with an owner — somebody would have to remember to call it.
 *
 * ── One permission, and it is not an order permission ────────────────────────────
 *
 * `reviews.moderate`, held by nobody at boot for the same reason `quotes.approve` and
 * `users.erase` are: `permission-sync.service.ts` inserts the code so a grant has something
 * to reference, and who holds it is plan 13's unanswered *"บริษัทมีคนตรวจสลิป/อนุมัติกี่คนจริงๆ"*.
 * Until the owner grants it, moderation is refused for want of a permission — which is the
 * fail-closed direction, and which the moderation *deadline* makes safe rather than fatal:
 * with nobody holding the permission, reviews publish themselves after three days, which is
 * precisely what plan 9.3 says should happen when nobody acts.
 *
 * It is deliberately not `orders.read`. A clerk who may look at every order in the company
 * has no business hiding a customer's published opinion, and plan 9.3 spends three separate
 * mechanisms making hiding expensive.
 */

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

@Controller('admin/reviews')
export class ReviewsAdminController {
  constructor(private readonly reviews: ReviewsService) {}

  /**
   * The queue, soonest deadline first.
   *
   * ⚠️ Ordered by `publishes_at` and not by `created_at`, and `total` is beside the page. The
   * two are the same request: plan 7.12 records a refund queue that never drains because
   * nobody could see it growing, and plan 9.3 says an approve-before-publish queue with no SLA
   * is one where reviews never appear. This queue has both an SLA and a visible length, and a
   * moderator who ignores it does not build a backlog — the reviews publish themselves, which
   * is the intended behaviour and not a failure.
   */
  @Get('queue')
  @RequirePermissions('reviews.moderate')
  @contractVersion()
  @privateToTheCaller()
  async queue(@CurrentScope() scope: Scope, @Query() query: unknown): Promise<ModerationQueueWire> {
    const parsed = moderationQueueQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw AppError.badRequest('พารามิเตอร์ไม่ถูกต้อง');

    return this.reviews.moderationQueue(scope, parsed.data.limit, parsed.data.offset, parsed.data.state);
  }

  /**
   * Hide it — plan 9.3's reason and person.
   *
   * The person is the session's, never the body's. A moderator naming somebody else in the
   * `hidden_by_user_id` column is the exact failure the "recorded person" requirement exists
   * to prevent, and the only way to make that unrepresentable is to leave it off the wire.
   */
  @Post(':reviewId/hide')
  @RequirePermissions('reviews.moderate')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  async hide(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
    @Body(new ZodBodyPipe(hideReviewRequestSchema)) body: HideReviewRequestWire,
  ): Promise<ModeratedReviewWire> {
    return this.reviews.hide(scope, reviewId, body.reason, body.noteTh);
  }

  /**
   * Un-hide it.
   *
   * ⚠️ **This leaves no history.** `reviews_hidden_shape` makes the three columns one fact, so
   * clearing the hiding clears the reason and the name with it: a review hidden and restored
   * is indistinguishable from one that was never touched. Stated on the route as well as in
   * the service and the schema, because this is where somebody looking for an audit trail will
   * arrive. A `review_moderation_events` child table is the answer if it ever matters.
   */
  @Post(':reviewId/unhide')
  @RequirePermissions('reviews.moderate')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  async unhide(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
  ): Promise<ModeratedReviewWire> {
    return this.reviews.unhide(scope, reviewId);
  }

  /** Publish early. The deadline publishes on its own and has no route — see the class comment. */
  @Post(':reviewId/publish')
  @RequirePermissions('reviews.moderate')
  @HttpCode(200)
  @contractVersion()
  @privateToTheCaller()
  async publish(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
  ): Promise<ModeratedReviewWire> {
    return this.reviews.publish(scope, reviewId);
  }

  /**
   * The company's one reply — plan 9.3, *"one reply per review; no threads"*.
   *
   * `POST` and not `PUT`: it is a create, and it can only happen once. A `PUT` would say the
   * resource is replaceable, and a client that believed it would silently rewrite an answer a
   * customer has already read.
   */
  @Post(':reviewId/reply')
  @RequirePermissions('reviews.moderate')
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  async reply(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
    @Body(new ZodBodyPipe(replyToReviewRequestSchema)) body: ReplyToReviewRequestWire,
  ): Promise<ModeratedReviewWire> {
    return this.reviews.reply(scope, reviewId, body.bodyTh);
  }
}
