import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import {
  orderDocuments,
  orderEvents,
  orderInstalments,
  orders,
  paymentSlips,
  slipAllocations,
  users,
  guests,
  type OrderStatus,
} from '@wewin/db/schema';
import { divRoundHalfUp } from '@wewin/core/money';
import { toBigInt } from '@wewin/contract/exact';
import { encodeThb } from '@wewin/contract/order';

import { AppError } from '../../../src/common/errors/app-error';
import type { Tx } from '../../../src/orders/order.repository';
import { ScheduleRepository } from '../../../src/payments/schedule/schedule.repository';
import { ScheduleService } from '../../../src/payments/schedule/schedule.service';
import { depositPercentTerms, payInFullTerms } from '../../../src/payments/schedule/terms';

/**
 * The schedule service against a real Postgres, because the properties it is built on are
 * not properties of the arithmetic.
 *
 * Three of them, and none is observable from a unit test:
 *
 *   **The database is the backstop for the lock.** `plan.test.ts` proves the planner freezes
 *   a paid instalment. This file proves that a caller who bypasses the planner is refused
 *   anyway — `order_instalments_guard_write()` raises, and the service translates it. Two
 *   independent defences, and a test that only exercised the first would be evidence for
 *   neither.
 *
 *   **The footing assertion runs where the mistake was made.** The three constraint triggers
 *   are DEFERRED, so left alone they fire at COMMIT in somebody else's stack frame. The
 *   service calls `assert_order_schedule()` directly at the end of every write, which is why
 *   recomputing before the new total has been written fails *here* rather than at commit.
 *
 *   **The frontier is the SQL function.** `settledThrough` is read from
 *   `order_settled_through()` and this module contains no second implementation of it, so
 *   the only way to test it is to allocate real money against a real slip.
 *
 * Rows are not cleaned up. A submitted order cannot be deleted and an accepted slip is
 * evidence; a teardown able to remove either would contradict the schema under test.
 * `tests/globalSetup.ts` drops the database instead.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** Plan 7.8's order: ฿18,432 VAT-inclusive, 30% deposit is ฿5,529.60. */
const GRAND = 1_843_200n;
const DEPOSIT = divRoundHalfUp(GRAND * 3_000n, 10_000n);

let pool: Pool;
let db: Database;
let reviewer: string;

const service = new ScheduleService(new ScheduleRepository());
const repository = new ScheduleRepository();

interface Order {
  readonly orderId: string;
  readonly guestId: string;
}

const createUser = async (name: string): Promise<string> => {
  const [user] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!user) throw new Error('could not create a user');
  return user.id;
};

/** A submitted order with its totals pinned — the state a schedule is written in. */
const submittedOrder = async (grand: bigint = GRAND): Promise<Order> => {
  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');

  const orderId = randomUUID();
  const createdEventId = randomUUID();
  const submitEventId = randomUUID();
  const net = divRoundHalfUp(grand * 10_000n, 10_700n);

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: createdEventId,
      guestId: guest.id,
      contactEmail: `schedule-${randomUUID().slice(0, 8)}@probe.invalid`,
    });
    await tx.insert(orderEvents).values({
      id: createdEventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guest.id,
    });

    await tx.insert(orderEvents).values({
      id: submitEventId,
      orderId,
      eventType: 'submitted_for_payment',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorKind: 'guest',
      actorGuestId: guest.id,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId,
        revision: 1,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: net,
        vatThbMinor: grand - net,
        grandTotalThbMinor: grand,
        createdByEventId: submitEventId,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a document');

    await tx
      .update(orders)
      .set({
        status: 'awaiting_payment',
        statusEventId: submitEventId,
        submittedAt: new Date(),
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: document.id,
        netThbMinor: net,
        vatThbMinor: grand - net,
        grandTotalThbMinor: grand,
        /*
         * The pin, at 30% — a term of the contract and not a copy of the schedule.
         *
         * It is pinned low here on purpose. `orders_scheduled_deposit_within_total` refuses a
         * pin above the total, so an order pinned at 100% cannot ever be repriced downward,
         * and the refund path below would fail on the `orders` UPDATE before this module was
         * ever reached. That is a real property of the schema and worth knowing: pinning the
         * whole total as the deposit obligation makes a price *reduction* unrepresentable.
         */
        scheduledDepositThbMinor: divRoundHalfUp(grand * 3_000n, 10_000n),
      })
      .where(eq(orders.id, orderId));
  });

  return { orderId, guestId: guest.id };
};

/**
 * A 5c-shaped repricing: a new frozen revision, the new totals on the order, then the
 * recompute — in that order, which is the order this service documents and requires.
 *
 * The revision is not decoration. `orders_totals_match_document()` refuses an order whose
 * totals do not match its pinned document, so "change the total" is never one statement, and
 * a test that pretended otherwise would be testing a state the schema cannot hold.
 */
