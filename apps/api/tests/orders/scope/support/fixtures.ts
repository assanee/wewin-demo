import { randomUUID } from 'node:crypto';

import type { Database, Pool } from '@wewin/db/client';
import { guests, orderEvents, orders, users } from '@wewin/db/schema';
import { inArray, sql } from '@wewin/db/sql';

/**
 * Rows for the scoping suites, and the teardown that can honestly remove them.
 *
 * Shared by `scoped-order.pg.test.ts` and `cross-tenant-routes.pg.test.ts` so the two
 * cannot drift into testing different worlds — the HTTP sweep is only meaningful if the
 * order it aims at is the same shape as the one the repository suite proved.
 *
 * **Everything here is a draft.** `orders_block_delete()` refuses to delete anything else,
 * for the right reason: a submitted order is an accounting record. A fixture that could not
 * be cleaned up would leave permanent rows in a developer's database on every run, so the
 * suites stay on the one side of the freeze where cleanup is legitimate, and the properties
 * they prove — who can load which row — do not depend on the status anyway.
 */

/** Everything this file creates is named with it, and the teardown finds rows by it. */
export const PROBE_PREFIX = 'orders scope probe';

export async function createUser(db: Database, displayName: string): Promise<string> {
  const [row] = await db.insert(users).values({ displayName }).returning({ id: users.id });
  if (!row) throw new Error('fixture insert returned nothing');
  return row.id;
}

export async function createGuest(db: Database): Promise<string> {
  const [row] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!row) throw new Error('fixture insert returned nothing');
  return row.id;
}

export interface DraftOptions {
  readonly customerUserId?: string;
  readonly guestId?: string;
  /** Written to `contact_name`, so the teardown can find the row without a side table. */
  readonly label: string;
  readonly contactEmail?: string;
}

/**
 * A cart, created the only way trap 1 permits.
 *
 * The order first with the event's id chosen up front, the event second, both inside one
 * transaction: `orders_status_event_fk` is `DEFERRABLE INITIALLY DEFERRED` and composite,
 * so it is checked at COMMIT and neither insert stands alone.
 */
export async function createDraft(db: Database, options: DraftOptions): Promise<string> {
  const orderId = randomUUID();
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      customerUserId: options.customerUserId ?? null,
      guestId: options.guestId ?? null,
      contactName: options.label,
      contactEmail: options.contactEmail ?? null,
    });
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: options.customerUserId === undefined ? 'guest' : 'customer',
      actorUserId: options.customerUserId ?? null,
      actorGuestId: options.guestId ?? null,
    });
  });

  return orderId;
}

/**
 * Everything the scoping suites created, and nothing else.
 *
 * Order matters: `orders.customer_user_id` and `orders.guest_id` are `ON DELETE RESTRICT`
 * — a deliberate break with the auth schema's cascade, because an order is an accounting
 * record — so the orders go first and the people they name go last. `order_events` cascades
 * with its order.
 */
export async function cleanUpProbes(db: Database): Promise<void> {
  await db.delete(orders).where(sql`${orders.contactName} like ${`${PROBE_PREFIX}%`}`);

  const probes = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.displayName} like ${`${PROBE_PREFIX}%`}`);
  const userIds = probes.map((row) => row.id);

  if (userIds.length > 0) {
    await db.delete(orders).where(inArray(orders.customerUserId, userIds));
    await db.delete(guests).where(inArray(guests.claimedByUserId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }

  /*
   * The unclaimed guests these suites minted. Identified by having nothing left pointing at
   * them rather than by an id list, because a run that crashed before its teardown still has
   * to be sweepable by the next one — and a guest row with no order and no event is exactly
   * what an abandoned funnel visitor looks like, which the schema already expects to be
   * swept. Bounded by an hour so a long-lived local database is never touched wholesale.
   */
  await db.execute(sql`
    delete from guests g
     where g.claimed_by_user_id is null
       and g.created_at > now() - interval '1 hour'
       and not exists (select 1 from orders o where o.guest_id = g.id)
       and not exists (select 1 from order_events e where e.actor_guest_id = g.id)
  `);
}

/** SQLSTATE off whatever `pg` threw, walking the cause chain as `translatePostgresError` does. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  const cause = 'cause' in error ? (error as { cause: unknown }).cause : undefined;
  return cause === undefined ? undefined : sqlStateOf(cause);
}

/**
 * Every message in the cause chain, joined.
 *
 * Drizzle wraps a driver error in one of its own whose message is the SQL it tried to run;
 * the sentence a trigger raised — the part that says *why* it refused — is on the cause. A
 * test that asserted on the outer message would be asserting on the query text.
 */
export function messagesOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const message = 'message' in error && typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : '';
  const cause = 'cause' in error ? (error as { cause: unknown }).cause : undefined;
  return cause === undefined ? message : `${message}\n${messagesOf(cause)}`;
}

/**
 * Poll `pg_blocking_pids` until Postgres reports a backend waiting on another.
 *
 * Asking the server rather than sleeping is the whole point. `client.query()` returns before
 * the statement reaches the server, so a race decided by a timer is a race the fast path
 * usually wins — and a lock test that passes with the lock removed is worse than no test.
 * packages/db's trap-6 race test found exactly that and documents it; this is the same fix.
 */
export async function waitForBlockedBackend(pool: Pool, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await pool.query<{ blocked: string }>(
      `select count(*)::text as blocked
         from pg_stat_activity
        where cardinality(pg_blocking_pids(pid)) > 0`,
    );
    if (Number(result.rows[0]?.blocked ?? '0') > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
