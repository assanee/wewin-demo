import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import {
  guests,
  orderDocuments,
  orderEvents,
  orderInstalments,
  orders,
  paymentSlips,
  slipAllocations,
  users,
} from '@wewin/db/schema';
import { divRoundHalfUp } from '@wewin/core/money';

import type { Tx } from '../../../src/orders/order.repository';
import { ScheduleRepository } from '../../../src/payments/schedule/schedule.repository';
import { ScheduleService } from '../../../src/payments/schedule/schedule.service';
import { depositPercentTerms, payInFullTerms } from '../../../src/payments/schedule/terms';
import { confirmQuotation } from '../../support/confirm-quotation';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ `order_next_due_thb_minor()` — the number the payment screen asks for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's ruling: *"ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"* — an
 * order with a deposit is asked for the deposit, an order without one for the whole amount.
 * Migration 0042 implements that as **one** rule, not two branches, and this file is where
 * that claim is checked: the same fold, reading a 30/70 schedule and a pay-in-full schedule,
 * has to produce ฿5,529.60 and ฿18,432.00 without knowing which is which.
 *
 * Everything here is against a real Postgres because none of it is a property of arithmetic:
 * `due - settled` is a join across three tables and a status filter, and the parts that can
 * go wrong (a `submitted` slip counting, a later instalment counting as progress) are exactly
 * the parts a TypeScript re-implementation would get right in the test and wrong in life.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** Plan 7.8's order: ฿18,432 VAT-inclusive, 30% deposit is ฿5,529.60. */
const GRAND = 1_843_200n;
const DEPOSIT_30 = 552_960n;