const repriceTo = async (orderId: string, grand: bigint): Promise<void> => {
  const net = divRoundHalfUp(grand * 10_000n, 10_700n);
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ revision: orderDocuments.revision })
      .from(orderDocuments)
      .where(eq(orderDocuments.orderId, orderId))
      .orderBy(sql`revision desc`)
      .limit(1);

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'quote_revised',
      actorKind: 'staff',
      actorUserId: reviewer,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId,
        revision: (current?.revision ?? 1) + 1,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: net,
        vatThbMinor: grand - net,
        grandTotalThbMinor: grand,
        createdByEventId: eventId,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a revision');

    await tx
      .update(orders)
      .set({
        documentId: document.id,
        netThbMinor: net,
        vatThbMinor: grand - net,
        grandTotalThbMinor: grand,
      })
      .where(eq(orders.id, orderId));

    await service.recompute({ tx: tx as Tx, orderId, status: 'awaiting_payment', grandTotalThbMinor: grand });
  });
};

/** An accepted slip allocated to one instalment — the only way money touches a schedule. */
const payInstalment = async (orderId: string, instalmentId: string, amount: bigint): Promise<void> => {
  await db.transaction(async (tx) => {
    const [slip] = await tx
      .insert(paymentSlips)
      .values({
        orderId,
        amountThbMinor: amount,
        transferredAt: new Date(),
        bankReference: `REF-${tag}-${randomUUID().slice(0, 6)}`,
        status: 'accepted',
        reviewedByUserId: reviewer,
        reviewedAt: new Date(),
      })
      .returning({ id: paymentSlips.id });
    if (!slip) throw new Error('could not record a slip');

    await tx
      .insert(slipAllocations)
      .values({ slipId: slip.id, instalmentId, amountThbMinor: amount });
  });
};

const instalmentsOf = async (
  orderId: string,
): Promise<readonly { seq: number; basis: string; dueThbMinor: bigint; id: string }[]> =>
  db
    .select({
      id: orderInstalments.id,
      seq: orderInstalments.seq,
      basis: orderInstalments.basis,
      dueThbMinor: orderInstalments.dueThbMinor,
    })
    .from(orderInstalments)
    .where(eq(orderInstalments.orderId, orderId))
    .orderBy(orderInstalments.seq);

const failureOf = async (run: () => Promise<unknown>): Promise<AppError> => {
  const caught = await run().then(
    () => undefined,
    (error: unknown) => error,
  );

  if (!(caught instanceof AppError)) {
    throw new Error(`expected an AppError, got: ${String(caught)}`);
  }
  return caught;
};

/**
 * The driver error under drizzle's wrapper — the same cause walk `pg-errors.ts` does.
 *
 * Reading `.code` off the top sees `undefined` for every trigger in the system, because
 * drizzle rethrows as `DrizzleQueryError` and keeps the real error on `.cause`.
 */
const pgErrorOf = (error: unknown): { code: string; where: string | undefined } | undefined => {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current && typeof (current as { code: unknown }).code === 'string') {
      const { code, where } = current as { code: string; where?: unknown };
      return { code, where: typeof where === 'string' ? where : undefined };
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }
  return undefined;
};

const detailsOf = (error: AppError): Record<string, unknown> =>
  typeof error.details === 'object' && error.details !== null
    ? (error.details as Record<string, unknown>)
    : {};

const open = (order: Order, terms = payInFullTerms(), status: OrderStatus = 'awaiting_payment') =>
  db.transaction(async (tx) =>
    service.open(
      { tx: tx as Tx, orderId: order.orderId, status, grandTotalThbMinor: GRAND },
      terms,
    ),
  );

