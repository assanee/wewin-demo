import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';
import {
  publishedReviewsQuerySchema,
  reviewScheduleQuerySchema,
  writeReviewRequestSchema,
  type OwnReviewWire,
  type ProductReviewScheduleWire,
  type ProductReviewsWire,
  type ReviewPhotoUploadResultWire,
  type ReviewableLineListWire,
  type WriteReviewRequestWire,
} from '@wewin/contract/review';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { readBoundedBody } from '../media/read-body';
import {
  AllowAnonymous,
  CurrentScope,
  RequirePermissions,
  RequirePrincipal,
  type Scope,
} from '../rbac';
import { ReviewPhotoStore } from './review-photo.store';
import { ReviewsService } from './reviews.service';

/**
 * Reviews over HTTP — the customer's half and the storefront's.
 *
 *     GET    /reviews/reviewable-lines            what you may review, and what you already did
 *     POST   /reviews                             write one
 *     GET    /reviews/:reviewId                   your own, including while it is pending
 *     POST   /reviews/:reviewId/photos            attach a photograph
 *     DELETE /reviews/photos/:photoId             remove one; the rating survives
 *     GET    /reviews/photos/:photoId             the bytes
 *     GET    /products/:productId/reviews         the storefront's read
 *     GET    /reviews/schedule                    when a cached page changes with no writer
 *
 * ── Why the policies are what they are ───────────────────────────────────────────
 *
 * The write routes are `RequirePrincipal`, not `RequireAuthenticated`. Plan section 6: the
 * anonymous funnel is the main funnel, an order can be submitted by a guest, and a guest who
 * bought a window is exactly the customer whose review proves the most. `RequireAuthenticated`
 * here would mean the people who buy the most windows are the ones who cannot review them.
 *
 * ⚠️ The consequence is written down rather than discovered: **a guest's review has no
 * `author_user_id`, so `erase_user()` cannot see it.** Same blindness plan 7.16 records for
 * guest orders, arriving at a third address, and `tests/reviews/erasure.pg.test.ts` asserts
 * it so that a future change to the unit of erasure has to come back and say so.
 *
 * Which rows a principal reaches is not a question a guard can answer — it has never read the
 * row — so it is answered in the query, by `review-reach.ts` and `review.repository.ts`.
 *
 * ── Two anonymous routes, and they are different kinds of anonymous ──────────────
 *
 * `GET /products/:productId/reviews` is the storefront funnel, exactly like
 * `GET /catalog/products`: a product page must render for a visitor who has never signed in.
 * It reads `published_reviews`, whose WHERE clause is `review_is_public(r)` and whose
 * projection omits both author columns — so there is nothing here to leak even if somebody
 * adds a join later.
 *
 * `GET /reviews/photos/:photoId` is anonymous for the same reason and is **not** an open
 * door: the service refuses any photograph whose review is not public unless the caller holds
 * `reviews.moderate`. A pending review's photograph is one nobody has looked at yet, which is
 * the entire point of the window.
 */

const pipe = promisify(pipeline);

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Never stored by anything between here and the browser.
 *
 * The customer routes are scoped to one principal, and two of the three ways a caller
 * identifies themselves — the guest cookie and the session cookie — are exactly what a shared
 * cache is entitled to ignore when deciding two requests are the same. A cached review list is
 * somebody else's list served to the next person through the proxy.
 */
const privateToTheCaller = (): MethodDecorator => Header('Cache-Control', 'no-store');

