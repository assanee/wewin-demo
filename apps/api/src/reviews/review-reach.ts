import { orders } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { sql, type SQL } from '@wewin/db/sql';

import { matchScope, scopeHolds, type Scope } from '../rbac';

/**
 * Which reviews a caller may touch, and why — the decision, with no database in it.
 *
 * ── Why this is not `orderReach` ────────────────────────────────────────────────
 *
 * `src/orders/scope/order-reach.ts` answers a question that looks like this one and is not
 * it. There, holding `orders.read` + `orders.write` widens a caller to every order in the
 * company, which is right for staff acting on an order and **wrong for writing a review**:
 * a review's whole value in plan 9.1 is that the purchase is provable without a
 * verified-buyer system, and that property dies the moment a member of staff can write one.
 * A reach for writing therefore has no `all` branch at all — not "no staff hold it today",
 * but *no branch exists*, so no permission grant, no group edit and no future code path can
 * produce one.
 *
 *     reviewerReach(anyScopeYouLike, 'write')  ∈ { owned, none }
 *
 * That is the same shape of argument `orderReach` makes about the guest branch never being
 * able to widen: the safety comes from the branch being absent rather than from the
 * condition being false.
 *
 * ── And why it is not a boolean about a row ─────────────────────────────────────
 *
 * Plan 7.4 trap 2, which this codebase has been bitten by once and now guards everywhere:
 * ownership belongs in the query that loads the line, not in an `if` after it. So nothing
 * here returns `canReview(line, scope)`. It returns a reach, `authorFilter` turns the reach
 * into a SQL predicate, and `ReviewRepository` is the only thing that loads a reviewable
 * line — always with that predicate in the WHERE clause. There is no method that takes a
 * line id without a scope and no `findLineUnsafe` kept for a script.
 *
 * ── The moderator's reach is a different question and gets a different intent ────
 *
 * `moderate` widens on `reviews.moderate` and on nothing else. It is deliberately not
 * `orders.read`: a clerk who may look at every order has no business hiding a customer's
 * published opinion, and plan 9.3 spends three mechanisms making hiding expensive. Reusing
 * an order permission here would have made it free for everybody who already had one.
 */

/**
 * Writing a review, or moderating one. Never inferred, never defaulted.
 *
 * The required argument is `orderReach`'s reasoning restated: a single `canAccess` would
 * have to pick one of them as a default, and there is no safe default — defaulting to
 * `write` would give a moderator the customer's reach over a queue they are supposed to
 * see all of, and defaulting to `moderate` would hand a customer's write path a filter that
 * fails closed for everybody and open for a moderator.
 */
export type ReviewIntent = 'write' | 'moderate';

export const REVIEW_INTENTS: readonly ReviewIntent[] = ['write', 'moderate'];

/** The permission that makes somebody a moderator, and the only one. */
export const REVIEW_MODERATE_PERMISSION = 'reviews.moderate' as const;

/**
 * The referent a delivered line is matched against.
 *
 * Two variants and not a nullable user id, for the reason `rbac/scope.ts` gives: `where
 * customer_user_id = $1` with a null in `$1` matches nothing on a good day and is an
 * accident waiting for somebody to add an `OR` on a bad one.
 *
 * ⚠️ **A guest can write a review, and that is a decision with a consequence.** The
 * anonymous funnel is the main funnel (plan section 6), an order can be submitted without an
 * account, and refusing the guest here would mean the customers who buy the most windows
 * are the ones who cannot review them. The consequence is written down rather than
 * discovered: a guest's review has no `author_user_id`, so **`erase_user()` cannot see it**
 * — the same blindness plan 7.16 records for guest orders, arriving at a third address. It
 * is in `withheld_scope`, it is in the schema comment, and `tests/reviews/erasure.pg.test.ts`
 * asserts the blindness rather than papering over it.
 */
export type ReviewAuthor =
  | { readonly kind: 'customer'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guestId: string };

/** Every review in the table — a moderator, or the process. */
export interface ReviewReachAll {
  readonly kind: 'all';
  /** For the log line. `describeReviewReach` is the only thing that reads it. */
  readonly why: string;
}

/** The lines and reviews that name this referent. Every customer, and the funnel. */
export interface ReviewReachOwned {
  readonly kind: 'owned';
  readonly author: ReviewAuthor;
}

/** Nothing reachable at all — not "none found". A caller with no referent, or no permission. */
export interface ReviewReachNone {
  readonly kind: 'none';
  readonly why: string;
}

export type ReviewReach = ReviewReachAll | ReviewReachOwned | ReviewReachNone;

/**
 * Scope + intent → reach. The single place the question is answered.
 *
 * `matchScope` and not a `switch`: a `default` branch would compile for a fifth scope
 * variant and quietly hand it whatever the default was, and for a query builder the default
 * is "no filter". The guest is exactly the variant that would have been forgotten.
 */