describeWithPg('⭐ what the payment screen asks a customer for', () => {
  let pool: Pool;
  let db: Database;
  let reviewer: string;

  const service = new ScheduleService(new ScheduleRepository());

  beforeAll(async () => {
    if (url === undefined) throw new Error('unreachable: the suite is skipped without a database');
    pool = createPool(url);
    db = createDatabase(pool);

    const [user] = await db
      .insert(users)
      .values({ displayName: `next-due reviewer ${tag}` })
      .returning({ id: users.id });
    if (!user) throw new Error('could not create a user');
    reviewer = user.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** A submitted order with its totals pinned — the state a schedule is written in. */
  const submittedOrder = async (grand: bigint = GRAND): Promise<string> => {
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
        contactEmail: `next-due-${randomUUID().slice(0, 8)}@probe.invalid`,
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
        /*
         * ⚠️ `awaiting_confirmation`, because `draft → awaiting_payment` is no longer a legal
         * pair (0056) and `order_events_guard_insert` refuses an event for a transition that
         * does not exist. The fixture then confirms, which is what a member of staff does.
         */
        toStatus: 'awaiting_confirmation',
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
          status: 'awaiting_confirmation',
          statusEventId: submitEventId,
          submittedAt: sql`now()`,
          orderNo: sql`'WW-' || nextval('order_no_seq')`,
          documentId: document.id,
          netThbMinor: net,
          vatThbMinor: grand - net,
          grandTotalThbMinor: grand,
          scheduledDepositThbMinor: divRoundHalfUp(grand * 3_000n, 10_000n),
        })
        .where(eq(orders.id, orderId));
    });

    /* …and confirmed: every caller of this fixture is asking about money owed. */
    await confirmQuotation(db, orderId);

    return orderId;
  };

  const openSchedule = async (
    orderId: string,
    terms: ReturnType<typeof payInFullTerms>,
    grand: bigint = GRAND,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into order_payment_schedules (order_id) values (${orderId}::uuid)
        on conflict (order_id) do nothing
      `);
      await service.open(
        { tx: tx as Tx, orderId, status: 'awaiting_payment', grandTotalThbMinor: grand },
        terms,
      );
    });
  };

  const instalmentsOf = async (
    orderId: string,
  ): Promise<readonly { id: string; seq: number; dueThbMinor: bigint }[]> =>
    db
      .select({
        id: orderInstalments.id,
        seq: orderInstalments.seq,
        dueThbMinor: orderInstalments.dueThbMinor,
      })
      .from(orderInstalments)
      .where(eq(orderInstalments.orderId, orderId))
      .orderBy(orderInstalments.seq);

  /**
   * An accepted slip allocated to one instalment — the only way money touches a schedule.
   *
   * Always `accepted`: `assert_slip_allocations()` refuses an allocation from a slip in any
   * other status, so there is no such thing as a part-settled instalment behind an unreviewed
   * slip. See the unreviewed-slip test, which models that state the way it really occurs.
   */
  const allocate = async (
    orderId: string,
    instalmentId: string,
    amount: bigint,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      const [slip] = await tx
        .insert(paymentSlips)
        .values({
          orderId,
          amountThbMinor: amount,
          transferredAt: new Date(),
          bankReference: `REF-${tag}-${randomUUID().slice(0, 6)}`,
          /*
           * ⚠️ `payment_slips_evidence_exists` (0047): a slip carries an image, an image that was
           * erased, or a stated reason. This fixture models a *customer's* slip — one somebody
           * photographed — so it carries a key. The column was always meant to be here; nothing
           * checked until the CHECK arrived, and a fixture with no evidence at all is a row the
           * storefront cannot produce.
           */
          storageKey: `test/slip-${randomUUID()}.png`,
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

  const nextDue = async (orderId: string): Promise<bigint> => {
    const rows = await db.execute<{ next_due: string }>(
      sql`select order_next_due_thb_minor(${orderId}::uuid)::text as next_due`,
    );
    /* `::text` for the reason `ledger.repository.ts` gives: the application pool hands int8
     * back as a bigint and the test pool as a string, so the cast makes `BigInt()` the only
     * conversion either way. */
    const value = rows.rows[0]?.next_due;
    if (value === undefined) throw new Error('the fold returned no row');
    return BigInt(value);
  };

  /* ---------------------------------------------------------------- *
   * The owner's two cases, which are one rule
   * ---------------------------------------------------------------- */

  it('⭐ asks for the DEPOSIT when the schedule has one', async () => {
    const orderId = await submittedOrder();
    await openSchedule(orderId, depositPercentTerms(3_000));

    expect(await nextDue(orderId)).toBe(DEPOSIT_30);
  });

  it('⭐ asks for the FULL AMOUNT when the schedule has no deposit', async () => {
    /*
     * The same fold, the same call, no branch anywhere between them. `payInFullTerms()` is one
     * `remainder` row gating `production_confirmed` — a schedule, not the absence of one — which
     * is exactly what lets "no deposit" and "30/70" share this code path.
     */
    const orderId = await submittedOrder();
    await openSchedule(orderId, payInFullTerms());

    expect(await nextDue(orderId)).toBe(GRAND);
  });

  /* ---------------------------------------------------------------- *
   * The edge cases the ruling has to survive
   * ---------------------------------------------------------------- */

  it('⭐ asks for the REMAINDER of a part-paid instalment, not the whole of it', async () => {
    /*
     * ⚠️ THE ONE THAT DECIDES WHETHER THE CUSTOMER OVERPAYS.
     *
     * ฿5,529.60 is due and ฿2,000.00 has been accepted against it. Prefilling the whole
     * instalment would have them transfer ฿5,529.60 *on top of* the ฿2,000.00 already sent —
     * ฿7,529.60 against a ฿5,529.60 obligation, over by exactly what they had already paid.
     * The remainder is the only figure that lands on the right total.
     */
    const orderId = await submittedOrder();
    await openSchedule(orderId, depositPercentTerms(3_000));
    const [gate] = await instalmentsOf(orderId);
    if (!gate) throw new Error('no gate instalment');

    await allocate(orderId, gate.id, 200_000n);

    expect(await nextDue(orderId)).toBe(DEPOSIT_30 - 200_000n);
  });

  it('⭐ asks for NOTHING once every instalment is settled', async () => {
    /* Falls out of the rule rather than being a case in it: no unsettled row, nothing to
     * report, and the screen has nothing to prefill and nothing to press. */
    const orderId = await submittedOrder();
    await openSchedule(orderId, payInFullTerms());
    const [only] = await instalmentsOf(orderId);
    if (!only) throw new Error('no instalment');

    await allocate(orderId, only.id, GRAND);

    expect(await nextDue(orderId)).toBe(0n);
  });

  it('⭐ moves to the balance once the gate instalment is closed', async () => {
    const orderId = await submittedOrder();
    await openSchedule(orderId, depositPercentTerms(3_000));
    const [gate, balance] = await instalmentsOf(orderId);
    if (!gate || !balance) throw new Error('expected two instalments');

    await allocate(orderId, gate.id, gate.dueThbMinor);

    expect(await nextDue(orderId)).toBe(balance.dueThbMinor);
    expect(gate.dueThbMinor + balance.dueThbMinor).toBe(GRAND);
  });

  it('⭐ still names the GATE instalment when a later one was paid first', async () => {
    /*
     * ⚠️ The gate is what opens production, and money on a later instalment is not progress
     * toward it. If this reported a later row — or ฿0.00 — a customer would read the screen as
     * saying the deposit was handled and their job was moving, while `order_settled_through()`
     * still says 0 and nothing has been frozen. Taking the *first* unsettled row by `seq` is
     * what keeps this answer and the frontier's answer the same answer.
     *
     * ⚠️ **Three instalments, and the middle one is the one that gets paid.** Two was not
     * enough: with a gate and a balance, settling the balance leaves the gate as the only
     * unsettled row, so `ORDER BY seq` and `ORDER BY seq DESC` return it alike and the test
     * proved nothing about the ordering it exists to pin — a mutation to `DESC` left it green.
     * With an unsettled row on *either side* of the settled one, ascending answers the gate
     * and descending answers the last instalment, and only one of those is the gate.
     */
    const orderId = await submittedOrder();
    await openSchedule(orderId, [
      { basis: 'percent', percentBp: 3_000, gatesEntryTo: 'production_confirmed' },
      { basis: 'percent', percentBp: 3_000, gatesEntryTo: null },
      { basis: 'remainder', gatesEntryTo: null },
    ]);
    const [gate, middle, last] = await instalmentsOf(orderId);
    if (!gate || !middle || !last) throw new Error('expected three instalments');

    await allocate(orderId, middle.id, middle.dueThbMinor);

    expect(await nextDue(orderId)).toBe(gate.dueThbMinor);
    /* The one a descending scan would have answered, named so the contrast is on the record. */
    expect(last.dueThbMinor).not.toBe(gate.dueThbMinor);
  });

  it('⭐ does not let an unreviewed slip reduce what is asked for', async () => {
    /*
     * A `submitted` slip is a claim nobody has checked. Counting it would let anybody lower the
     * figure on their own screen by uploading a photograph, and would tell a customer their
     * deposit was smaller than it is on the strength of their own assertion.
     *
     * ⚠️ The guarantee turns out to be **structural, not a filter**, and this test was written
     * the wrong way round before the database corrected it: `assert_slip_allocations()` refuses
     * any allocation from a slip that is not `accepted` ("slip % is submitted and cannot settle
     * anything"), so an unreviewed slip has no allocation rows to be counted in the first
     * place. The `s.status = 'accepted'` filter in 0042 is therefore a second defence rather
     * than the only one — which is the shape this schema uses everywhere.
     *
     * So the honest fixture is a slip with no allocations, which is exactly what the storefront
     * produces: `POST …/payment-slips` writes the slip and staff allocate it later on review.
     */
    const orderId = await submittedOrder();
    await openSchedule(orderId, depositPercentTerms(3_000));

    await db.insert(paymentSlips).values({
      orderId,
      amountThbMinor: 200_000n,
      transferredAt: new Date(),
      bankReference: `REF-${tag}-${randomUUID().slice(0, 6)}`,
      /* An image, because this is the storefront's own slip — see `payment_slips_evidence_exists`. */
      storageKey: `test/slip-${randomUUID()}.png`,
      status: 'submitted',
    });

    expect(await nextDue(orderId)).toBe(DEPOSIT_30);
  });

  it('⭐ falls back to the whole outstanding when nobody stated a schedule', async () => {
    /*
     * ⚠️ The second half of the ruling, in its purest form: "ไม่ได้ระบุ" — nobody stated
     * instalments — and the answer to that is the full amount.
     *
     * Unreachable through the application (`onSubmitted` opens a schedule on every submit, and
     * no submitted order in the database lacks one), so this is a floor rather than a path.
     * It is worth having because the alternative floor is a screen asking a customer for
     * ฿0.00 on an order that owes ฿18,432.00, and a customer who cannot pay is worse than a
     * customer asked for too much.
     */
    const orderId = await submittedOrder();

    expect(await nextDue(orderId)).toBe(GRAND);
  });

  it('answers 0 for a draft, which has no total and owes nothing', async () => {
    /*
     * The other side of the same fallback, and the reason it is a CASE rather than a second
     * `coalesce`: a draft reaches the same "no instalments" branch, but its outstanding is 0
     * — `order_outstanding_thb_minor()` coalesces a null grand total to zero — so the fallback
     * answers 0 without needing to know it was looking at a cart.
     */
    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('could not create a guest');

    const orderId = randomUUID();
    const createdEventId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        statusEventId: createdEventId,
        guestId: guest.id,
        contactEmail: `next-due-draft-${randomUUID().slice(0, 8)}@probe.invalid`,
      });
      await tx.insert(orderEvents).values({
        id: createdEventId,
        orderId,
        eventType: 'created',
        toStatus: 'draft',
        actorKind: 'guest',
        actorGuestId: guest.id,
      });
    });

    expect(await nextDue(orderId)).toBe(0n);
  });

  it('never exceeds the order outstanding, on any of these shapes', async () => {
    /*
     * A property rather than a case: whatever the schedule, the screen must never ask for more
     * than the order still owes. `assert_order_schedule()` foots the instalments against the
     * grand total, so this holds by construction — which is worth pinning, because it is the
     * invariant that would break first if a future basis let the rows over-foot.
     */
    const orderId = await submittedOrder();
    await openSchedule(orderId, depositPercentTerms(3_000));
    const [gate] = await instalmentsOf(orderId);
    if (!gate) throw new Error('no gate instalment');
    await allocate(orderId, gate.id, 200_000n);

    const rows = await db.execute<{ outstanding: string }>(
      sql`select order_outstanding_thb_minor(${orderId}::uuid)::text as outstanding`,
    );
    const outstanding = BigInt(rows.rows[0]?.outstanding ?? '0');

    expect(await nextDue(orderId)).toBeLessThanOrEqual(outstanding);
  });
});
