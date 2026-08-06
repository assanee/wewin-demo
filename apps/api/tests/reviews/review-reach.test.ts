import { describe, expect, it } from 'vitest';

import {
  authorColumns,
  authorFilter,
  describeReviewReach,
  reviewerReach,
  REVIEW_INTENTS,
  type ReviewIntent,
} from '../../src/reviews/review-reach';
import { guestScope, PUBLIC_SCOPE, systemScope, userScope } from '../../src/rbac';
import type { PermissionCode } from '../../src/rbac';

/**
 * Who may write a review, who may moderate one, and the branch that does not exist.
 *
 * This is a pure test on purpose. `reviewerReach` is the one function in the feature that
 * turns an identity into an authority, and every other authorisation property in the module
 * is downstream of it — a repository predicate, a service refusal, a route policy. A property
 * that can be checked without a database should be, because a Postgres suite that is skipped
 * on a laptop with no `.env` is a property nobody checked.
 *
 * The end-to-end half — that the reach genuinely becomes a WHERE clause and that a stranger's
 * review is not merely refused but *absent* — is `cross-tenant.pg.test.ts`. Neither test
 * replaces the other: this one proves the decision, that one proves the wiring.
 */

const user = (...permissions: PermissionCode[]) =>
  userScope({
    userId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    groupIds: [],
    permissions: new Set(permissions),
  });

const guest = () => guestScope('33333333-3333-4333-8333-333333333333');

describe('who may write a review', () => {
  it('gives a signed-in customer their own orders and nothing else', () => {
    const reach = reviewerReach(user(), 'write');
    expect(reach).toStrictEqual({
      kind: 'owned',
      author: { kind: 'customer', userId: '11111111-1111-4111-8111-111111111111' },
    });
  });

  it('gives a guest their own orders — the anonymous funnel is the main funnel', () => {
    /*
     * Plan section 6. Refusing the guest here would mean the customers who buy the most
     * windows are the ones who cannot review them. The cost — `erase_user()` cannot see a
     * guest's review — is asserted in erasure.pg.test.ts rather than hidden.
     */
    const reach = reviewerReach(guest(), 'write');
    expect(reach).toStrictEqual({
      kind: 'owned',
      author: { kind: 'guest', guestId: '33333333-3333-4333-8333-333333333333' },
    });
  });

  it('gives a caller with no principal nothing at all', () => {
    expect(reviewerReach(PUBLIC_SCOPE, 'write').kind).toBe('none');
  });

  /**
   * ⭐ The property the whole design rests on, stated as an exhaustive sweep rather than as
   * three examples.
   *
   * Plan 9.1's claim is that a review proves a purchase without a verified-buyer system. That
   * is true only while nobody but the buyer can write one — so `reviewerReach(_, 'write')`
   * must have no `all` branch, for *any* scope, holding *any* permission. Not "no staff hold
   * it today": no reachable value.
   *
   * The sweep includes every permission this build knows about, so adding a permission and
   * accidentally teaching this function to honour it fails here.
   */
  it('never widens a write to every review, whatever permissions the caller holds', () => {
    const everyPermission: PermissionCode[] = [
      'catalog.read',
      'catalog.write',
      'catalog.publish',
      'orders.read',
      'orders.write',
      'orders.refund',
      'quotes.read',
      'quotes.write',
      'quotes.approve',
      'payments.read',
      'payments.verify',
      'users.read',
      'users.write',
      'users.erase',
      'groups.read',
      'groups.write',
      'reviews.moderate',
    ];

    for (const permission of everyPermission) {
      const reach = reviewerReach(user(permission), 'write');
      expect(reach.kind, `${permission} must not widen a write`).toBe('owned');
    }

    /* And all of them at once, which is the account nobody should ever have. */
    expect(reviewerReach(user(...everyPermission), 'write').kind).toBe('owned');

    /* Including the process itself: a backfill must not be able to fabricate a review. */
    expect(reviewerReach(systemScope('a backfill'), 'write').kind).toBe('none');
  });
});