@Controller()
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly photos: ReviewPhotoStore,
  ) {}

  /* ---------------------------------------------------------------- *
   * The customer
   * ---------------------------------------------------------------- */

  @Get('reviews/reviewable-lines')
  @RequirePrincipal()
  @contractVersion()
  @privateToTheCaller()
  async reviewableLines(@CurrentScope() scope: Scope): Promise<ReviewableLineListWire> {
    return this.reviews.reviewableLines(scope);
  }

  /**
   * Write a review.
   *
   * 201, because a review is a resource that did not exist. The body carries no order id and
   * no product id — see the service, and plan 9.1.
   */
  @Post('reviews')
  @RequirePrincipal()
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  async write(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(writeReviewRequestSchema)) body: WriteReviewRequestWire,
  ): Promise<OwnReviewWire> {
    return this.reviews.write(scope, body);
  }

  /**
   * ⚠️ **Was `@AllowAnonymous`, and that was wrong.** Changed when the module was mounted.
   *
   * The stated defence — "no review, no person and no order" — is true field by field and
   * still misses what the response is. One anonymous request enumerates *every* product with
   * an unmoderated review, with a count each: the company's moderation backlog, published.
   * And `nextPublicationAt` is `created_at + the window`, so for a product holding one pending
   * review it gives back the minute the customer wrote it. Only a delivered-order customer can
   * review at all, and the catalogue has 81 products against no orders — the period when the
   * anonymised set is smallest is the period this ships into.
   *
   * `reviews.moderate` because that is who may see the backlog today. It is **not** the right
   * permission for the caller this was built for: plan 8.2's trap is that a review publishing
   * itself has no writer to call `revalidateTag`, and the intended poller is the Next server,
   * which is not a moderator. That needs a service credential the API does not have — recorded
   * in plan 12 rather than approximated here. Nothing calls this endpoint yet, so the choice
   * costs nothing today and a public backlog would have cost something the first day it was.
   */
  @Get('reviews/schedule')
  @RequirePermissions('reviews.moderate')
  @contractVersion()
  async schedule(@Query() query: unknown): Promise<ProductReviewScheduleWire> {
    const parsed = reviewScheduleQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw AppError.badRequest('พารามิเตอร์ไม่ถูกต้อง');
    return this.reviews.publicationSchedule(parsed.data.withinHours);
  }

  /**
   * The bytes.
   *
   * Every header below is `MediaController`'s, and for the same reason: serving user-supplied
   * bytes back to a browser hands an attacker control of a file's contents, and if the browser
   * can be persuaded to interpret it as a *document* it runs in this API's origin, where the
   * session cookie lives. The threat is sharper here than for the catalogue, because these
   * bytes came from the public rather than from the studio.
   *
   * `Content-Type` comes from the stored row, which came from reading the bytes at upload.
   * `nosniff` makes the browser honour it. The sandboxing CSP is the belt to that braces.
   * `Content-Disposition: inline` with no filename, because a filename in a header is an
   * injection surface and an `<img>` does not need one.
   *
   * ⚠️ **`Cache-Control` is `private` and not `immutable`.** A product image can never change
   * at a given id and is served to everybody, so `MediaController` says `immutable` and means
   * it. A review photograph *can* stop being servable — an erasure deletes the row, a
   * moderator hides the review — and a shared cache holding it would keep serving a photograph
   * of somebody's house after they asked to be forgotten. That is the erasure being defeated
   * by a cache header, which is exactly the class of failure plan 7.16 is about.
   */
  @Get('reviews/photos/:photoId')
  @AllowAnonymous(
    'a published review\'s photograph is on a public product page; the service refuses any ' +
      'photograph whose review is not public unless the caller holds reviews.moderate',
  )
  async photo(
    @CurrentScope() scope: Scope,
    @Param('photoId') photoId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { photo, body, contentType } = await this.reviews.photoBytes(scope, photoId);

    response.setHeader('Content-Type', contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    /* See the doc comment: revocable content must not become somebody else's cached copy. */
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('ETag', `"${photo.id}"`);

    await pipe(Readable.from(body), response);
  }

  @Get('reviews/:reviewId')
  @RequirePrincipal()
  @contractVersion()
  @privateToTheCaller()
  async ownReview(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
  ): Promise<OwnReviewWire> {
    return this.reviews.ownReview(scope, reviewId);
  }

  /**
   * Attach a photograph — plan 9.4.
   *
   * The body *is* the file, on `MediaController.upload`'s terms: no multipart parser, no
   * filename field inside a boundary, and nothing about the upload decides what the file is
   * except its bytes. `readBoundedBody` counts as it reads and destroys the socket at the
   * ceiling, so the limit bounds memory rather than merely being checked afterwards.
   *
   * There is no `X-Upload-Filename` here, unlike the media route. A product image has an
   * original filename worth showing an editor; a customer's photograph has one that is often
   * their own name, their phone's serial pattern, or a date — personal data arriving through a
   * header, for a field nobody would ever display.
   */
  @Post('reviews/:reviewId/photos')
  @RequirePrincipal()
  @HttpCode(201)
  @contractVersion()
  @privateToTheCaller()
  async uploadPhoto(
    @CurrentScope() scope: Scope,
    @Param('reviewId') reviewId: string,
    @Req() request: Request,
  ): Promise<ReviewPhotoUploadResultWire> {
    const bytes = await readBoundedBody(request, this.photos.maxBytes);
    return this.reviews.uploadPhoto(scope, reviewId, bytes);
  }

  /**
   * Remove a photograph. The review — and therefore the rating — survives.
   *
   * 204, because there is nothing to return: the review is unchanged and its rating still
   * counts, which is the whole of plan 9.4(2). A body echoing the review back would invite a
   * client to believe the two facts were one operation.
   */
  @Delete('reviews/photos/:photoId')
  @RequirePrincipal()
  @HttpCode(204)
  @privateToTheCaller()
  async deletePhoto(@CurrentScope() scope: Scope, @Param('photoId') photoId: string): Promise<void> {
    await this.reviews.deletePhoto(scope, photoId);
  }

  /* ---------------------------------------------------------------- *
   * The storefront
   * ---------------------------------------------------------------- */

  /**
   * A product's published reviews and the numbers under them — plan 9.5.
   *
   * `stats` is `null` for a product with nothing to say, and that is the shape the storefront
   * needs: `if (!stats) return null` hides the whole block, which is what plan 9.5 asks for
   * with 81 products and no orders. There is no `average` field, here or in the view.
   */
  @Get('products/:productId/reviews')
  @AllowAnonymous(
    'the published catalogue is the funnel — a product page must render its reviews for a ' +
      'visitor who has never signed in; the view omits both author columns',
  )
  @contractVersion()
  async productReviews(
    @Param('productId') productId: string,
    @Query() query: unknown,
  ): Promise<ProductReviewsWire> {
    const parsed = publishedReviewsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw AppError.badRequest('พารามิเตอร์ไม่ถูกต้อง');

    return this.reviews.productReviews(
      productId,
      parsed.data.limit,
      parsed.data.cursor === undefined ? undefined : new Date(parsed.data.cursor),
    );
  }
}
