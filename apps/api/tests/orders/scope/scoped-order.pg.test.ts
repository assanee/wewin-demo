import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { guests, orderEvents, orders } from '@wewin/db/schema';
import { eq } from '@wewin/db/sql';

import { AppError } from '../../../src/common/errors/app-error';
import { orderActor } from '../../../src/orders/scope/order-actor';
import { ScopedOrderRepository } from '../../../src/orders/scope/scoped-order.repository';
import { PUBLIC_SCOPE, guestScope, systemScope, userScope, type Scope } from '../../../src/rbac/scope';
import type { PermissionCode } from '../../../src/rbac/permissions';
import {
  PROBE_PREFIX,
  cleanUpProbes,
  createDraft,
  createGuest,
  createUser,
  messagesOf,
  sqlStateOf,
  waitForBlockedBackend,
} from './support/fixtures';

/**
 * Row-level scoping against a real Postgres — the part a unit test cannot reach.
 *
 * `order-reach.test.ts` proves the predicate is *built*. This file proves it *works*: the
 * rows exist, the queries run, and customer B gets nothing back for customer A's order on
 * every entry point this module has.
 *
 * Two properties can only be shown with a database, and they are why the file exists:
 *
 *   **The database's own trap-2 backstop agrees with this module.**
 *   `order_events_guard_insert()` refuses an event whose `actor_kind` is `customer` unless
 *   `actor_user_id` matches the order's customer. The block below derives the actor from B's
 *   scope, aims it at A's order, and watches Postgres refuse — which is what makes "a query
 *   written one day without the WHERE clause is a failed write, not a silent cross-tenant
 *   edit" a fact rather than a hope.
 *
 *   **`lock` really takes the row lock.** Trap 4 says load and lock *before* choosing the
 *   payload schema. `FOR UPDATE` is one method call whose absence changes no type and no
 *   result; the only way to notice is to watch a second transaction block on it.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const SESSION = '11111111-1111-4111-8111-111111111111';

const scopeOf = (userId: string, permissions: readonly PermissionCode[] = []): Scope =>
  userScope({ userId, sessionId: SESSION, groupIds: [], permissions: new Set(permissions) });

interface Fixture {
  readonly customerA: string;
  readonly customerB: string;
  readonly viewer: string;
  readonly writer: string;
  readonly guestA: string;
  readonly guestB: string;
  /** Claimed by customer A after its order was created — the funnel converting. */
  readonly claimedGuest: string;
  readonly orderA: string;
  readonly orderB: string;
  readonly orderOfGuestA: string;
  readonly orderOfClaimedGuest: string;
}

