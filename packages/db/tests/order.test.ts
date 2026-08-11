import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Pool } from '../src/client.js';
import {
  ORDER_STATUSES,
  POST_FREEZE_STATUSES,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
  guests,
  notificationAttempts,
  notifications,
  orderChangeRequests,
  orderDocumentProductVersions,
  orderDocuments,
  orderEvents,
  orderStatusTransitions,
  orders,
  users,
} from '../src/schema/index.js';
import { PG, connect, connectPool, describeDb, errorCode } from './support/db.js';

/**
 * Phase 5a: the order lifecycle, its spine, and the outbox that reads from it.
 *
 * Every block below is written so that **removing the fix makes it fail**, not so that it
 * passes today. Each of plan 7.4's seven traps has a test whose failure mode is named in
 * its own comment, and each was verified by mutation against a scratch database — drop the
 * constraint, watch the test go red, put it back. What that verification found is written
 * down beside the tests it changed.
 *
 * Rows are tagged with a per-run id and are mostly not cleaned up, on purpose: a submitted
 * order cannot be deleted (`orders_block_delete`), and a teardown that could delete one
 * would be a teardown that contradicts the schema it is testing. Drafts and the catalogue
 * fixture are cleaned up, because those the schema does allow.
 */

const tag = randomUUID().slice(0, 8);

const expectViolation = async (
  operation: Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

/** Plan 4.4's worked example: ฿8,791 net, 7% VAT, ฿9,406.37 grand — and 30% of it. */
const NET = 879100n;
const VAT = 61537n;
const GRAND = 940637n;
const DEPOSIT = 282191n;

type Draft = { orderId: string; guestId: string };

let db: Database;
let pool: Pool;
/** A member of staff, for the transitions only staff may make. Not the owner of anything. */
let staffUserId: string;

const createGuest = async (): Promise<string> => {
  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');
  return guest.id;
};

const createUser = async (name: string): Promise<string> => {
  const [user] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!user) throw new Error('could not create a user');
  return user.id;
};

/**
 * An anonymous cart, created the only way trap 1 permits: order first with the event's id
 * chosen up front, event second, both inside one transaction.
 */
const createDraft = async (options: { contactEmail?: string; userId?: string } = {}): Promise<Draft> => {
  const guestId = await createGuest();
  const orderId = randomUUID();
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      guestId,
      customerUserId: options.userId ?? null,
      contactEmail: options.contactEmail ?? null,
    });
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guestId,
    });
  });

  return { orderId, guestId };
};

/**
 * The submit, as one transaction that pins seven things and moves the status once.
 *
 * The statement order is forced and worth reading: the document names the event that
 * produced it, and the order names the document, so the event has to be written first. It
 * is exactly why the fan-out is a deferred trigger — see the outbox block below.
 */
const submit = async (draft: Draft, revision = 1): Promise<string> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, draft.orderId)).for('update');

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId: draft.orderId,
      eventType: 'submitted_for_payment',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorKind: 'guest',
      actorGuestId: draft.guestId,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId: draft.orderId,
        revision,
        document: { lines: [] },
        documentHash: revision.toString().padStart(64, '0'),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        createdByEventId: eventId,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a document');

    await tx
      .update(orders)
      .set({
        status: 'awaiting_payment',
        statusEventId: eventId,
        /*
         * Postgres's clock, matching `order.repository.ts`.
         *
         * `new Date()` is *this process's* clock, and `frozen_at` is stamped by a trigger
         * with `now()`. A helper that mixes the two makes `orders_frozen_after_submitted` a
         * race against the skew between them — 25 ms on this machine — which two of the
         * freeze-point tests lost whenever a warm pool brought submit and confirm close
         * enough together. Under `now()` the ordering is transactional and cannot lose.
         */
        submittedAt: sql`now()`,
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: document.id,
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        scheduledDepositThbMinor: DEPOSIT,
      })
      .where(eq(orders.id, draft.orderId));
  });

  return eventId;
};

/**
 * One transition, the way the API has to make it: load the order and take the lock FIRST,
 * then read the transition row, then write. Trap 4 is the mistake of choosing the payload
 * before this point.
 */
const move = async (
  orderId: string,
  to: OrderStatus,
  options: {
    actorKind?: 'customer' | 'guest' | 'staff' | 'system';
    actorUserId?: string | null;
    actorGuestId?: string | null;
    payload?: Record<string, unknown>;
    eventType?: string;
  } = {},
): Promise<string> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');
    if (!order) throw new Error(`order ${orderId} not found`);

    const [transition] = await tx
      .select()
      .from(orderStatusTransitions)
      .where(
        and(
          eq(orderStatusTransitions.fromStatus, order.status),
          eq(orderStatusTransitions.toStatus, to),
        ),
      );

    const actorKind = options.actorKind ?? 'staff';

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: (options.eventType ?? transition?.eventType ?? 'cancelled') as 'cancelled',
      fromStatus: order.status,
      toStatus: to,
      actorKind,
      actorUserId: options.actorUserId ?? (actorKind === 'staff' ? staffUserId : null),
      actorGuestId: options.actorGuestId ?? null,
      payload: options.payload ?? {},
    });

    await tx.update(orders).set({ status: to, statusEventId: eventId }).where(eq(orders.id, orderId));
  });

  return eventId;
};

/** An order sitting at the freeze point, which most of the post-freeze tests start from. */
const frozenOrder = async (): Promise<Draft> => {
  const draft = await createDraft({ contactEmail: `frozen-${randomUUID().slice(0, 8)}@example.test` });
  await submit(draft);
  await move(draft.orderId, 'production_confirmed');
  return draft;
};

/**
 * Wait until Postgres reports one backend waiting on another.
 *
 * `pg_blocking_pids` is the server's own answer to "is somebody stuck behind a lock",
 * which is the only reliable way to know a concurrent statement has actually reached the
 * database rather than merely been handed to the event loop.
 */
