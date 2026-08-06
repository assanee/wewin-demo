import { Module, type DynamicModule } from '@nestjs/common';

import { parseReviewPhotoConfig, type ReviewPhotoConfig } from './review-photo.config';
import { ReviewPhotoStore } from './review-photo.store';
import { ReviewInvitationCheck } from './review-invitation';
import { ReviewRepository } from './review.repository';
import { ReviewsAdminController } from './reviews-admin.controller';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { REVIEW_PHOTO_CONFIG } from './reviews.tokens';

export interface ReviewsModuleOptions {
  /**
   * Omitted means this module parses `process.env` itself, exactly as `MediaModule` and
   * `SlipsModule` do — a bucket name and the credentials behind it have no business in the
   * frozen, logged `Env`.
   *
   * Nothing connects at construction, so a graph built with no object storage running still
   * boots and every route that does not touch a photograph still works.
   */
  readonly config?: ReviewPhotoConfig;
}

/**
 * Customer reviews after delivery — plan section 9.
 *
 * It imports nothing, on the same terms as `MediaModule` and `NotificationsModule`:
 * `DatabaseModule` is `@Global` so `DRIZZLE` is in scope, and `RbacModule` binds its guard
 * over the whole graph — so both controllers here are enforced and audited whether or not
 * this module knows either exists.
 *
 * Nothing is exported, and that is load-bearing rather than tidy. The catalogue must not be
 * able to import `ReviewsService` to "add the rating to the product document": a rating is a
 * number that changes when a customer writes something and when a moderation window elapses,
 * and a frozen published document is a thing that must never change. The one legitimate join
 * between the two is `product_review_stats`, which is a view, and the storefront reads it
 * through `GET /products/:productId/reviews`.
 *
 * ── ⚠️ NOT WIRED INTO `AppModule`, AND WHAT THAT COSTS ───────────────────────────
 *
 * `src/app.module.ts` is outside this round's ownership, so `ReviewsModule.forRoot()` is not
 * in its imports list. Until it is, this module is compiled, typechecked and tested but **not
 * served**: against the assembled application every route below is a 404.
 *
 * That is not a small caveat and it is not being minimised. Phase 5b and phase 5c each
 * shipped complete, tested modules that `AppModule` did not import, and each time it was the
 * single largest finding of the round — three modules whose every route was a 404 while their
 * suites were green, because a suite that boots its own graph proves the feature works and
 * proves nothing about whether anybody can reach it. This is the third occurrence, reported
 * rather than repeated silently.
 *
 * Three things must land together with that line, or the boot audit and the route table will
 * disagree with reality:
 *
 *   1. `AppModule.forRoot` gains `ReviewsModule.forRoot()`;
 *   2. `tests/admin/route-permissions.test.ts` gains the five `/admin/reviews/*` routes below
 *      — that table asserts in *both* directions, so a new `/admin/*` route it does not name
 *      fails it by design. That is the mechanism working, not the mechanism being in the way;
 *   3. `tests/orders/scope/cross-tenant-routes.pg.test.ts` — or a sibling — starts sweeping
 *      the review routes as the wrong customer. `tests/reviews/cross-tenant.pg.test.ts` does
 *      that against this module's own graph today, which is the exercise; the application-wide
 *      sweep is the alarm, and only the alarm catches a route added later without one.
 *
 *        GET  /admin/reviews/queue                 reviews.moderate
 *        POST /admin/reviews/:reviewId/hide        reviews.moderate
 *        POST /admin/reviews/:reviewId/unhide      reviews.moderate
 *        POST /admin/reviews/:reviewId/publish     reviews.moderate
 *        POST /admin/reviews/:reviewId/reply       reviews.moderate
 *
 * ── The invitation is a check and not a producer ─────────────────────────────────
 *
 * `ReviewInvitationCheck` reads `notification_rules` at boot and says whether plan 9.2's
 * invitation is actually running. It writes nothing — see `review-invitation.ts` for why the
 * one rule row it is looking for cannot ship from here without the template that renders it.
 */
@Module({})
export class ReviewsModule {
  static forRoot(options: ReviewsModuleOptions = {}): DynamicModule {
    const config = options.config ?? parseReviewPhotoConfig(process.env);

    return {
      module: ReviewsModule,
      controllers: [ReviewsController, ReviewsAdminController],
      providers: [
        { provide: REVIEW_PHOTO_CONFIG, useValue: config },
        ReviewPhotoStore,
        ReviewRepository,
        ReviewsService,
        ReviewInvitationCheck,
      ],
    };
  }
}
