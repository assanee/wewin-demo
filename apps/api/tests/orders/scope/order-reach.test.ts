import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { orders } from '@wewin/db/schema';

import { orderActor } from '../../../src/orders/scope/order-actor';
import { ownershipFilter } from '../../../src/orders/scope/order-ownership';
import {
  ORDER_INTENTS,
  STAFF_PERMISSION,
  describeReach,
  orderReach,
  type OrderIntent,
  type OrderReach,
} from '../../../src/orders/scope/order-reach';
import { PUBLIC_SCOPE, guestScope, systemScope, userScope, type Scope } from '../../../src/rbac/scope';
import type { PermissionCode } from '../../../src/rbac/permissions';

/**
 * The decision, and the SQL it compiles to — with no database and no HTTP.
 *
 * The point of this file is that the two are checked *together*. A reach is a value and a
 * value is easy to assert about; what plan 7.4 trap 2 is actually about is whether the
 * ownership term reaches the query, and a test that stops at the value would pass with an
 * `ownershipFilter` that returned `true` for everybody.
 *
 * So every assertion below about a reach has a matching assertion about the rendered SQL,
 * and those are written as **the parameter is bound and the column is named**. Deleting the
 * ownership term from `order-ownership.ts` turns `where "orders"."customer_user_id" = $1`
 * into `where true`, which fails here before any suite that needs Postgres has started.
 *
 * Rendering needs a Drizzle handle but not a connection: `pg.Pool` does not dial until a
 * query is issued, and `.toSQL()` never issues one. That is why this file is not `.pg.` and
 * does not skip.
 */

const A = '3f1c2d4e-0000-4000-8000-00000000000a';
const B = '3f1c2d4e-0000-4000-8000-00000000000b';
const GUEST_A = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e01';

const user = (userId: string, permissions: readonly PermissionCode[] = []): Scope =>
  userScope({
    userId,
    sessionId: '11111111-1111-4111-8111-111111111111',
    groupIds: [],
    permissions: new Set(permissions),
  });

const pool: Pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
const db: Database = createDatabase(pool);

afterAll(async () => {
  await pool.end();
});

/** The WHERE clause a scoped read would carry, as text and bound parameters. */
const render = (reach: OrderReach): { readonly sql: string; readonly params: readonly unknown[] } => {
  const query = db.select({ id: orders.id }).from(orders).where(ownershipFilter(reach)).toSQL();
  return { sql: query.sql, params: query.params };
};