describeWithPg('row-level scoping for orders', () => {
  let pool: Pool;
  let db: Database;
  let repository: ScopedOrderRepository;
  let fixture: Fixture;

  let scopeA: Scope;
  let scopeB: Scope;
  let scopeGuestA: Scope;
  let scopeGuestB: Scope;
  let scopeViewer: Scope;
  let scopeWriter: Scope;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    repository = new ScopedOrderRepository(db);

    // Each Postgres suite establishes its own starting point — see apps/api/vitest.config.ts
    // on why a result that depends on file order is not a result.
    await cleanUpProbes(db);
    fixture = await seed(db);

    scopeA = scopeOf(fixture.customerA);
    scopeB = scopeOf(fixture.customerB);
    scopeGuestA = guestScope(fixture.guestA);
    scopeGuestB = guestScope(fixture.guestB);
    scopeViewer = scopeOf(fixture.viewer, ['orders.read']);
    /*
     * Both codes. `orders.write` alone no longer widens the acting reach — acting on an
     * order you may not read was a grant nobody wrote down, and it is refused now. See the
     * dedicated case further down and the note in `orderReach`.
     */
    scopeWriter = scopeOf(fixture.writer, ['orders.read', 'orders.write']);
  });

  afterAll(async () => {
    await cleanUpProbes(db);
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Customer B against customer A
   * ---------------------------------------------------------------- */

  describe('a customer and somebody else’s order', () => {
    it('returns the order to the customer it names', async () => {
      const order = await repository.find(scopeA, fixture.orderA, 'read');
      expect(order?.id).toBe(fixture.orderA);
      expect(order?.customerUserId).toBe(fixture.customerA);
    });

    it('returns nothing to another signed-in customer, on every entry point', async () => {
      /*
       * The assertion plan 7.4 trap 2 asks for, over the whole surface rather than over the
       * one method somebody remembered. `find`, `lock` and `list` each build their own
       * query; if any of them had grown its own WHERE clause, only that one would fail here.
       */
      expect(await repository.find(scopeB, fixture.orderA, 'read')).toBeUndefined();
      expect(await repository.find(scopeB, fixture.orderA, 'act')).toBeUndefined();

      await repository.transaction(async (tx) => {
        expect(await repository.lock(tx, scopeB, fixture.orderA, 'read')).toBeUndefined();
        expect(await repository.lock(tx, scopeB, fixture.orderA, 'act')).toBeUndefined();
      });

      const listed = (await repository.list(scopeB)).map((order) => order.id);
      expect(listed).not.toContain(fixture.orderA);
      expect(listed).toStrictEqual([fixture.orderB]);
    });

    it('answers a missing order and somebody else’s order identically', async () => {
      /*
       * Two status codes would be an oracle: iterate ids, read the codes, and you have
       * counted the company's orders and can tell a real order number from a guess. Same
       * code, same message, same envelope — the caller cannot tell the two apart.
       */
      const foreign = await repository.findOrFail(scopeB, fixture.orderA, 'read').catch((error: unknown) => error);
      const absent = await repository.findOrFail(scopeB, randomUUID(), 'read').catch((error: unknown) => error);

      expect(foreign).toBeInstanceOf(AppError);
      expect(absent).toBeInstanceOf(AppError);
      expect((foreign as AppError).status).toBe(404);
      expect((foreign as AppError).status).toBe((absent as AppError).status);
      expect((foreign as AppError).message).toBe((absent as AppError).message);
      expect((foreign as AppError).code).toBe((absent as AppError).code);
    });

    it('treats an id that cannot be an id as an order that is not there', async () => {
      // `where id = 'nonsense'` against a uuid column is SQLSTATE 22P02 — a 500 for a
      // request that is simply about an order that cannot exist.
      expect(await repository.find(scopeA, 'not-a-uuid', 'read')).toBeUndefined();
      expect(await repository.find(scopeA, "' or 1=1--", 'read')).toBeUndefined();
    });
  });

  /* ---------------------------------------------------------------- *
   * The funnel
   * ---------------------------------------------------------------- */

  describe('guests — plan section 6’s fourth scope', () => {
    it('gives a guest its own cart', async () => {
      const order = await repository.find(scopeGuestA, fixture.orderOfGuestA, 'read');
      expect(order?.id).toBe(fixture.orderOfGuestA);
      expect(order?.customerUserId).toBeNull();
    });

    it('gives one guest nothing of another guest’s', async () => {
      expect(await repository.find(scopeGuestB, fixture.orderOfGuestA, 'read')).toBeUndefined();
      expect(await repository.find(scopeGuestB, fixture.orderOfGuestA, 'act')).toBeUndefined();
      expect(await repository.list(scopeGuestB)).toStrictEqual([]);
    });

    it('gives a signed-in customer nothing of a guest cart they never claimed', async () => {
      expect(await repository.find(scopeB, fixture.orderOfGuestA, 'read')).toBeUndefined();
    });

    it('gives the public nothing at all', async () => {
      for (const id of [fixture.orderA, fixture.orderOfGuestA, fixture.orderB]) {
        expect(await repository.find(PUBLIC_SCOPE, id, 'read')).toBeUndefined();
      }
      expect(await repository.list(PUBLIC_SCOPE)).toStrictEqual([]);
    });
  });

  describe('a guest that signed in', () => {
    /*
     * ⚠️ This block asserted the opposite until this round, and the fixture is the same.
     *
     * `fixture.orderOfClaimedGuest` is a claimed guest's order that **nothing backfilled** —
     * `customer_user_id` is still null. That used to be the ordinary state of affairs after a
     * sign-in, and the scope layer carried a rescue predicate ("…or the orders of a guest you
     * claimed") so the row would not be orphaned by its own conversion.
     *
     * `IdentityLinkService.claimGuest` now attributes those orders in the same transaction as
     * the claim, so that state no longer occurs on any path — and the fixture is what remains
     * of it: a row nobody's claim ever touched. It must be reachable by nobody, because the
     * alternative is a second definition of ownership living beside the column.
     */
    it('is reachable by nobody once the rescue predicate is gone — the claim is what attaches it', async () => {
      for (const intent of ['read', 'act'] as const) {
        expect(await repository.find(scopeA, fixture.orderOfClaimedGuest, intent)).toBeUndefined();
      }
      expect((await repository.list(scopeA)).map((row) => row.id)).not.toContain(
        fixture.orderOfClaimedGuest,
      );
    });

    it('does not let a different account read it', async () => {
      expect(await repository.find(scopeB, fixture.orderOfClaimedGuest, 'read')).toBeUndefined();
    });

    it('is reached by the account the moment the claim backfills the column', async () => {
      /*
       * The repair itself, at the level this file is about. `claimGuest` runs exactly this
       * UPDATE inside the claiming transaction; here it is run by hand so that the assertion
       * is about the *predicate* and not about the OAuth flow (which `hardening.pg.test.ts`
       * covers end to end).
       */
      await db
        .update(orders)
        .set({ customerUserId: fixture.customerA })
        .where(eq(orders.id, fixture.orderOfClaimedGuest));

      expect((await repository.find(scopeA, fixture.orderOfClaimedGuest, 'read'))?.id).toBe(
        fixture.orderOfClaimedGuest,
      );
      /* And acting works too, which the rescue predicate could never allow. */
      expect((await repository.find(scopeA, fixture.orderOfClaimedGuest, 'act'))?.id).toBe(
        fixture.orderOfClaimedGuest,
      );

      /*
       * …and the guest cookie for that same guest now reaches nothing, because the order
       * names an account. That is the second term in `guestFilter`, and it is what stops the
       * backfill from turning a revoked cookie into a live one.
       */
      expect(
        await repository.find(guestScope(fixture.claimedGuest), fixture.orderOfClaimedGuest, 'read'),
      ).toBeUndefined();

      /*
       * Not undone, because it cannot be: `orders_guard_update()` refuses to move
       * `customer_user_id` back to null ("order … already belongs to user …"). That refusal
       * is the other half of why the backfill is safe to run at claim time — the attribution
       * is one-way, so a second sign-in cannot re-point an order at a different account. It
       * is asserted here rather than worked around, and this case is last in the block for
       * that reason.
       */
      const reversal = await db
        .update(orders)
        .set({ customerUserId: null })
        .where(eq(orders.id, fixture.orderOfClaimedGuest))
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      /* Drizzle wraps it; the trigger's own sentence is on the cause. */
      expect(String((reversal as { cause?: unknown } | undefined)?.cause)).toContain(
        'already belongs to user',
      );
    });
  });

  describe('orders.write without orders.read', () => {
    it('reaches nothing at all — acting on an order you may not read is not an authority', async () => {
      const writeOnly = scopeOf(fixture.writer, ['orders.write']);

      for (const intent of ['read', 'act'] as const) {
        expect(await repository.find(writeOnly, fixture.orderA, intent)).toBeUndefined();
      }
      expect(await repository.list(writeOnly)).toStrictEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * Staff
   * ---------------------------------------------------------------- */

  describe('staff, whose authority is a permission and nothing else', () => {
    it('lets orders.read see every customer’s order', async () => {
      expect((await repository.find(scopeViewer, fixture.orderA, 'read'))?.id).toBe(fixture.orderA);
      expect((await repository.find(scopeViewer, fixture.orderOfGuestA, 'read'))?.id).toBe(fixture.orderOfGuestA);

      const listed = (await repository.list(scopeViewer)).map((order) => order.id);
      for (const id of [fixture.orderA, fixture.orderB, fixture.orderOfGuestA]) {
        expect(listed).toContain(id);
      }
    });

    it('does not let orders.read act on anybody’s order', async () => {
      /*
       * The sales-viewer shape: sees the whole queue, moves nothing. It falls out of the two
       * permissions rather than needing a third role — and it is the second lock behind the
       * route guard, which is the one that still holds if a route is declared wrongly.
       */
      expect(await repository.find(scopeViewer, fixture.orderA, 'act')).toBeUndefined();
    });

    it('lets orders.write act on any order', async () => {
      await repository.transaction(async (tx) => {
        const locked = await repository.lock(tx, scopeWriter, fixture.orderA, 'act');
        expect(locked?.id).toBe(fixture.orderA);
        expect(locked?.reach.kind).toBe('all');
      });
    });

    it('lets the process itself reach every order', async () => {
      const order = await repository.find(systemScope('notification outbox'), fixture.orderA, 'read');
      expect(order?.id).toBe(fixture.orderA);
    });

    it('filters a staff queue by status without losing the ownership term', async () => {
      /*
       * The list takes a second predicate. Two terms composed with `and` is where a filter
       * builder usually loses one of them — an empty status list is the classic, because
       * `IN ()` is a syntax error and the tempting repair is to drop the term.
       */
      expect(await repository.list(scopeViewer, { statuses: [] })).toStrictEqual([]);
      expect((await repository.list(scopeViewer, { statuses: ['draft'] })).map((row) => row.id)).toContain(
        fixture.orderA,
      );
      expect(await repository.list(scopeB, { statuses: ['draft'] })).toHaveLength(1);
      expect(await repository.list(scopeB, { statuses: ['delivered'] })).toStrictEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * The database's own backstop
   * ---------------------------------------------------------------- */

  describe('the actor derived from a scope, against the spine’s own guard', () => {
    it('is refused by Postgres when it is aimed at an order it does not own', async () => {
      /*
       * The belt to this module's braces. B's scope produces `{customer, B}`; written
       * against A's order — which is what a repository that forgot its WHERE clause would
       * allow — `order_events_guard_insert()` refuses it with `restrict_violation`.
       *
       * If this ever starts passing, the database backstop has been removed and the scope
       * filter is the only thing left standing.
       */
      const actor = orderActor(scopeB);
      expect(actor).toStrictEqual({ actorKind: 'customer', actorUserId: fixture.customerB, actorGuestId: null });

      const error = await db
        .insert(orderEvents)
        .values({
          orderId: fixture.orderA,
          eventType: 'cancelled',
          fromStatus: 'draft',
          toStatus: 'cancelled',
          actorKind: 'customer',
          actorUserId: fixture.customerB,
          payload: { reason: 'probe' },
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      // 23001 is `restrict_violation`, which is what `order_events_guard_insert()` raises.
      expect(sqlStateOf(error), `expected restrict_violation, got: ${String(error)}`).toBe('23001');
      // And it refused for the right reason. A schema that refused every event would satisfy
      // the SQLSTATE alone, which is why the next test writes the same event for the owner.
      expect(messagesOf(error)).toContain('does not own order');
    });

    it('is accepted for the order it does own, so the refusal above is about ownership', async () => {
      /*
       * The other half. Without it the test above would pass just as well against a schema
       * that refused every event, which would prove nothing about ownership at all.
       */
      const actor = orderActor(scopeA);
      const draft = await createDraft(db, { customerUserId: fixture.customerA, label: `${PROBE_PREFIX} cancellable` });

      await db.insert(orderEvents).values({
        orderId: draft,
        eventType: 'cancelled',
        fromStatus: 'draft',
        toStatus: 'cancelled',
        actorKind: 'customer',
        actorUserId: actor?.actorUserId ?? null,
        payload: { reason: 'probe' },
      });

      const events = await db.select({ id: orderEvents.id }).from(orderEvents).where(eq(orderEvents.orderId, draft));
      expect(events).toHaveLength(2);
    });
  });

  /* ---------------------------------------------------------------- *
   * The lock
   * ---------------------------------------------------------------- */

  describe('lock', () => {
    it('holds the row against a second transaction until the first commits', async () => {
      /*
       * `FOR UPDATE` is one method call whose absence changes no type and no result. The only
       * way to notice is to watch a second transaction block on it — and the wait has to be on
       * Postgres *reporting* a blocked backend rather than on a timer, because `client.query()`
       * returns before the statement reaches the server and a sleep would make this green with
       * the lock removed. packages/db's trap-6 test found that the hard way.
       */
      let secondSettled = false;
      let releaseFirst: () => void = () => undefined;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = repository.transaction(async (tx) => {
        const locked = await repository.lock(tx, scopeWriter, fixture.orderA, 'act');
        expect(locked?.id).toBe(fixture.orderA);
        await firstMayCommit;
      });

      const second = repository.transaction(async (tx) => {
        await repository.lock(tx, scopeWriter, fixture.orderA, 'act');
        secondSettled = true;
      });

      const blocked = await waitForBlockedBackend(pool);
      expect(blocked, 'no backend was ever reported as blocked — the row was not locked').toBe(true);
      expect(secondSettled, 'the second transaction acquired the row while the first still held it').toBe(false);

      releaseFirst();
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

async function seed(db: Database): Promise<Fixture> {
  const customerA = await createUser(db, `${PROBE_PREFIX} customer A`);
  const customerB = await createUser(db, `${PROBE_PREFIX} customer B`);
  const viewer = await createUser(db, `${PROBE_PREFIX} viewer`);
  const writer = await createUser(db, `${PROBE_PREFIX} writer`);

  const guestA = await createGuest(db);
  const guestB = await createGuest(db);
  const claimedGuest = await createGuest(db);

  const orderA = await createDraft(db, { customerUserId: customerA, label: `${PROBE_PREFIX} order A` });
  const orderB = await createDraft(db, { customerUserId: customerB, label: `${PROBE_PREFIX} order B` });
  const orderOfGuestA = await createDraft(db, { guestId: guestA, label: `${PROBE_PREFIX} order of guest A` });
  const orderOfClaimedGuest = await createDraft(db, {
    guestId: claimedGuest,
    label: `${PROBE_PREFIX} order of claimed guest`,
  });

  /*
   * The conversion, as the auth path performs it: the guest row is claimed, which is what
   * makes `isOpenGuest` refuse the cookie from now on. Note what is deliberately *not* done —
   * `orders.customer_user_id` is left null, because the backfill that would set it belongs to
   * a cart/claim path that does not exist yet. This is the state the claimed-guest read
   * branch exists for.
   */
  await db
    .update(guests)
    .set({ claimedByUserId: customerA, claimedAt: new Date() })
    .where(eq(guests.id, claimedGuest));

  return {
    customerA,
    customerB,
    viewer,
    writer,
    guestA,
    guestB,
    claimedGuest,
    orderA,
    orderB,
    orderOfGuestA,
    orderOfClaimedGuest,
  };
}