export function reviewerReach(scope: Scope, intent: ReviewIntent): ReviewReach {
  if (intent === 'moderate') {
    return matchScope<ReviewReach>(scope, {
      user: (user) =>
        scopeHolds(user, REVIEW_MODERATE_PERMISSION)
          ? { kind: 'all', why: `moderator (${REVIEW_MODERATE_PERMISSION})` }
          : /*
             * A signed-in customer is not a moderator with a smaller queue — they are not a
             * moderator. Falling back to `owned` here would make `GET /admin/reviews` answer
             * 200 with a customer's own reviews, which reads to the caller as "the queue is
             * empty" and to a reviewer of this code as a working authorisation check.
             */
            { kind: 'none', why: `not a moderator: lacks ${REVIEW_MODERATE_PERMISSION}` },
      guest: () => ({ kind: 'none', why: 'a guest holds no permission by construction' }),
      public: () => ({ kind: 'none', why: 'no principal' }),
      /*
       * The process acting on its own behalf. Never produced from an HTTP request
       * (`rbac/identity.ts`), so this branch cannot be reached by anything a caller sends.
       */
      system: (system) => ({ kind: 'all', why: `system (${system.reason})` }),
    });
  }

  return matchScope<ReviewReach>(scope, {
    /*
     * ⭐ No permission is consulted, and there is nothing here that could widen. A holder of
     * `orders.write` — who may cancel any order in the company — reaches exactly their own
     * delivered lines here, which is normally none. See the module comment for why the
     * absence of the branch is the mechanism.
     */
    user: (user) => ({ kind: 'owned', author: { kind: 'customer', userId: user.userId } }),
    guest: (guest) => ({ kind: 'owned', author: { kind: 'guest', guestId: guest.guestId } }),
    public: () => ({ kind: 'none', why: 'no principal: neither a session nor a guest cookie' }),
    /*
     * The process does not have opinions about windows. A `system` scope reaching `all` on
     * the write path would make "a review proves a purchase" false for any code path that
     * ever runs as the process — a backfill, a worker, a migration helper.
     */
    system: (system) => ({ kind: 'none', why: `system (${system.reason}) does not write reviews` }),
  });
}

/**
 * A reach, as the WHERE clause that enforces it — against `orders`.
 *
 * Total, and never `SQL | undefined`. Drizzle *drops* an undefined term out of `and(…)`,
 * which is precisely how a filter disappears in a diff that does not look like a security
 * change; `none` compiles to `false`, so the query still runs and returns nothing.
 *
 * `all` says `true` in one branch an auditor can find with a grep, and that branch is only
 * reachable from a reach built by `reviewerReach` out of a permission the guard resolved
 * from `group_permissions`.
 */
export function authorFilter(reach: ReviewReach): SQL {
  switch (reach.kind) {
    case 'all':
      return sql`true`;

    case 'none':
      /*
       * `false` and not an early return, so a caller who builds the query anyway gets an
       * empty result. The failure mode of a mistake here is "the customer sees nothing",
       * never "the customer sees everything".
       */
      return sql`false`;

    case 'owned':
      return reach.author.kind === 'customer'
        ? sql`${orders.customerUserId} = ${reach.author.userId}`
        : /*
           * An order that names an account is that account's, whatever else it also names.
           * `IdentityLinkService.claimGuest` back-fills `customer_user_id` and leaves
           * `guest_id` in place, so rows carrying both exist — and a cookie for that guest
           * must not reach an order that now belongs to a signed-in person.
           * `order-ownership.ts` makes the same second term for the same reason.
           */
          sql`(${orders.guestId} = ${reach.author.guestId} and ${orders.customerUserId} is null)`;
  }
}

/**
 * The author columns to write on a new review, from the reach that authorised it.
 *
 * `reviews_author_shape` requires exactly one of the two to be non-null, and this is where
 * that one is chosen — from the reach, never from the request body. A `authorUserId` field
 * on the wire would be a review anybody could attribute to anybody.
 */
export function authorColumns(
  reach: ReviewReach,
): { readonly authorUserId: string | null; readonly authorGuestId: string | null } | undefined {
  if (reach.kind !== 'owned') return undefined;
  return reach.author.kind === 'customer'
    ? { authorUserId: reach.author.userId, authorGuestId: null }
    : { authorUserId: null, authorGuestId: reach.author.guestId };
}

/** One line for a log. Ids only, for the reason `describeScope` gives. */
export function describeReviewReach(reach: ReviewReach): string {
  switch (reach.kind) {
    case 'all':
      return `all reviews — ${reach.why}`;
    case 'owned':
      return reach.author.kind === 'customer'
        ? `reviews of user:${reach.author.userId}`
        : `reviews of guest:${reach.author.guestId}`;
    case 'none':
      return `no reviews — ${reach.why}`;
  }
}