const waitForBlockedBackend = async (timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const waiting = await db.execute<{ blocked: number }>(sql`
      select count(*)::int as blocked
        from pg_stat_activity
       where cardinality(pg_blocking_pids(pid)) > 0
    `);

    if ((waiting.rows[0]?.blocked ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('no backend ever blocked');

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const statusOf = async (orderId: string): Promise<OrderStatus> => {
  const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!row) throw new Error('order vanished');
  return row.status;
};

beforeAll(async () => {
  db = await connect();
  pool = await connectPool();
  staffUserId = await createUser(`staff ${tag}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// The nine statuses and every legal transition — plan 7.1
// ─────────────────────────────────────────────────────────────────────────────

describeDb('nine statuses, stored as text, with the legal moves as rows', () => {
  it('is text with a CHECK and not a pg enum, because the list has grown before', async () => {
    const column = await db.execute<{ data_type: string; udt_name: string }>(sql`
      select data_type, udt_name
        from information_schema.columns
       where table_schema = 'public' and table_name = 'orders' and column_name = 'status'
    `);

    // Plan 7.1: `ALTER TYPE … ADD VALUE` cannot be rolled back, and this project has
    // already been told the list was final once. If somebody "tidies" this into an enum,
    // the tenth status becomes an irreversible migration.
    expect(column.rows[0]?.data_type).toBe('text');
    expect(column.rows[0]?.udt_name).toBe('text');

    const constraint = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'orders_status_known'
    `);
    const definition = constraint.rows[0]?.definition ?? '';
    for (const status of ORDER_STATUSES) {
      expect(definition).toContain(`'${status}'`);
    }

    // And a tenth status that nobody added is refused. The error is the *trigger*'s (an
    // order is created as a draft) rather than the CHECK's, because BEFORE INSERT triggers
    // run first — the CHECK is what still holds when the trigger is not the one being
    // exercised, which is why both are asserted.
    await expectViolation(
      db.execute(sql`
        insert into orders (status_event_id, guest_id, status)
        values (gen_random_uuid(), (select id from guests limit 1), 'awaiting_balance')
      `),
      PG.restrictViolation,
    );
  });

  it('agrees with the TypeScript mirror about what is past the freeze', async () => {
    // The same drift test tests/enums.test.ts runs for the catalogue's unions, in the one
    // direction a constant cannot check itself: `order_status_is_post_freeze()` is the
    // definition, `POST_FREEZE_STATUSES` is a copy for callers, and a copy that disagrees
    // is worse than no copy.
    const answers = await db.execute<{ status: string; post_freeze: boolean }>(sql`
      select t.status, order_status_is_post_freeze(t.status) as post_freeze
        from unnest(${sql.raw(`array['${ORDER_STATUSES.join("','")}']::text[]`)}) as t(status)
    `);

    const fromDatabase = answers.rows
      .filter((row) => row.post_freeze)
      .map((row) => row.status)
      .sort();

    expect(fromDatabase).toEqual([...POST_FREEZE_STATUSES].sort());
  });

  it('splits cancellation at the freeze, in six rows and two payload kinds', async () => {
    const cancels = await db
      .select()
      .from(orderStatusTransitions)
      .where(eq(orderStatusTransitions.toStatus, 'cancelled'));

    // Trap 4's premise: `cancel` is not one transition. Six of them, and the split is
    // exactly the freeze — which is why choosing the payload schema before loading the
    // order cannot be done correctly.
    expect(cancels).toHaveLength(6);

    const post = cancels.filter((row) => row.payloadKind === 'cancel_post_freeze');
    expect(post.map((row) => row.fromStatus).sort()).toEqual([
      'awaiting_installation',
      'in_production',
      'production_confirmed',
      'redesign',
    ]);

    // Plan 7.8 says `redesign` is cancellable and that forgetting it is the usual mistake.
    expect(post.some((row) => row.fromStatus === 'redesign')).toBe(true);

    // 🔒 And every one of them demands `fault`, which decides how much money comes back.
    for (const row of post) {
      expect(row.requiredPayloadKeys).toContain('fault');
    }
  });

  it('leaves the terminal statuses terminal', async () => {
    const outgoing = await db
      .select({ from: orderStatusTransitions.fromStatus })
      .from(orderStatusTransitions);

    for (const terminal of TERMINAL_ORDER_STATUSES) {
      expect(outgoing.map((row) => row.from)).not.toContain(terminal);
    }
  });

  it('refuses a move that is not a row', async () => {
    const draft = await createDraft();

    // draft → delivered is not in the table, so it is not a thing that can happen — and the
    // refusal is Postgres's, not a service's, so a second service cannot disagree.
    await expectViolation(
      db.update(orders).set({ status: 'delivered', statusEventId: randomUUID() }).where(eq(orders.id, draft.orderId)),
      PG.restrictViolation,
    );

    expect(await statusOf(draft.orderId)).toBe('draft');
  });

  it('refuses a status change that no event records', async () => {
    const draft = await createDraft({ contactEmail: `spine-${tag}@example.test` });

    // The spine is not optional. Without this the status could move with nothing to date
    // it, attribute it, or notify anybody about — and the deferred FK would only notice at
    // COMMIT, several statements away from the cause.
    await expectViolation(
      db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, draft.orderId)),
      PG.restrictViolation,
    );
  });

  it('refuses an event whose type does not match the move it records', async () => {
    const draft = await createDraft();

    // The outbox routes on `event_type` (plan 10.3), so a mislabelled event sends the
    // wrong message about the right change. The transition row is the single answer.
    await expectViolation(
      db.insert(orderEvents).values({
        orderId: draft.orderId,
        eventType: 'delivered',
        fromStatus: 'draft',
        toStatus: 'awaiting_payment',
        actorKind: 'guest',
        actorGuestId: draft.guestId,
      }),
      PG.restrictViolation,
    );
  });

  it('refuses an actor kind the transition does not allow', async () => {
    const draft = await frozenOrder();

    // A customer does not start production. (And a *staff* member being allowed to is a
    // necessary condition and not authorisation — see the ownership block.)
    await expectViolation(
      move(draft.orderId, 'in_production', { actorKind: 'guest', actorGuestId: draft.guestId }),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓵ Trap 1 — the circular foreign key
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓵ an order and the event that put it there are inserted together', () => {
  it('cannot be inserted on its own — the cycle is real', async () => {
    const guestId = await createGuest();

    // This is the trap as the plan states it: both keys NOT NULL, and no order can be
    // created at all. The failure arrives at the implicit COMMIT of this single statement.
    await expectViolation(
      db.insert(orders).values({ statusEventId: randomUUID(), guestId }),
      PG.foreignKeyViolation,
    );
  });

  it('is inserted in one transaction, order first, event second', async () => {
    const draft = await createDraft();

    const [order] = await db
      .select({ statusEventId: orders.statusEventId })
      .from(orders)
      .where(eq(orders.id, draft.orderId));
    const [event] = await db
      .select({ id: orderEvents.id, seq: orderEvents.seq })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId));

    // The order side gave deferrability, not nullability: `status_event_id` is NOT NULL and
    // every reader may rely on it.
    expect(order?.statusEventId).toBe(event?.id);
    expect(event?.seq).toBe(1);
  });

  it('keeps status_event_id NOT NULL, which is the point of deferring instead of nulling', async () => {
    const column = await db.execute<{ is_nullable: string }>(sql`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'orders' and column_name = 'status_event_id'
    `);
    expect(column.rows[0]?.is_nullable).toBe('NO');

    const constraint = await db.execute<{ condeferrable: boolean; condeferred: boolean }>(sql`
      select condeferrable, condeferred from pg_constraint where conname = 'orders_status_event_fk'
    `);
    expect(constraint.rows[0]?.condeferrable).toBe(true);
    expect(constraint.rows[0]?.condeferred).toBe(true);
  });

  it('will not point at an event that belongs to another order, or to another status', async () => {
    const mine = await createDraft();
    const theirs = await createDraft();

    const [theirEvent] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, theirs.orderId));
    if (!theirEvent) throw new Error('no event to borrow');

    // The FK is composite — (status_event_id, id, status) → (id, order_id, to_status) — so
    // borrowing another order's event fails on the `order_id` column of the same key.
    await expectViolation(
      db.update(orders).set({ statusEventId: theirEvent.id }).where(eq(orders.id, mine.orderId)),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The freeze point — plan 7.5(ข)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the freeze point is a fact the database can see', () => {
  it('is stamped by the database on entry to production_confirmed', async () => {
    const draft = await createDraft({ contactEmail: `freeze-${tag}@example.test` });
    await submit(draft);

    const [before] = await db
      .select({ frozenAt: orders.frozenAt })
      .from(orders)
      .where(eq(orders.id, draft.orderId));
    expect(before?.frozenAt).toBeNull();

    // Nothing in `move()` writes `frozen_at`. The trigger does, which is what makes it
    // answerable after the status has become `cancelled` and can no longer say.
    await move(draft.orderId, 'production_confirmed');

    const [after] = await db
      .select({ frozenAt: orders.frozenAt })
      .from(orders)
      .where(eq(orders.id, draft.orderId));
    expect(after?.frozenAt).not.toBeNull();
  });

  it('will not be thawed, moved, or stamped twice', async () => {
    const order = await frozenOrder();
    const [frozen] = await db
      .select({ frozenAt: orders.frozenAt })
      .from(orders)
      .where(eq(orders.id, order.orderId));
    const firstFreeze = frozen?.frozenAt;

    await expectViolation(
      db.update(orders).set({ frozenAt: null }).where(eq(orders.id, order.orderId)),
      PG.restrictViolation,
    );

    // A redesign and a second entry into production is the ordinary path (plan 7.2), and it
    // must not re-date the freeze: the money rules are about the first one.
    await move(order.orderId, 'redesign', { payload: { reason: 'profile too thin' } });
    await move(order.orderId, 'production_confirmed', { payload: { absorbed_delta_thb_minor: 45000 } });

    const [after] = await db
      .select({ frozenAt: orders.frozenAt })
      .from(orders)
      .where(eq(orders.id, order.orderId));
    expect(after?.frozenAt?.getTime()).toBe(firstFreeze?.getTime());
  });

  it('keeps the freeze after the status can no longer say — a cancellation report needs it', async () => {
    const order = await frozenOrder();
    await move(order.orderId, 'cancelled', {
      payload: { reason: 'ลูกค้าเปลี่ยนใจ', fault: 'customer' },
      actorKind: 'guest',
      actorGuestId: order.guestId,
    });

    const [row] = await db
      .select({ status: orders.status, frozenAt: orders.frozenAt })
      .from(orders)
      .where(eq(orders.id, order.orderId));

    // `cancelled` is reachable from both sides of the freeze, which is exactly why the fact
    // worth storing is the stamp and not the status.
    expect(row?.status).toBe('cancelled');
    expect(row?.frozenAt).not.toBeNull();
  });

  it('makes draft and redesign opposites rather than synonyms', async () => {
    const guestId = await createGuest();

    // A draft with a contract is unrepresentable…
    await expectViolation(
      db.execute(sql`
        insert into orders (status_event_id, guest_id, status, submitted_at)
        values (gen_random_uuid(), ${guestId}, 'draft', now())
      `),
      PG.checkViolation,
    );

    // …and so is a redesign without one. Merge the two statuses and every "carts that have
    // not sold yet" query has to remember `AND document_id IS NULL` (plan 7.1).
    await expectViolation(
      db.execute(sql`
        insert into orders (status_event_id, guest_id, status)
        values (gen_random_uuid(), ${guestId}, 'redesign')
      `),
      PG.restrictViolation,
    );
  });

  /**
   * The `cashflow` approval floor is a term of the contract, so a cart cannot carry one.
   *
   * `deposit_floor_bp` (migration `0034`) records the `organisation_profile.deposit_bp` an order
   * was judged against at submit, because reading the live setting made a historical order report
   * a concession against *today's* policy — the same retroactive re-interpretation
   * `approvals.decided_ceiling_thb_minor` closed on the ceiling side.
   *
   * ⚠️ It is deliberately **not** in `orders_submitted_shape`, and that is the interesting half.
   * That constraint is an `=` between two nullabilities; every order submitted before this column
   * existed would violate it, and `0034` refused to invent a floor for them. So the rule is
   * one-way — a floor implies a contract, a contract does not imply a floor — and this is the
   * test that says so, in both directions, rather than leaving the weaker form to look like an
   * oversight.
   */
  it('lets only a contract carry a deposit floor, and never invents one for the orders that predate it', async () => {
    const guestId = await createGuest();

    // A cart with a floor is unrepresentable: there is no contract for it to be a term of.
    await expectViolation(
      db.execute(sql`
        insert into orders (status_event_id, guest_id, deposit_floor_bp)
        values (gen_random_uuid(), ${guestId}, 3000)
      `),
      PG.checkViolation,
    );

    // …and so is a floor that is not a percentage. 1, not 0 — a zero floor is a schedule with
    // no gate, which is `payments/schedule`'s business and not a value of this column.
    const submitted = await createDraft({ contactEmail: `floor-${tag}@example.test` });
    await submit(submitted);

    await expectViolation(
      db.execute(
        sql`update orders set deposit_floor_bp = 0 where id = ${submitted.orderId}::uuid`,
      ),
      PG.checkViolation,
    );
    await expectViolation(
      db.execute(
        sql`update orders set deposit_floor_bp = 10001 where id = ${submitted.orderId}::uuid`,
      ),
      PG.checkViolation,
    );

    /*
     * And a submitted order with NO floor is legal, and has to be: it is every order in every
     * database that predates the column, and a backfill would be a business fact nobody
     * recorded. `submit` above pins the seven things and not this one, so this asserts the
     * schema rather than restating the fixture.
     */
    const [row] = await db
      .select({ submittedAt: orders.submittedAt, floorBp: orders.depositFloorBp })
      .from(orders)
      .where(eq(orders.id, submitted.orderId));

    expect(row?.submittedAt).not.toBeNull();
    expect(row?.floorBp).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓶ Trap 2 — ownership is the query, and the database is the backstop
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓶ an order belongs to somebody, and the actor has to be them', () => {
  it('cannot exist without an owner, so no scoped query can miss it', async () => {
    await expectViolation(
      db.execute(sql`insert into orders (status_event_id) values (gen_random_uuid())`),
      PG.checkViolation,
    );
  });

  it('is loaded by a query that carries the scope', async () => {
    const owner = await createUser(`owner ${tag}`);
    const stranger = await createUser(`stranger ${tag}`);
    const draft = await createDraft({ userId: owner });

    // This is the shape plan 7.4 trap 2 asks for: ownership in the WHERE clause, not in a
    // check after the row has been loaded.
    const asOwner = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, draft.orderId), eq(orders.customerUserId, owner)));
    const asStranger = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, draft.orderId), eq(orders.customerUserId, stranger)));

    expect(asOwner).toHaveLength(1);
    expect(asStranger).toHaveLength(0);
  });

  it('refuses an event by a customer who is not the customer — the day the WHERE clause is forgotten', async () => {
    const owner = await createUser(`owner ${tag}`);
    const stranger = await createUser(`stranger ${tag}`);
    const draft = await createDraft({ userId: owner, contactEmail: `owner-${tag}@example.test` });

    // `actors: ['customer']` says a customer may cancel. It does not say *this* customer,
    // and any signed-in customer who guessed the id would pass that check. This is the
    // backstop: the database compares the actor to the order's own owner.
    await expectViolation(
      db.insert(orderEvents).values({
        orderId: draft.orderId,
        eventType: 'cancelled',
        fromStatus: 'draft',
        toStatus: 'cancelled',
        actorKind: 'customer',
        actorUserId: stranger,
        payload: { reason: 'not mine to cancel' },
      }),
      PG.restrictViolation,
    );

    // The real owner is fine.
    await db.insert(orderEvents).values({
      orderId: draft.orderId,
      eventType: 'change_requested',
      actorKind: 'customer',
      actorUserId: owner,
    });
  });

  it('refuses an event by a guest who is not the guest', async () => {
    const draft = await createDraft();
    const otherGuest = await createGuest();

    await expectViolation(
      db.insert(orderEvents).values({
        orderId: draft.orderId,
        eventType: 'change_requested',
        actorKind: 'guest',
        actorGuestId: otherGuest,
      }),
      PG.restrictViolation,
    );
  });

  it('lets an anonymous visitor carry an order all the way through', async () => {
    // Plan 6: the guest is the main funnel, not an edge case. No user row exists anywhere
    // in this test until the order is delivered.
    const draft = await createDraft({ contactEmail: `guest-${tag}@example.test` });
    await submit(draft);
    await move(draft.orderId, 'production_confirmed');
    await move(draft.orderId, 'in_production');
    await move(draft.orderId, 'awaiting_installation');
    await move(draft.orderId, 'delivered');

    const [row] = await db
      .select({ status: orders.status, customerUserId: orders.customerUserId })
      .from(orders)
      .where(eq(orders.id, draft.orderId));
    expect(row?.status).toBe('delivered');
    expect(row?.customerUserId).toBeNull();
  });

  it('is claimed by signing in, and cannot then be claimed by anybody else', async () => {
    const draft = await createDraft();
    const first = await createUser(`first ${tag}`);
    const second = await createUser(`second ${tag}`);

    await db.update(orders).set({ customerUserId: first }).where(eq(orders.id, draft.orderId));

    const [row] = await db
      .select({ customerUserId: orders.customerUserId, guestId: orders.guestId })
      .from(orders)
      .where(eq(orders.id, draft.orderId));

    // Both, afterwards: the browser keeps sending the same guest cookie, and a cart that
    // stopped being findable at the moment of login is a cart lost as it converted.
    expect(row?.customerUserId).toBe(first);
    expect(row?.guestId).toBe(draft.guestId);

    await expectViolation(
      db.update(orders).set({ customerUserId: second }).where(eq(orders.id, draft.orderId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(orders).set({ guestId: await createGuest() }).where(eq(orders.id, draft.orderId)),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓷ Trap 3 — the pin between submit and accept
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓷ what the customer saw is pinned at submit and frozen afterwards', () => {
  it('pins a document and refuses to let it be edited', async () => {
    const draft = await createDraft({ contactEmail: `pin-${tag}@example.test` });
    await submit(draft);

    const [document] = await db
      .select()
      .from(orderDocuments)
      .where(eq(orderDocuments.orderId, draft.orderId));
    if (!document) throw new Error('nothing was pinned');

    expect(document.pinnedVatRateBp).toBe(700);
    expect(document.grandTotalThbMinor).toBe(GRAND);

    // Trap 3 is only closed if the pin cannot move. An editable pin is the same unprovable
    // document with more columns.
    await expectViolation(
      db
        .update(orderDocuments)
        .set({ grandTotalThbMinor: 1n })
        .where(eq(orderDocuments.id, document.id)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.delete(orderDocuments).where(eq(orderDocuments.id, document.id)),
      PG.restrictViolation,
    );
  });

  it('will not let the order and its own document disagree about the total', async () => {
    const draft = await createDraft({ contactEmail: `total-${tag}@example.test` });
    await submit(draft);

    // Plan 7.13: `grand_total_thb_minor` is the single base every instalment, forfeit and
    // refund reads. Two places to read one number is two answers unless something forbids it.
    await expectViolation(
      db
        .update(orders)
        .set({ netThbMinor: 1n, vatThbMinor: 0n, grandTotalThbMinor: 1n })
        .where(eq(orders.id, draft.orderId)),
      PG.restrictViolation,
    );
  });

  it('cites catalogue versions as published, and holds them there', async () => {
    const draft = await createDraft({ contactEmail: `cite-${tag}@example.test` });
    await submit(draft);
    const [document] = await db
      .select({ id: orderDocuments.id })
      .from(orderDocuments)
      .where(eq(orderDocuments.orderId, draft.orderId));
    if (!document) throw new Error('nothing was pinned');

    const productId = `order-test-${tag}`;
    await db.execute(sql`
      insert into categories (id, label_th, summary_th) values (${productId}, 'ทดสอบ', 'ทดสอบ')
    `);
    await db.execute(sql`
      insert into products (id, slug, sku_prefix, category_id, name_th, summary_th, hero_image,
                            lead_time_min_days, lead_time_max_days, price_per_sqm_minor,
                            min_billable_sq_um, elevation)
      values (${productId}, ${productId}, ${productId}, ${productId}, 'ทดสอบ', 'ทดสอบ', '/media/x',
              7, 14, 220000, 1000000, '{}'::jsonb)
    `);
    const draftVersion = await db.execute<{ id: string }>(sql`
      insert into product_versions (product_id, version, status, document, document_hash)
      values (${productId}, 1, 'draft', '{"schemaVersion":1}'::jsonb, 'x') returning id
    `);
    const versionId = draftVersion.rows[0]?.id;
    if (!versionId) throw new Error('could not create a version');

    // A contract priced from a document somebody was still editing is trap 3 again, one
    // table further in.
    await expectViolation(
      db.insert(orderDocumentProductVersions).values({
        orderDocumentId: document.id,
        productVersionId: versionId,
      }),
      PG.restrictViolation,
    );

    await db.execute(sql`delete from product_versions where id = ${versionId}`);
    await db.execute(sql`delete from products where id = ${productId}`);
    await db.execute(sql`delete from categories where id = ${productId}`);

    // The accepting half borrows a version the catalogue already published rather than
    // publishing one of its own: `product_versions_block_delete` (0001) makes a published
    // version undeletable — correctly — so a fixture that published one would leave a
    // product in the catalogue forever.
    const published = await db.execute<{ id: string }>(sql`
      select id from product_versions where status = 'published' limit 1
    `);
    const publishedId = published.rows[0]?.id;
    expect(publishedId, 'no published catalogue version to cite — run `pnpm db:seed`').toBeDefined();
    if (!publishedId) return;

    await db
      .insert(orderDocumentProductVersions)
      .values({ orderDocumentId: document.id, productVersionId: publishedId });

    // And the citation holds the version in place: ON DELETE RESTRICT, so a version a
    // contract was priced from can never be removed from under it.
    const rule = await db.execute<{ delete_rule: string }>(sql`
      select delete_rule from information_schema.referential_constraints
       where constraint_name = 'order_document_product_versions_product_version_id_product_versions_id_fk'
    `);
    expect(rule.rows[0]?.delete_rule).toBe('RESTRICT');

    // Cleaned up because `pnpm db:seed` truncates the catalogue with CASCADE and the guard
    // below would otherwise stop it — see the next test.
    await db
      .delete(orderDocumentProductVersions)
      .where(eq(orderDocumentProductVersions.orderDocumentId, document.id));
  });

  it('stops a catalogue re-seed from silently erasing what a contract was priced from', async () => {
    // `TRUNCATE … CASCADE` walks foreign keys and ignores ON DELETE RESTRICT. Without this
    // guard, `pnpm db:seed` on a database with contracts on it empties the citation table
    // and leaves every pinned document with its money and no provenance.
    const trigger = await db.execute<{ tgname: string }>(sql`
      select tgname from pg_trigger
       where tgrelid = 'order_document_product_versions'::regclass
         and tgname = 'order_document_versions_block_truncate'
    `);
    expect(trigger.rows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓸ Trap 4 — the payload the wrong schema strips
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓸ a post-freeze cancellation cannot lose the field that decides the refund', () => {
  it('refuses the cancellation when `fault` was stripped', async () => {
    const order = await frozenOrder();

    // This is the trap arriving at the database: the controller picked the pre-freeze zod
    // schema before loading the order, zod stripped `fault`, and the request is otherwise
    // perfectly well-formed. Plan 7.8 marks `fault` 🔒 — it decides how much money the
    // customer gets back, so its absence must never be a default in anybody's favour.
    await expectViolation(
      move(order.orderId, 'cancelled', {
        payload: { reason: 'changed my mind' },
        actorKind: 'guest',
        actorGuestId: order.guestId,
      }),
      PG.restrictViolation,
    );

    expect(await statusOf(order.orderId)).toBe('production_confirmed');

    await move(order.orderId, 'cancelled', {
      payload: { reason: 'changed my mind', fault: 'customer' },
      actorKind: 'guest',
      actorGuestId: order.guestId,
    });
    expect(await statusOf(order.orderId)).toBe('cancelled');
  });

  it('does not ask a pre-freeze cancellation for it', async () => {
    const draft = await createDraft({ contactEmail: `pre-${tag}@example.test` });
    await submit(draft);

    // Nothing has been committed to production, so there is no fault to apportion — and
    // demanding one would be inventing a decision nobody has to make.
    await move(draft.orderId, 'cancelled', {
      payload: { reason: 'ราคาสูงเกินไป' },
      actorKind: 'guest',
      actorGuestId: draft.guestId,
    });
    expect(await statusOf(draft.orderId)).toBe('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓹ Trap 5 — a change request with something that clears it
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓹ a customer can object more than once in the life of an order', () => {
  const openRequest = async (draft: Draft): Promise<string> => {
    const [event] = await db
      .insert(orderEvents)
      .values({
        orderId: draft.orderId,
        eventType: 'change_requested',
        actorKind: 'guest',
        actorGuestId: draft.guestId,
      })
      .returning({ id: orderEvents.id });
    if (!event) throw new Error('could not record the request');

    const [request] = await db
      .insert(orderChangeRequests)
      .values({ orderId: draft.orderId, openedEventId: event.id, noteTh: 'ขอเปลี่ยนสี' })
      .returning({ id: orderChangeRequests.id });
    if (!request) throw new Error('could not open the request');
    return request.id;
  };

  const resolve = async (draft: Draft, requestId: string): Promise<void> => {
    const [event] = await db
      .insert(orderEvents)
      .values({
        orderId: draft.orderId,
        eventType: 'change_resolved',
        actorKind: 'staff',
        actorUserId: staffUserId,
      })
      .returning({ id: orderEvents.id });
    if (!event) throw new Error('could not record the resolution');

    await db
      .update(orderChangeRequests)
      .set({ resolvedEventId: event.id, resolution: 'rejected', resolvedAt: new Date() })
      .where(eq(orderChangeRequests.id, requestId));
  };

  it('blocks a second open request and then unblocks when the first is answered', async () => {
    const draft = await createDraft({ contactEmail: `object-${tag}@example.test` });
    await submit(draft);

    const first = await openRequest(draft);

    // One at a time — the partial unique index. On its own this *is* trap 5: the first
    // request would block every later one for the lifetime of the order.
    await expectViolation(openRequest(draft), PG.uniqueViolation);

    // …which is why the resolution columns are the other half of the fix. Take them away
    // and the assertion above becomes the bug.
    await resolve(draft, first);
    const second = await openRequest(draft);
    expect(second).not.toBe(first);
  });

  it('holds the freeze while an objection is unanswered', async () => {
    const draft = await createDraft({ contactEmail: `hold-${tag}@example.test` });
    await submit(draft);
    const request = await openRequest(draft);

    // Plan 10.4: today a customer's only way to withhold consent is to not transfer money,
    // which strands the order forever because there is no timeout. So the objection holds
    // the freeze — and cannot strand it either, because `rejected` is a resolution.
    await expectViolation(move(draft.orderId, 'production_confirmed'), PG.restrictViolation);

    await resolve(draft, request);
    await move(draft.orderId, 'production_confirmed');
    expect(await statusOf(draft.orderId)).toBe('production_confirmed');
  });

  it('cannot be half-resolved', async () => {
    const draft = await createDraft({ contactEmail: `half-${tag}@example.test` });
    await submit(draft);
    const request = await openRequest(draft);

    await expectViolation(
      db.update(orderChangeRequests).set({ resolution: 'accepted' }).where(eq(orderChangeRequests.id, request)),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓺ Trap 6 — a status guard that forbids the write instead of ordering the race
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓺ a child row cannot be written against an order that moved on', () => {
  it('refuses outright when the order is no longer live', async () => {
    const draft = await createDraft({ contactEmail: `late-${tag}@example.test` });
    await submit(draft);
    await move(draft.orderId, 'cancelled', {
      payload: { reason: 'gone' },
      actorKind: 'guest',
      actorGuestId: draft.guestId,
    });

    const [event] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId));
    if (!event) throw new Error('no event');

    await expectViolation(
      db.insert(orderChangeRequests).values({ orderId: draft.orderId, openedEventId: event.id }),
      PG.restrictViolation,
    );
  });

  it('loses the race it was already in — the half `FOR UPDATE` does not buy', async () => {
    const draft = await createDraft({ contactEmail: `race-${tag}@example.test` });
    await submit(draft);
    const [seed] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId));
    if (!seed) throw new Error('no event');

    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('begin');
      // The transition, doing everything right: it takes the row lock first.
      await a.query('select id from orders where id = $1 for update', [draft.orderId]);
      const cancelEvent = randomUUID();
      await a.query(
        `insert into order_events (id, order_id, event_type, from_status, to_status, actor_kind, actor_guest_id, payload)
         values ($1, $2, 'cancelled', 'awaiting_payment', 'cancelled', 'guest', $3, '{"reason":"race"}'::jsonb)`,
        [cancelEvent, draft.orderId, draft.guestId],
      );
      await a.query('update orders set status = $1, status_event_id = $2 where id = $3', [
        'cancelled',
        cancelEvent,
        draft.orderId,
      ]);

      // B arrives while A is still open. Its snapshot says `awaiting_payment`, so a guard
      // that merely *read* the status would pass and insert. This one takes `FOR SHARE` on
      // the same row, so it blocks instead of reading a stale answer.
      await b.query('begin');
      let settled = false;
      const blocked = b
        .query('insert into order_change_requests (order_id, opened_event_id) values ($1, $2)', [
          draft.orderId,
          seed.id,
        ])
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

      /*
       * ⚠️ This wait is the test, and it was added because mutation testing found the test
       * passing for the wrong reason without it.
       *
       * `b.query(...)` returns a promise immediately; the statement itself is dispatched on
       * the event loop. Committing A straight away let the commit land *first* often enough
       * that B took a snapshot which already contained the cancellation — so the trigger
       * refused for an ordinary reason, the assertion passed, and removing `FOR SHARE`
       * changed nothing. The version below waits until Postgres itself reports a backend
       * waiting on another backend, and asserts B has not finished, so the refusal below
       * can only come from re-reading the row *after* the lock was released.
       */
      await waitForBlockedBackend();
      expect(settled, 'B finished before A committed — the race was not exercised').toBe(false);

      await a.query('commit');

      // …and when the lock is released it re-reads the row as A left it, and refuses.
      // `FOR UPDATE` in the transition ordered the race; only this forbids the write.
      expect(errorCode(await blocked)).toBe(PG.restrictViolation);
    } finally {
      await b.query('rollback').catch(() => undefined);
      a.release();
      b.release();
    }

    const requests = await db
      .select({ id: orderChangeRequests.id })
      .from(orderChangeRequests)
      .where(eq(orderChangeRequests.orderId, draft.orderId));
    expect(requests).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓻ Trap 7's structural half — a revision that has somewhere to carry money to
// ─────────────────────────────────────────────────────────────────────────────

describeDb('⓻ superseding requires a successor, and the chain cannot be rewritten', () => {
  it('refuses to supersede an order into nothing', async () => {
    const order = await frozenOrder();
    await move(order.orderId, 'redesign', { payload: { reason: 'ทำไม่ได้' } });

    // Without a successor, `superseded` is a cancellation wearing a better word — and the
    // money already received would have nowhere to be carried to (plan 7.8, trap 7).
    await expectViolation(
      move(order.orderId, 'superseded', { payload: { reason: 'ส่วนต่างสูงเกินไป' } }),
      PG.restrictViolation,
    );

    const revision = await createDraft({ contactEmail: `rev-${tag}@example.test` });
    await db
      .update(orders)
      .set({ supersedesOrderId: order.orderId })
      .where(eq(orders.id, revision.orderId))
      .then(
        () => {
          throw new Error('the chain should be fixed at insert');
        },
        () => undefined,
      );

    // So a revision names its predecessor when it is created, and never afterwards: a
    // pointer set later is the only way to build a cycle, and a cycle would hang the
    // ancestor walk 5b's money fold depends on.
    const successorId = randomUUID();
    const successorEvent = randomUUID();
    const guestId = await createGuest();
    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: successorId,
        statusEventId: successorEvent,
        guestId,
        supersedesOrderId: order.orderId,
        contactEmail: `successor-${tag}@example.test`,
      });
      await tx.insert(orderEvents).values({
        id: successorEvent,
        orderId: successorId,
        eventType: 'created',
        toStatus: 'draft',
        actorKind: 'guest',
        actorGuestId: guestId,
      });
    });

    await move(order.orderId, 'superseded', { payload: { reason: 'ส่วนต่างสูงเกินไป' } });
    expect(await statusOf(order.orderId)).toBe('superseded');
  });

  it('refuses a revision of an order that was never frozen', async () => {
    const draft = await createDraft({ contactEmail: `never-${tag}@example.test` });
    const guestId = await createGuest();

    // Before the freeze the quote is edited in place (plan 7.5(ง)); a "revision" of a
    // draft would just be a second cart, and two carts is two answers to what was agreed.
    await expectViolation(
      db.insert(orders).values({
        statusEventId: randomUUID(),
        guestId,
        supersedesOrderId: draft.orderId,
      }),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The spine is append-only
// ─────────────────────────────────────────────────────────────────────────────

describeDb('order_events is append-only, the way a published document is', () => {
  it('refuses every edit', async () => {
    const draft = await createDraft({ contactEmail: `append-${tag}@example.test` });
    await submit(draft);

    const [event] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId));
    if (!event) throw new Error('no event');

    await expectViolation(
      db.update(orderEvents).set({ payload: { rewritten: true } }).where(eq(orderEvents.id, event.id)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.delete(orderEvents).where(eq(orderEvents.id, event.id)),
      PG.restrictViolation,
    );
  });

  it('numbers events itself, in order, from one', async () => {
    const draft = await createDraft({ contactEmail: `seq-${tag}@example.test` });
    await submit(draft);
    await move(draft.orderId, 'production_confirmed');
    await move(draft.orderId, 'in_production');

    const events = await db
      .select({ seq: orderEvents.seq, type: orderEvents.eventType })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId))
      .orderBy(orderEvents.seq);

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.type)).toEqual([
      'created',
      'submitted_for_payment',
      'payment_confirmed',
      'production_started',
    ]);
  });

  it('will not let a child row borrow another order’s event', async () => {
    const mine = await createDraft({ contactEmail: `mine-${tag}@example.test` });
    const theirs = await createDraft({ contactEmail: `theirs-${tag}@example.test` });
    await submit(mine);
    await submit(theirs);

    const [theirEvent] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, theirs.orderId));
    if (!theirEvent) throw new Error('no event to borrow');

    // Every table that names both an order and an event names them through one composite
    // key, so "these two are the same order's" is a fact Postgres checks. A change request
    // resolved on somebody else's spine would answer an objection nobody made — and leave
    // this order's open forever.
    await expectViolation(
      db.insert(orderChangeRequests).values({ orderId: mine.orderId, openedEventId: theirEvent.id }),
      PG.foreignKeyViolation,
    );

    await expectViolation(
      db.insert(orderDocuments).values({
        orderId: mine.orderId,
        revision: 99,
        document: { lines: [] },
        documentHash: 'f'.repeat(64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        createdByEventId: theirEvent.id,
      }),
      PG.foreignKeyViolation,
    );
  });

  it('lets an abandoned cart be swept, and refuses to sweep a contract', async () => {
    const cart = await createDraft();
    await db.delete(orders).where(eq(orders.id, cart.orderId));

    const leftovers = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, cart.orderId));
    expect(leftovers).toHaveLength(0);

    const sold = await createDraft({ contactEmail: `sold-${tag}@example.test` });
    await submit(sold);
    await expectViolation(db.delete(orders).where(eq(orders.id, sold.orderId)), PG.restrictViolation);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The outbox — plan 10
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the outbox is written by the event, in the event’s own transaction', () => {
  const outboxFor = async (orderId: string) =>
    db
      .select()
      .from(notifications)
      .where(eq(notifications.orderId, orderId))
      .orderBy(notifications.recipientKind);

  it('queues the messages the spine implies, without anybody calling sendEmail()', async () => {
    const draft = await createDraft({ contactEmail: `outbox-${tag}@example.test` });
    await submit(draft);

    const queued = await outboxFor(draft.orderId);

    // Plan 10.3, as data: the customer is told, and sales is told, and neither is a call
    // site anybody could forget to add.
    expect(queued.map((row) => row.recipientKind)).toEqual(['customer', 'sales_queue']);
    expect(queued[0]?.recipientKey).toBe(`email:outbox-${tag}@example.test`);
    expect(queued[0]?.status).toBe('pending');
    expect(queued[0]?.templateKey).toBe('order.submitted_for_payment.customer');
  });

  it('commits with the event or not at all', async () => {
    const draft = await createDraft({ contactEmail: `atomic-${tag}@example.test` });
    await submit(draft);

    const before = (await outboxFor(draft.orderId)).length;

    // A transition that fails after the event was written takes the outbox rows with it.
    // The other direction is what plan 10.1 warns about: a state change that commits with
    // nobody told, or an SMTP timeout that rolls a state change back.
    await db
      .transaction(async (tx) => {
        await tx.insert(orderEvents).values({
          orderId: draft.orderId,
          eventType: 'quote_revised',
          actorKind: 'staff',
          actorUserId: staffUserId,
        });
        throw new Error('the transition failed after the event was appended');
      })
      .catch(() => undefined);

    expect(await outboxFor(draft.orderId)).toHaveLength(before);
  });

  it('addresses the message from the order the transaction finally left', async () => {
    // The statement order inside a submit is forced: the document names the event, and the
    // order names the document, so the event is written before the order is updated. An
    // immediate fan-out would therefore resolve the recipient from the *pre-submit* row —
    // and here that row has no contact channel at all, so the customer would be told
    // nothing, visibly but wrongly, because of the order of statements inside a service.
    //
    // This is the test that fails if `order_events_fan_out_notifications` stops being a
    // DEFERRABLE INITIALLY DEFERRED constraint trigger.
    const draft = await createDraft();
    const address = `deferred-${tag}@example.test`;
    const eventId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(orderEvents).values({
        id: eventId,
        orderId: draft.orderId,
        eventType: 'submitted_for_payment',
        fromStatus: 'draft',
        toStatus: 'awaiting_payment',
        actorKind: 'guest',
        actorGuestId: draft.guestId,
      });

      const [document] = await tx
        .insert(orderDocuments)
        .values({
          orderId: draft.orderId,
          revision: 1,
          document: { lines: [] },
          documentHash: '1'.repeat(64),
          pinnedCoreVersion: '1.0.0',
          pinnedVatRateBp: 700,
          pinnedVatTreatment: 'standard',
          pinnedLocale: 'th',
          netThbMinor: NET,
          vatThbMinor: VAT,
          grandTotalThbMinor: GRAND,
          createdByEventId: eventId,
        })
        .returning({ id: orderDocuments.id });
      if (!document) throw new Error('could not pin a document');

      await tx
        .update(orders)
        .set({
          status: 'awaiting_payment',
          statusEventId: eventId,
          // The database's clock, for the reason given on the `submit` helper above.
          submittedAt: sql`now()`,
          orderNo: sql`'WW-' || nextval('order_no_seq')`,
          documentId: document.id,
          contactEmail: address,
          netThbMinor: NET,
          vatThbMinor: VAT,
          grandTotalThbMinor: GRAND,
          scheduledDepositThbMinor: DEPOSIT,
        })
        .where(eq(orders.id, draft.orderId));
    });

    const queued = await outboxFor(draft.orderId);
    const toCustomer = queued.find((row) => row.recipientKind === 'customer');
    expect(toCustomer?.status).toBe('pending');
    expect(toCustomer?.recipientKey).toBe(`email:${address}`);
  });

  it('cannot be written by hand — not for an old event…', async () => {
    const draft = await createDraft({ contactEmail: `hand-${tag}@example.test` });
    await submit(draft);
    const [event] = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.orderId, draft.orderId));
    if (!event) throw new Error('no event');

    // A worker queueing a message an hour later against an event that committed long ago is
    // exactly the failure the outbox exists to prevent, arriving through the back door.
    await expectViolation(
      db.execute(sql`
        insert into notifications (order_id, event_id, latest_event_id, recipient_kind, recipient_key, channel, template_key)
        values (${draft.orderId}, ${event.id}, ${event.id}, 'customer', 'email:x@example.test', 'email', 'order.delivered.customer')
      `),
      PG.restrictViolation,
    );
  });

  it('…nor for one written a moment ago in the same transaction', async () => {
    const draft = await createDraft({ contactEmail: `hand2-${tag}@example.test` });

    // The second guard, and a different failure: the transaction is right, but the row came
    // from a service rather than from the spine. Producing outbox rows by hand is
    // `sendEmail()` in a transition handler wearing a table.
    await expectViolation(
      db.transaction(async (tx) => {
        const [event] = await tx
          .insert(orderEvents)
          .values({
            orderId: draft.orderId,
            eventType: 'quote_revised',
            actorKind: 'staff',
            actorUserId: staffUserId,
          })
          .returning({ id: orderEvents.id });
        if (!event) throw new Error('no event');

        await tx.execute(sql`
          insert into notifications (order_id, event_id, latest_event_id, recipient_kind, recipient_key, channel, template_key)
          values (${draft.orderId}, ${event.id}, ${event.id}, 'customer', 'email:x@example.test', 'email', 'order.quote_revised.customer')
        `);
      }),
      PG.restrictViolation,
    );
  });

  it('folds a storm of edits into one message — plan 10.5(2)', async () => {
    const draft = await createDraft({ contactEmail: `storm-${tag}@example.test` });
    await submit(draft);

    for (let edit = 0; edit < 5; edit += 1) {
      await db.insert(orderEvents).values({
        orderId: draft.orderId,
        eventType: 'quote_revised',
        actorKind: 'staff',
        actorUserId: staffUserId,
        payload: { edit },
      });
    }

    const revisions = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.orderId, draft.orderId), eq(notifications.templateKey, 'order.quote_revised.customer')),
      );

    // Five edits in ten minutes are one message. The window starts at the first event, so
    // it cannot recede for as long as somebody keeps typing.
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.coalescedCount).toBe(4);
    expect(revisions[0]?.status).toBe('pending');

    const events = await db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, draft.orderId), eq(orderEvents.eventType, 'quote_revised')))
      .orderBy(orderEvents.seq);

    // The idempotency key stays the *first* event; the renderer follows `latest_event_id`.
    expect(revisions[0]?.eventId).toBe(events[0]?.id);
    expect(revisions[0]?.latestEventId).toBe(events[4]?.id);
  });

  it('makes an unreachable customer a visible row rather than a silence — plan 10.5(3)', async () => {
    // Plan 10.2's funnel leak: a quote with no channel on it is a quote nobody can be told
    // anything about. Submitting requires a channel; a draft does not have one yet.
    const draft = await createDraft();

    await db.insert(orderEvents).values({
      orderId: draft.orderId,
      eventType: 'quote_revised',
      actorKind: 'staff',
      actorUserId: staffUserId,
    });

    const queued = await outboxFor(draft.orderId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('suppressed');
    expect(queued[0]?.suppressedReason).toBe('no_contact_channel');
    expect(queued[0]?.recipientKey).toBeNull();
  });

  it('keeps `dead` a state with a date on it, and the attempts that led there', async () => {
    const draft = await createDraft({ contactEmail: `dead-${tag}@example.test` });
    await submit(draft);
    const [queued] = await outboxFor(draft.orderId);
    if (!queued) throw new Error('nothing queued');

    // A failure with no reason is how `dead` becomes silent, which is the state plan
    // 10.5(3) says must surface in a queue somebody looks at.
    await expectViolation(
      db.insert(notificationAttempts).values({
        notificationId: queued.id,
        attemptNo: 1,
        outcome: 'failed',
        channel: 'email',
        recipientKey: queued.recipientKey ?? 'email:x@example.test',
        locale: 'th',
      }),
      PG.checkViolation,
    );

    await db.insert(notificationAttempts).values({
      notificationId: queued.id,
      attemptNo: 1,
      outcome: 'failed',
      channel: 'email',
      recipientKey: queued.recipientKey ?? 'email:x@example.test',
      locale: 'th',
      error: 'smtp: connection refused',
    });

    await expectViolation(
      db.update(notifications).set({ status: 'dead' }).where(eq(notifications.id, queued.id)),
      PG.checkViolation,
    );

    await db
      .update(notifications)
      .set({ status: 'dead', deadAt: new Date(), attemptCount: 5, lastError: 'smtp: connection refused' })
      .where(eq(notifications.id, queued.id));

    // The attempt log is evidence: `last_error` remembers the most recent failure, a
    // dispute asks about all five.
    await expectViolation(
      db.delete(notificationAttempts).where(eq(notificationAttempts.notificationId, queued.id)),
      PG.restrictViolation,
    );
  });

  it('keys idempotency on (event, recipient, channel), nulls included', async () => {
    // Plan 10.5(1). The constraint cannot be provoked from outside — the fan-out is the
    // only producer and an event is fanned out once — so it is asserted where it lives.
    // `NULLS NOT DISTINCT` is the part worth pinning: a suppressed row has no recipient,
    // and under the default rule two nulls never collide.
    const constraint = await db.execute<{ columns: string; nulls_not_distinct: boolean }>(sql`
      select (
               select string_agg(a.attname, ',' order by k.ord)
                 from unnest(c.conkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
             ) as columns,
             i.indnullsnotdistinct as nulls_not_distinct
        from pg_constraint c
        join pg_index i on i.indexrelid = c.conindid
       where c.conname = 'notifications_idempotency_key'
    `);
    expect(constraint.rows[0]?.columns).toBe('event_id,recipient_key,channel');
    expect(constraint.rows[0]?.nulls_not_distinct).toBe(true);
  });
});