describe('who may moderate', () => {
  it('widens on reviews.moderate and on nothing else', () => {
    expect(reviewerReach(user('reviews.moderate'), 'moderate').kind).toBe('all');
  });

  /**
   * `orders.read` is the permission that makes somebody staff for every order in the company.
   * It must not make them a moderator: plan 9.3 spends three mechanisms making hiding
   * expensive, and reusing an order permission would make it free for everybody who had one.
   */
  it('does not widen on an order permission, however broad', () => {
    expect(reviewerReach(user('orders.read', 'orders.write', 'orders.refund'), 'moderate').kind).toBe(
      'none',
    );
  });

  /**
   * Not `owned`, and this is the distinction that matters: a customer calling the moderation
   * queue must be refused, not served a queue of their own reviews. A 200 with an empty list
   * reads to the caller as "nothing is waiting" and to a reviewer of this code as a working
   * authorisation check.
   */
  it('gives a plain customer nothing rather than a smaller queue', () => {
    expect(reviewerReach(user(), 'moderate')).toStrictEqual({
      kind: 'none',
      why: 'not a moderator: lacks reviews.moderate',
    });
  });

  it('gives a guest and the public nothing', () => {
    expect(reviewerReach(guest(), 'moderate').kind).toBe('none');
    expect(reviewerReach(PUBLIC_SCOPE, 'moderate').kind).toBe('none');
  });
});

describe('the reach, as a predicate', () => {
  /**
   * Total, and never `SQL | undefined`.
   *
   * Drizzle drops an undefined term out of `and(…)`, which is how a filter disappears in a
   * diff that does not look like a security change. Every reach must produce a term.
   */
  it('produces a term for every reach and every intent', () => {
    for (const intent of REVIEW_INTENTS satisfies readonly ReviewIntent[]) {
      for (const scope of [user(), user('reviews.moderate'), guest(), PUBLIC_SCOPE, systemScope('x')]) {
        const filter = authorFilter(reviewerReach(scope, intent));
        expect(filter).toBeDefined();
      }
    }
  });

  /** `none` is `false`, so the query still runs and returns nothing. Never an omitted term. */
  it('compiles an empty reach to false rather than to nothing', () => {
    const filter = authorFilter({ kind: 'none', why: 'test' });
    expect(String(JSON.stringify(filter.queryChunks))).toContain('false');
  });

  it('compiles an unrestricted reach to true, in one greppable branch', () => {
    const filter = authorFilter({ kind: 'all', why: 'test' });
    expect(String(JSON.stringify(filter.queryChunks))).toContain('true');
  });
});

describe('the author columns come from the reach', () => {
  /**
   * `reviews_author_shape` requires exactly one of the two. There is no request field either
   * one could come from, which is what makes a review un-attributable to somebody else.
   */
  it('names the customer, or the guest, and never both', () => {
    expect(authorColumns(reviewerReach(user(), 'write'))).toStrictEqual({
      authorUserId: '11111111-1111-4111-8111-111111111111',
      authorGuestId: null,
    });
    expect(authorColumns(reviewerReach(guest(), 'write'))).toStrictEqual({
      authorUserId: null,
      authorGuestId: '33333333-3333-4333-8333-333333333333',
    });
  });

  /**
   * A moderator's reach cannot produce an insert at all.
   *
   * This is what makes "a moderator cannot write a review" true at the repository layer as
   * well as at the reach layer: `insertReview` returns `undefined` for anything that is not
   * `owned`, so even a service that passed the wrong reach writes no row.
   */
  it('returns nothing for a reach that is not an ownership', () => {
    expect(authorColumns({ kind: 'all', why: 'moderator' })).toBeUndefined();
    expect(authorColumns({ kind: 'none', why: 'nobody' })).toBeUndefined();
  });
});

describe('the log line', () => {
  it('carries ids and no addresses', () => {
    expect(describeReviewReach(reviewerReach(user(), 'write'))).toBe(
      'reviews of user:11111111-1111-4111-8111-111111111111',
    );
    expect(describeReviewReach(reviewerReach(user('reviews.moderate'), 'moderate'))).toContain(
      'reviews.moderate',
    );
  });
});
