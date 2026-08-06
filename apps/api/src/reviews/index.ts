/**
 * Customer reviews after delivery — what the rest of the application may import.
 *
 * The surface is deliberately small, and what is *missing* from it is the point:
 *
 *   - `ReviewsService` is not here. The catalogue must not be able to fold a rating into a
 *     published product document: the document is frozen and a rating is not, and the one
 *     legitimate join between them is a view read over HTTP.
 *   - `ReviewRepository` is not here. Every load it performs takes a `ReviewReach`, and a
 *     caller outside this directory would have to construct one — which is exactly the moment
 *     somebody constructs `{ kind: 'all', why: 'just this once' }`.
 *   - there is no exported `canReview(review, scope)` and there never should be. A predicate
 *     over a row already in hand is plan 7.4 trap 2 exactly: the row is loaded by then, and
 *     the next refactor drops the call. Ownership is a term in the WHERE clause.
 *
 * What *is* exported is the module (so `AppModule` can import it — see the ⚠️ note there),
 * the invitation's constants and check (so a migration and a template can be written against
 * one definition rather than two), and the strip recipe (so a future sweep can find the rows
 * a given stripper produced, which is the whole reason that column exists).
 */

export { ReviewsModule, type ReviewsModuleOptions } from './reviews.module';

export {
  parseReviewPhotoConfig,
  type ReviewPhotoConfig,
} from './review-photo.config';

export {
  ReviewInvitationCheck,
  REVIEW_INVITATION_COALESCE_GROUP,
  REVIEW_INVITATION_DELAY_DAYS,
  REVIEW_INVITATION_DELAY_SECONDS,
  REVIEW_INVITATION_EVENT_TYPE,
  REVIEW_INVITATION_RULE,
  REVIEW_INVITATION_TEMPLATE_KEY,
  type InvitationRuleReport,
  type ReviewInvitationRule,
} from './review-invitation';

export { STRIP_RECIPE } from './review-photo.pipeline';

export { REVIEW_PHOTO_CONFIG } from './reviews.tokens';