describe('orderReach', () => {
  describe('a signed-in customer', () => {
    it('is scoped to the orders that name them, on both intents', () => {
      for (const intent of ORDER_INTENTS) {
        const reach = orderReach(user(A), intent);
        expect(reach).toStrictEqual({ kind: 'owned', owner: { kind: 'customer', userId: A } });
      }
    });

    it('compiles to a predicate on customer_user_id, with the id as a bound parameter', () => {
      /*
       * The two halves that matter. The *column* — a filter on anything else is not
       * ownership — and the *parameter*: an id concatenated into the string would be an
       * injection point on a value that arrives from a session, and would also defeat the
       * plan cache on the query the whole funnel runs.
       */
      const query = render(orderReach(user(A), 'act'));

      expect(query.sql).toContain('"orders"."customer_user_id" = $1');
      expect(query.params).toStrictEqual([A]);
      expect(query.sql).not.toContain(A);
    });

    it('reaches claimed guests through the orders column, and never through the guests table', () => {
      /*
       * This test used to assert the opposite, and the change is the point.
       *
       * The funnel converts by signing in, and `isOpenGuest` stops honouring the cookie the
       * moment the guest is claimed — so a submitted order, which `orders_block_delete` makes
       * permanent, would become unreachable by everybody at the exact moment it converted.
       * The stop-gap was a second ownership predicate here: "…or the orders of a guest you
       * claimed", read-only and hedged three ways.
       *
       * `IdentityLinkService.claimGuest` now attributes those orders to the account in the
       * same transaction as the claim, which is the repair the schema always described. So
       * the rescue predicate is gone, on **both** intents, and the property to hold on to is
       * that the ownership filter mentions exactly one table. A reach that has to consult
       * `guests` to decide who owns an order is a second definition of ownership, which is
       * the shape trap 2 keeps coming back in.
       */
      for (const intent of ORDER_INTENTS) {
        const query = render(orderReach(user(A), intent));
        expect(query.sql).not.toContain('claimed_by_user_id');
        expect(query.sql).not.toContain('guests');
        expect(query.sql).toContain('"orders"."customer_user_id" = $1');
      }
    });
  });

  describe('a guest — plan section 6’s fourth variant', () => {
    it('is scoped to its own cart and holds no permission that could widen it', () => {
      for (const intent of ORDER_INTENTS) {
        expect(orderReach(guestScope(GUEST_A), intent)).toStrictEqual({
          kind: 'owned',
          owner: { kind: 'guest', guestId: GUEST_A },
        });
      }

      const query = render(orderReach(guestScope(GUEST_A), 'read'));
      expect(query.sql).toContain('"orders"."guest_id" = $1');
      expect(query.params).toStrictEqual([GUEST_A]);
    });
  });

  describe('the public', () => {
    it('reaches no orders, and says so as `false` rather than as a missing filter', () => {
      /*
       * The failure this is about: Drizzle drops an `undefined` term out of `and(…)`, so a
       * builder that returned "no filter" for the public would serve the table. `false` is a
       * predicate that runs and matches nothing.
       */
      for (const intent of ORDER_INTENTS) {
        expect(orderReach(PUBLIC_SCOPE, intent).kind).toBe('none');
      }

      const query = render(orderReach(PUBLIC_SCOPE, 'read'));
      expect(query.sql).toContain('where false');
      expect(query.params).toStrictEqual([]);
    });
  });

  describe('staff authority comes from permissions and from nothing else', () => {
    it('widens a read for orders.read, and an action only for orders.read AND orders.write', () => {
      const viewer = user(B, ['orders.read']);
      const writer = user(B, ['orders.write']);
      const both = user(B, ['orders.read', 'orders.write']);

      expect(orderReach(viewer, 'read').kind).toBe('all');
      expect(orderReach(both, 'act').kind).toBe('all');
      expect(orderReach(both, 'read').kind).toBe('all');

      /*
       * The half that is easy to get wrong. A read-only clerk who reaches an action path
       * does not get the whole table to act on — they fall back to their own orders, which
       * is normally none. The route guard would refuse them first; this is the second lock,
       * and it is the one that still holds if a route is ever declared with the wrong
       * permission.
       */
      expect(orderReach(viewer, 'act')).toStrictEqual({
        kind: 'owned',
        owner: { kind: 'customer', userId: B },
      });

      /*
       * And the half that was *wrong* until this round. `orders.write` alone used to widen
       * the action reach on its own, which produced a grant nobody would have written down:
       * a holder could cancel, bounce, supersede or confirm payment on every order in the
       * company, got 404 from `GET /orders/:id` on any of them, and then read the whole
       * order — contact details and all four money figures — out of the 200 body of the
       * transition they had just made. Acting on an order you may not read is not an
       * authority; it is two mistakes that happen to cancel out in the log.
       */
      expect(orderReach(writer, 'act')).toStrictEqual({
        kind: 'owned',
        owner: { kind: 'customer', userId: B },
      });
      expect(orderReach(writer, 'read').kind).toBe('owned');
    });

    it('names the permission it used, so a log says why a row was visible', () => {
      const reach = orderReach(user(B, ['orders.read']), 'read');
      expect(describeReach(reach)).toContain(STAFF_PERMISSION.read);
    });

    it('gives an unrelated permission no reach at all', () => {
      /*
       * `orders.refund` is 5b's and `catalog.publish` is the dashboard's. Neither is a way
       * into the orders table, and the reason to assert it is that "holds any permission
       * therefore is staff" is the shape this kind of code drifts into.
       */
      for (const code of ['orders.refund', 'catalog.publish', 'users.read'] as const) {
        expect(orderReach(user(B, [code]), 'read').kind).toBe('owned');
        expect(orderReach(user(B, [code]), 'act').kind).toBe('owned');
      }
    });

    it('compiles to `true` in exactly one branch, which a reviewer can grep for', () => {
      const query = render(orderReach(user(B, ['orders.read']), 'read'));
      expect(query.sql).toContain('where true');
      expect(query.params).toStrictEqual([]);
    });
  });

  describe('the process itself', () => {
    it('reaches every order, because it is the process', () => {
      const reach = orderReach(systemScope('notification outbox'), 'act');
      expect(reach.kind).toBe('all');
      expect(describeReach(reach)).toContain('notification outbox');
    });
  });

  it('never returns a predicate that could be dropped from a WHERE clause', () => {
    /*
     * Totality, stated as a property rather than as four examples. `ownershipFilter` has no
     * `SQL | undefined` in its type, and this is the runtime half: every reach any scope can
     * produce renders to a non-empty predicate.
     */
    const scopes: readonly Scope[] = [
      user(A),
      user(B, ['orders.read']),
      user(B, ['orders.write']),
      guestScope(GUEST_A),
      PUBLIC_SCOPE,
      systemScope('probe'),
    ];

    for (const scope of scopes) {
      for (const intent of ORDER_INTENTS) {
        const query = render(orderReach(scope, intent));
        expect(query.sql, `${describeReach(orderReach(scope, intent))} produced no WHERE`).toContain('where ');
      }
    }
  });
});