describeWithPg('the instalment schedule, against Postgres', () => {
  beforeAll(async () => {
    if (url === undefined) throw new Error('unreachable: the suite is skipped without a database');
    pool = createPool(url);
    db = createDatabase(pool);
    reviewer = await createUser(`slip reviewer ${tag}`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('opens payment in full as one remainder instalment, and the database accepts it', async () => {
    const order = await submittedOrder();

    const instalments = await open(order);

    expect(instalments).toHaveLength(1);
    expect(await instalmentsOf(order.orderId)).toEqual([
      { id: expect.any(String), seq: 1, basis: 'remainder', dueThbMinor: GRAND },
    ]);
  });

  it('refuses to open a schedule twice, and refuses one on a status that cannot be edited', async () => {
    const order = await submittedOrder();
    await open(order);

    const twice = await failureOf(() => open(order));
    expect(detailsOf(twice)['reason']).toBe('schedule_exists');

    const other = await submittedOrder();
    const frozen = await failureOf(() => open(other, payInFullTerms(), 'in_production'));
    expect(detailsOf(frozen)['reason']).toBe('order_not_editable');
    /* `redesign` is in the editable list, and that is the one plan 7.5(ง) says gets forgotten. */
    expect(detailsOf(frozen)['editableStatuses']).toEqual(['draft', 'awaiting_payment', 'redesign']);
  });

  it('replaces a schedule with a 30/70 that foots to the satang', async () => {
    const order = await submittedOrder();
    await open(order);

    await db.transaction(async (tx) =>
      service.replace(
        { tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND },
        depositPercentTerms(3_000),
      ),
    );

    const rows = await instalmentsOf(order.orderId);
    expect(rows.map((instalment) => instalment.dueThbMinor)).toEqual([DEPOSIT, GRAND - DEPOSIT]);
    expect(rows.reduce((sum, instalment) => sum + instalment.dueThbMinor, 0n)).toBe(GRAND);
  });

  it('reports the frontier from order_settled_through(), and it is a seq', async () => {
    const order = await submittedOrder();
    await db.transaction(async (tx) =>
      service.replace(
        { tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND },
        depositPercentTerms(3_000),
      ),
    );

    const before = await db.transaction((tx) => repository.settledThrough(tx as Tx, order.orderId));
    /* Nothing settled: `MIN(seq) - 1`, which is 0 on a dense schedule and is not `null`. */
    expect(before).toBe(0);

    const [deposit] = await instalmentsOf(order.orderId);
    if (!deposit) throw new Error('no deposit instalment');
    await payInstalment(order.orderId, deposit.id, DEPOSIT);

    expect(await db.transaction((tx) => repository.settledThrough(tx as Tx, order.orderId))).toBe(1);

    const view = await db.transaction((tx) =>
      service.view({ tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND }),
    );
    expect(view.settledThroughSeq).toBe(1);
    expect(view.instalments[0]?.isLocked).toBe(true);
    /* A remainder is never locked, even when money has been allocated to it. */
    expect(view.instalments[1]?.isLocked).toBe(false);
    expect(toBigInt(view.scheduledDepositThbMinor)).toBe(DEPOSIT);
  });

  it('freezes the paid instalment and lets the remainder absorb a price rise', async () => {
    const order = await submittedOrder();
    await db.transaction(async (tx) =>
      service.replace(
        { tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND },
        depositPercentTerms(3_000),
      ),
    );

    const [deposit] = await instalmentsOf(order.orderId);
    if (!deposit) throw new Error('no deposit instalment');
    await payInstalment(order.orderId, deposit.id, DEPOSIT);

    const raised = GRAND + 500_000n;
    await repriceTo(order.orderId, raised);

    const rows = await instalmentsOf(order.orderId);
    expect(rows.map((instalment) => instalment.dueThbMinor)).toEqual([DEPOSIT, raised - DEPOSIT]);
    /* 30% of the new total would be more. The paid row does not follow the price. */
    expect(divRoundHalfUp(raised * 3_000n, 10_000n)).toBeGreaterThan(DEPOSIT);
  });

  /**
   * The database is the backstop, and this is the evidence.
   *
   * The planner is bypassed entirely: the repository is asked to move a paid instalment's
   * amount directly, which is what any future caller that forgets to go through
   * `recompute()` will do. `order_instalments_guard_write()` raises `restrict_violation` and
   * the order-error translator turns it into a 409. Remove that trigger and this test is the
   * one that goes green when it should not.
   */
  it('refuses a direct write to a paid instalment, in the database', async () => {
    const order = await submittedOrder();
    await db.transaction(async (tx) =>
      service.replace(
        { tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND },
        depositPercentTerms(3_000),
      ),
    );

    const [deposit] = await instalmentsOf(order.orderId);
    if (!deposit) throw new Error('no deposit instalment');
    await payInstalment(order.orderId, deposit.id, DEPOSIT);

    const caught = await db
      .transaction(async (tx) => {
        await repository.updateDue(tx as Tx, deposit.id, DEPOSIT + 1n);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    /*
     * The raw driver error surfaces here rather than an `AppError`, because the repository is
     * deliberately not wrapped — translation is the service's job.
     *
     * ⚠️ The SQLSTATE and the raising function are both asserted, and that is the point of the
     * test. "Something threw" would also be satisfied by a typo in the UPDATE. `23001` from
     * `order_instalments_guard_write()` is the guard itself refusing, which is the only
     * evidence that the lock survives a caller who never went through the planner.
     */
    expect(pgErrorOf(caught)?.code).toBe('23001');
    expect(pgErrorOf(caught)?.where).toContain('order_instalments_guard_write');
    expect((await instalmentsOf(order.orderId))[0]?.dueThbMinor).toBe(DEPOSIT);
  });

  it('opens a refund instead of writing a negative instalment', async () => {
    const order = await submittedOrder();
    await open(order);

    const [only] = await instalmentsOf(order.orderId);
    if (!only) throw new Error('no instalment');
    await payInstalment(order.orderId, only.id, GRAND);

    const error = await failureOf(() => repriceTo(order.orderId, GRAND - 100_000n));

    expect(error.status).toBe(409);
    expect(detailsOf(error)['reason']).toBe('refund_required');
    expect(detailsOf(error)['overpaidThbMinor']).toBe('100000');
    /* Nothing was written: the transaction rolled back with the instalment as it was. */
    expect((await instalmentsOf(order.orderId))[0]?.dueThbMinor).toBe(GRAND);
  });

  /**
   * The ordering rule, made visible.
   *
   * Recomputing before the new total has been written to `orders` asserts the new instalments
   * against the *old* total. Because the service calls `assert_order_schedule()` itself
   * rather than waiting for the deferred trigger, that failure lands inside this call — which
   * is the difference between a caller who can fix their sequence and a caller who gets an
   * exception from `commit()`.
   */
  it('fails inside the call when the total has not been written yet', async () => {
    const order = await submittedOrder();
    await open(order);

    const error = await failureOf(() =>
      db.transaction(async (tx) => {
        await service.recompute({
          tx: tx as Tx,
          orderId: order.orderId,
          status: 'awaiting_payment',
          grandTotalThbMinor: GRAND + 1_000n,
        });
      }),
    );

    expect(error.status).toBe(409);
    expect((await instalmentsOf(order.orderId))[0]?.dueThbMinor).toBe(GRAND);
  });

  it('refuses to replace a schedule money has touched, and names the instalment', async () => {
    const order = await submittedOrder();
    await open(order);

    const [only] = await instalmentsOf(order.orderId);
    if (!only) throw new Error('no instalment');
    await payInstalment(order.orderId, only.id, GRAND);

    const error = await failureOf(() =>
      db.transaction(async (tx) =>
        service.replace(
          { tx: tx as Tx, orderId: order.orderId, status: 'awaiting_payment', grandTotalThbMinor: GRAND },
          depositPercentTerms(3_000),
        ),
      ),
    );

    expect(detailsOf(error)['reason']).toBe('schedule_has_money');
  });

  /**
   * Plan 7.5(ก)'s exemption: a cancelled order's schedule stops having to foot, and the stamp
   * is what makes that true. Both directions are checked, because the assertion refuses a
   * terminal order with an open schedule *and* a live order with a closed one — and the first
   * of those is the one that makes cancellation-after-deposit unrepresentable.
   */
  it('closes the schedule with the cancellation, and the assertion refuses either half alone', async () => {
    const order = await submittedOrder();
    await open(order);

    const [only] = await instalmentsOf(order.orderId);
    if (!only) throw new Error('no instalment');
    await payInstalment(order.orderId, only.id, DEPOSIT);

    const cancelWithoutClosing = await db
      .transaction(async (tx) => {
        const eventId = randomUUID();
        await tx.insert(orderEvents).values({
          id: eventId,
          orderId: order.orderId,
          eventType: 'cancelled',
          fromStatus: 'awaiting_payment',
          toStatus: 'cancelled',
          actorKind: 'staff',
          actorUserId: reviewer,
          payload: { fault: 'customer', reason: 'ทดสอบการปิดตารางงวด' },
        });
        await tx
          .update(orders)
          .set({ status: 'cancelled', statusEventId: eventId })
          .where(eq(orders.id, order.orderId));
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(cancelWithoutClosing).toBeDefined();

    await db.transaction(async (tx) => {
      const eventId = randomUUID();
      await tx.insert(orderEvents).values({
        id: eventId,
        orderId: order.orderId,
        eventType: 'cancelled',
        fromStatus: 'awaiting_payment',
        toStatus: 'cancelled',
        actorKind: 'staff',
        actorUserId: reviewer,
        payload: { fault: 'customer', reason: 'ทดสอบการปิดตารางงวด' },
      });
      await tx
        .update(orders)
        .set({ status: 'cancelled', statusEventId: eventId })
        .where(eq(orders.id, order.orderId));

      await service.close({ tx: tx as Tx, orderId: order.orderId }, 'cancelled');
    });

    const view = await db.transaction((tx) =>
      service.view({ tx: tx as Tx, orderId: order.orderId, status: 'cancelled', grandTotalThbMinor: GRAND }),
    );
    expect(view.closedReason).toBe('cancelled');
    expect(view.closedAt).not.toBeNull();
    /* The money it still holds is a refund question. The schedule no longer has to foot. */
    expect(toBigInt(view.instalments[0]?.allocatedThbMinor ?? encodeThb(0n))).toBe(DEPOSIT);
  });
});