describe('orderActor', () => {
  /**
   * The correspondence that keeps the module and the database from disagreeing.
   *
   * `order_events_guard_insert()` refuses a `customer` event unless
   * `actor_user_id = orders.customer_user_id`, and refuses a `guest` event unless
   * `actor_guest_id = orders.guest_id`. It imposes nothing on `staff`. So the rule this
   * pins is: **the actor kind is `staff` exactly when the act-reach is `all`** — because
   * that is the only case in which the loaded row need not name the actor.
   *
   * Break either side (give the actor a different permission test, or the reach one) and
   * this fails, naming the scope it failed for.
   */
  it('is staff exactly when the acting reach is the whole table', () => {
    const scopes: readonly Scope[] = [
      user(A),
      user(A, ['orders.read']),
      user(B, ['orders.write']),
      user(B, ['orders.read', 'orders.write']),
      guestScope(GUEST_A),
      systemScope('probe'),
    ];

    for (const scope of scopes) {
      const actor = orderActor(scope);
      const reach = orderReach(scope, 'act');
      const unrestricted = reach.kind === 'all';

      expect(
        actor?.actorKind === 'staff' || actor?.actorKind === 'system',
        `${describeReach(reach)} disagrees with actor ${String(actor?.actorKind)}`,
      ).toBe(unrestricted);
    }
  });

  it('fills the id column its kind is checked against, and no other', () => {
    expect(orderActor(user(A))).toStrictEqual({ actorKind: 'customer', actorUserId: A, actorGuestId: null });
    expect(orderActor(guestScope(GUEST_A))).toStrictEqual({
      actorKind: 'guest',
      actorUserId: null,
      actorGuestId: GUEST_A,
    });
    /* Both codes: acting authority is the conjunction — see the reach test above. */
    expect(orderActor(user(B, ['orders.read', 'orders.write']))).toStrictEqual({
      actorKind: 'staff',
      actorUserId: B,
      actorGuestId: null,
    });
    expect(orderActor(systemScope('outbox'))).toStrictEqual({
      actorKind: 'system',
      actorUserId: null,
      actorGuestId: null,
    });
  });

  it('has no actor for a caller with no principal', () => {
    // Not a throw: the route policy (`RequirePrincipal`) is what answers 401, and it knows
    // the route. A layer that cannot see the route should not be choosing the status.
    expect(orderActor(PUBLIC_SCOPE)).toBeUndefined();
  });
});

describe('the intent is a decision, not a default', () => {
  it('has exactly the two the permission map covers', () => {
    /*
     * A third intent added without a permission beside it would fall through
     * `STAFF_PERMISSION[intent]` as `undefined` and hand every caller the owned reach —
     * safe, but silently: staff would stop being staff on the new path. Keeping the two
     * lists paired is what makes that a compile error rather than a quiet demotion.
     */
    const intents: readonly OrderIntent[] = ORDER_INTENTS;
    expect(Object.keys(STAFF_PERMISSION).sort()).toStrictEqual([...intents].sort());
  });
});
