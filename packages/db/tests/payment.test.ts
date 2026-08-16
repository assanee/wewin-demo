import { beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { divRoundHalfUp } from '@wewin/core/money';
import type { Database } from '../src/client.js';
import {
  APPROVAL_DIMENSIONS,
  FORFEIT_BPS_DEFAULT,
  LEDGER_ACCOUNTS,
  forfeitPolicies,
  forfeitPolicyRules,
  guests,
  ledgerEntries,
  ledgerPostings,
  orderDocuments,
  orderEvents,
  orderInstalments,
  orderPaymentSchedules,
  orders,
  paymentSlips,
  refunds,
  slipAllocations,
  users,
} from '../src/schema/index.js';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/**
 * Phase 5b: money that has actually moved.
 *
 * Every block is written so that **removing the guard makes it fail**. Each one was
 * mutation-tested against a scratch database — drop the constraint or edit the function,
 * watch the test go red, put it back — and what that found is written down beside the test
 * it changed. A guard nobody broke is a guard with no evidence.
 *
 * Rows are not cleaned up. A submitted order cannot be deleted, a slip cannot be deleted,
 * and the ledger is append-only; a teardown able to remove any of it would contradict the
 * schema it is testing. `tests/globalSetup.ts` drops the whole database instead.
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

/**
 * Plan 7.8's worked example, in satang.
 *
 * ฿18,432 VAT-inclusive with a 30% deposit. The plan quotes the deposit as ฿5,530; at
 * satang precision it is ฿5,529.60, and the difference is the plan rounding to whole baht
 * in prose rather than a disagreement — `divRoundHalfUp(1843200 × 3000, 10000)` is pinned
 * below so the two can never quietly drift apart.
 */
const GRAND = 1_843_200n;
const NET = divRoundHalfUp(GRAND * 10_000n, 10_700n);
const VAT = GRAND - NET;
const DEPOSIT = divRoundHalfUp(GRAND * 3_000n, 10_000n);
const BALANCE = GRAND - DEPOSIT;

type Order = { orderId: string; guestId: string };

let db: Database;
let staffA: string;
let staffB: string;
let staffC: string;
/** A policy that forfeits everything from `in_production` on — see the forfeit block. */
let fullForfeitPolicyId: string;

const createUser = async (name: string): Promise<string> => {
  const [user] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!user) throw new Error('could not create a user');
  return user.id;
};

/**
 * An anonymous cart, created the only way the circular FK permits (trap 1).
 *
 * `supersedesOrderId` is passed at INSERT because `orders_guard_update()` makes it
 * immutable — a later `A supersedes B` is the only way to build a cycle, and a cycle would
 * hang the ancestor walk the carry guard depends on.
 */
const createDraft = async (options: { supersedesOrderId?: string } = {}): Promise<Order> => {
  const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
  if (!guest) throw new Error('could not create a guest');

  const orderId = randomUUID();
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      statusEventId: eventId,
      guestId: guest.id,
      contactEmail: `pay-${randomUUID().slice(0, 8)}@example.test`,
      supersedesOrderId: options.supersedesOrderId ?? null,
    });
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'created',
      toStatus: 'draft',
      actorKind: 'guest',
      actorGuestId: guest.id,
    });
  });

  return { orderId, guestId: guest.id };
};

/** Submit, pinning the seven things — including `scheduled_deposit_thb_minor`. */
const submit = async (order: Order, deposit = DEPOSIT): Promise<void> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, order.orderId)).for('update');

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId: order.orderId,
      eventType: 'submitted_for_payment',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorKind: 'guest',
      actorGuestId: order.guestId,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId: order.orderId,
        revision: 1,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
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
        // The database clock, not this process one: the freeze trigger stamps frozen_at
        // with now(), orders_frozen_after_submitted compares the two, and a Node timestamp
        // makes that a race against container clock skew. See order.repository.ts.
        submittedAt: sql`now()`,
        orderNo: sql`'WW-' || nextval('order_no_seq')`,
        documentId: document.id,
        netThbMinor: NET,
        vatThbMinor: VAT,
        grandTotalThbMinor: GRAND,
        scheduledDepositThbMinor: deposit,
      })
      .where(eq(orders.id, order.orderId));
  });
};

type InstalmentSpec = {
  seq: number;
  basis: 'percent' | 'fixed' | 'remainder';
  dueThbMinor: bigint;
  percentBp?: number;
  fixedThbMinor?: bigint;
  gatesEntryTo?: 'production_confirmed' | 'awaiting_installation';
};

/** Write a whole schedule in one transaction, which is the only way it can foot. */
const writeSchedule = async (orderId: string, rows: readonly InstalmentSpec[]): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.insert(orderPaymentSchedules).values({ orderId }).onConflictDoNothing();
    await tx.insert(orderInstalments).values(
      rows.map((row) => ({
        orderId,
        seq: row.seq,
        basis: row.basis,
        dueThbMinor: row.dueThbMinor,
        percentBp: row.percentBp ?? null,
        fixedThbMinor: row.fixedThbMinor ?? null,
        gatesEntryTo: row.gatesEntryTo ?? null,
      })),
    );
  });
};

/**
 * A 5c-shaped repricing: a new frozen document revision, new totals, and whatever the
 * recompute does to the instalments — all in one transaction, because the footing
 * assertion judges the transaction and not the statement.
 */
const reprice = async (
  orderId: string,
  newGrand: bigint,
  apply: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<void>,
): Promise<void> => {
  const eventId = randomUUID();
  const newNet = divRoundHalfUp(newGrand * 10_000n, 10_700n);

  await db.transaction(async (tx) => {
    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType: 'quote_revised',
      actorKind: 'staff',
      actorUserId: staffA,
    });

    const [document] = await tx
      .insert(orderDocuments)
      .values({
        orderId,
        revision: 2,
        document: { lines: [] },
        documentHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        pinnedCoreVersion: '1.0.0',
        pinnedVatRateBp: 700,
        pinnedVatTreatment: 'standard',
        pinnedLocale: 'th',
        netThbMinor: newNet,
        vatThbMinor: newGrand - newNet,
        grandTotalThbMinor: newGrand,
        createdByEventId: eventId,
      })
      .returning({ id: orderDocuments.id });
    if (!document) throw new Error('could not pin a revision');

    await apply(tx);

    await tx
      .update(orders)
      .set({
        documentId: document.id,
        netThbMinor: newNet,
        vatThbMinor: newGrand - newNet,
        grandTotalThbMinor: newGrand,
      })
      .where(eq(orders.id, orderId));
  });
};

/** The 30/70 of plan 7.5(ก): a gated percent instalment and an ungated remainder. */
const thirtySeventy = (orderId: string): Promise<void> =>
  writeSchedule(orderId, [
    {
      seq: 1,
      basis: 'percent',
      percentBp: 3000,
      dueThbMinor: DEPOSIT,
      gatesEntryTo: 'production_confirmed',
    },
    { seq: 2, basis: 'remainder', dueThbMinor: BALANCE },
  ]);

const instalmentIds = async (orderId: string): Promise<string[]> => {
  const rows = await db
    .select({ id: orderInstalments.id, seq: orderInstalments.seq })
    .from(orderInstalments)
    .where(eq(orderInstalments.orderId, orderId))
    .orderBy(orderInstalments.seq);
  return rows.map((row) => row.id);
};

/** A submitted slip, awaiting the one review that is the only control in this design. */
const uploadSlip = async (orderId: string, amount: bigint): Promise<string> => {
  const [slip] = await db
    .insert(paymentSlips)
    .values({
      orderId,
      amountThbMinor: amount,
      transferredAt: new Date(),
      bankReference: `REF-${tag}-${randomUUID().slice(0, 6)}`,
      /*
       * ⚠️ `payment_slips_evidence_exists` (0047): a slip carries an image, an image that was
       * erased, or a stated reason. "Upload" is the customer's act, so this fixture carries a
       * key — and the block below is where the *absence* of all three is asserted to be refused.
       */
      storageKey: `test/slip-${randomUUID()}.png`,
    })
    .returning({ id: paymentSlips.id });
  if (!slip) throw new Error('could not upload a slip');
  return slip.id;
};

/** Accept a slip and allocate it, in the one transaction the deferred assertion judges. */
const acceptSlip = async (
  slipId: string,
  allocations: readonly { instalmentId: string; amount: bigint; carriedFromOrderId?: string }[],
): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx
      .update(paymentSlips)
      .set({ status: 'accepted', reviewedByUserId: staffA, reviewedAt: new Date() })
      .where(eq(paymentSlips.id, slipId));

    await tx.insert(slipAllocations).values(
      allocations.map((allocation) => ({
        slipId,
        instalmentId: allocation.instalmentId,
        amountThbMinor: allocation.amount,
        carriedFromOrderId: allocation.carriedFromOrderId ?? null,
      })),
    );
  });
};

type Leg = { account: (typeof LEDGER_ACCOUNTS)[number]; amount: bigint };

/** One balanced ledger entry. Debit positive, credit negative, legs sum to zero. */
const post = async (
  orderId: string,
  kind: 'slip_accepted' | 'forfeited' | 'refund_accrued' | 'refund_disbursed' | 'carried_forward',
  legs: readonly Leg[],
  options: { slipId?: string } = {},
): Promise<string> => {
  const entryId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(ledgerEntries).values({
      id: entryId,
      orderId,
      kind,
      slipId: options.slipId ?? null,
    });
    await tx.insert(ledgerPostings).values(
      legs.map((leg, index) => ({
        entryId,
        orderId,
        legNo: index + 1,
        account: leg.account,
        amountThbMinor: leg.amount,
      })),
    );
  });

  return entryId;
};

/** Receive cash: debit the bank, credit what is held on the customer's behalf. */
const receiveCash = (orderId: string, amount: bigint, slipId?: string): Promise<string> =>
  post(
    orderId,
    'slip_accepted',
    [
      { account: 'bank_thb', amount },
      { account: 'deposit_held', amount: -amount },
    ],
    slipId === undefined ? {} : { slipId },
  );

const scalar = async <T>(query: ReturnType<typeof sql>): Promise<T> => {
  const result = await db.execute<{ value: T }>(sql`select ${query} as value`);
  const row = result.rows[0];
  if (!row) throw new Error('no row');
  return row.value;
};

/** One transition, with the lock taken first, the way the API has to make it. */
const move = async (
  orderId: string,
  to: 'production_confirmed' | 'in_production' | 'awaiting_installation' | 'cancelled',
  options: { payload?: Record<string, unknown>; closeSchedule?: boolean } = {},
): Promise<void> => {
  const eventId = randomUUID();

  await db.transaction(async (tx) => {
    const [order] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');
    if (!order) throw new Error('order vanished');

    const eventType =
      to === 'cancelled'
        ? 'cancelled'
        : to === 'production_confirmed'
          ? 'payment_confirmed'
          : to === 'in_production'
            ? 'production_started'
            : 'installation_scheduled';

    await tx.insert(orderEvents).values({
      id: eventId,
      orderId,
      eventType,
      fromStatus: order.status,
      toStatus: to,
      actorKind: 'staff',
      actorUserId: staffA,
      payload: options.payload ?? {},
    });

    await tx.update(orders).set({ status: to, statusEventId: eventId }).where(eq(orders.id, orderId));

    if (options.closeSchedule === true) {
      await tx
        .update(orderPaymentSchedules)
        .set({ closedAt: new Date(), closedReason: 'cancelled' })
        .where(eq(orderPaymentSchedules.orderId, orderId));
    }
  });
};

beforeAll(async () => {
  db = await connect();
  staffA = await createUser(`reviewer ${tag}`);
  staffB = await createUser(`approver ${tag}`);
  staffC = await createUser(`treasurer ${tag}`);

  /*
   * ⚠️ A TEST FIXTURE, NOT A SHIPPED DEFAULT. The migration seeds `plan13_default` with
   * 0 bp in every cell, which is what plan 13 says to ship. This policy exists only so the
   * forfeit *arithmetic* can be exercised at a rate that is not zero — at 0 bp every wrong
   * implementation and every right one agree, and the ฿5,530-versus-฿18,432 finding would
   * be untestable.
   */
  fullForfeitPolicyId = await db.transaction(async (tx) => {
    // One transaction, because `forfeit_policies_complete` is deferred to commit: an
    // effective policy and its twelve cells arrive together or the policy is not usable.
    // That is the guard doing its job, and it is why this fixture is written this way.
    const [policy] = await tx
      .insert(forfeitPolicies)
      .values({
        code: `test_full_forfeit_${tag}`,
        descriptionTh: 'ฟิกซ์เจอร์ของเทสต์ — ริบเต็มตั้งแต่ in_production',
        effectiveFrom: new Date(),
      })
      .returning({ id: forfeitPolicies.id });
    if (!policy) throw new Error('could not create the fixture policy');

    await tx.insert(forfeitPolicyRules).values(
      (
        [
          'draft',
          'awaiting_payment',
          'production_confirmed',
          'in_production',
          'awaiting_installation',
          'redesign',
        ] as const
      ).flatMap((fromStatus) =>
        (['customer', 'company'] as const).map((fault) => ({
          policyId: policy.id,
          fromStatus,
          fault,
          // `company` fault and `production_confirmed` are held at 0 by CHECK, not by choice.
          forfeitBp:
            fault === 'company' ||
            fromStatus === 'production_confirmed' ||
            fromStatus === 'draft' ||
            fromStatus === 'awaiting_payment'
              ? 0
              : 10_000,
        })),
      ),
    );

    return policy.id;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seams, named once — plan 7.13
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the nine accounts, and the count of two-person rules', () => {
  it('names exactly nine accounts and refuses a tenth', async () => {
    // Plan 7.13: the finding was one bank fee posted to `settlement_variance` on the way
    // in and to `revenue` on the way out, by two designs each believing it was the only
    // one. A chart of accounts spread over four documents is four charts.
    expect(LEDGER_ACCOUNTS).toHaveLength(9);
    expect([...LEDGER_ACCOUNTS].sort()).toEqual([
      'bank_thb',
      'credit_clearing',
      'deposit_held',
      'forfeited',
      'refund_payable',
      'remittance_in_transit',
      'revenue',
      'settlement_variance',
      'trade_receivable',
    ]);

    const constraint = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'ledger_postings_account_known'
    `);
    const definition = constraint.rows[0]?.definition ?? '';
    for (const account of LEDGER_ACCOUNTS) expect(definition).toContain(`'${account}'`);

    const order = await createDraft();
    await submit(order);
    const entryId = randomUUID();

    await expectViolation(
      db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({ id: entryId, orderId: order.orderId, kind: 'forfeited' });
        await tx.execute(sql`
          insert into ledger_postings (entry_id, order_id, leg_no, account, amount_thb_minor)
          values (${entryId}, ${order.orderId}, 1, 'suspense', 100)
        `);
      }),
      PG.checkViolation,
    );
  });

  it('spends exactly four two-person rules, and plan 7.13 warns about eight', async () => {
    /*
     * This is a *budget* test, and it is here because plan 7.13 says the failure mode is
     * accumulation: eight approval gates in one workflow kill the single control that
     * means anything, and nobody has answered how many people the company has. If a later
     * phase adds a fifth, this fails and somebody has to argue for it out loud.
     */
    const rules = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conname in (
         'payment_slips_reviewer_is_not_submitter',
         'refunds_approver_is_not_requester',
         'refunds_disburser_is_not_approver',
         'approvals_decider_is_not_requester'
       )
       order by conname
    `);

    expect(rules.rows.map((row) => row.conname)).toEqual([
      'approvals_decider_is_not_requester',
      'payment_slips_reviewer_is_not_submitter',
      'refunds_approver_is_not_requester',
      'refunds_disburser_is_not_approver',
    ]);

    // And there is no fifth hiding under a different name.
    const total = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint
       where contype = 'c'
         and pg_get_constraintdef(oid) ilike '%_by_user_id%'
         and pg_get_constraintdef(oid) ilike '%requested_by_user_id%'
            or (contype = 'c' and conname like '%is_not_%')
    `);
    expect(total.rows[0]?.n).toBe(4);

    /* And one table with two dimensions, not six column pairs in six places. */
    expect([...APPROVAL_DIMENSIONS]).toEqual(['margin', 'cashflow']);
  });

  it("ships plan 13's forfeit default: 0 bp in every one of the fourteen cells", async () => {
    const rows = await db.execute<{ n: number; nonzero: number }>(sql`
      select count(*)::int as n,
             count(*) filter (where forfeit_bp <> 0)::int as nonzero
        from forfeit_policy_rules r
        join forfeit_policies p on p.id = r.policy_id
       where p.code = 'plan13_default'
    `);

    // Seven cancellable statuses × two faults. `redesign` is in there — plan 7.8 calls it the
    // one everybody forgets — and `awaiting_confirmation` joined it in 0053, where the rows are
    // copied from each policy's own `awaiting_payment` cells because the two mean the same thing
    // to a cancelling customer: nothing has been committed to the factory.
    expect(rows.rows[0]?.n).toBe(14);
    expect(rows.rows[0]?.nonzero).toBe(0);
    expect(FORFEIT_BPS_DEFAULT).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The schedule foots — plan 7.5(ก)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the schedule foots, and a terminal order is exempt', () => {
  it('accepts a 30/70 that foots to the grand total', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    const total = await scalar<string>(
      sql`(select sum(due_thb_minor) from order_instalments where order_id = ${order.orderId})`,
    );
    expect(BigInt(total)).toBe(GRAND);
    // The deposit the plan quotes as ฿5,530 is ฿5,529.60 in satang; both sides of that
    // sentence come from one function, so they cannot drift.
    expect(DEPOSIT).toBe(552_960n);
  });

  it('refuses a schedule that does not foot — at COMMIT, not before', async () => {
    const order = await createDraft();
    await submit(order);

    /*
     * MUTATION (verified): drop `order_instalments_dense_seq` and this passes — two
     * instalments totalling ฿1 more than the contract, and every row individually valid.
     * ฿8,791 split 50/50 with half_up is exactly this failure: ฿4,396 + ฿4,396 = ฿8,792.
     */
    await expectViolation(
      writeSchedule(order.orderId, [
        { seq: 1, basis: 'percent', percentBp: 5000, dueThbMinor: GRAND / 2n + 1n },
        { seq: 2, basis: 'remainder', dueThbMinor: GRAND / 2n },
      ]),
      PG.restrictViolation,
    );

    // Nothing was left behind: the whole transaction rolled back at commit.
    expect(await instalmentIds(order.orderId)).toHaveLength(0);
  });

  it('lets a cancelled order that holds a deposit exist, because the schedule closes', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);

    /*
     * ⚠️ THE CASE THE EXEMPTION EXISTS FOR — plan 7.5(ก). The order still owes ฿12,902 on
     * a schedule that foots, and it is being cancelled. Without the exemption this
     * cancellation is unrepresentable and stays unrepresentable until somebody writes a
     * migration, on the day a customer asks for their deposit back.
     */
    await move(order.orderId, 'cancelled', {
      payload: { reason: 'ลูกค้าเปลี่ยนใจ' },
      closeSchedule: true,
    });

    expect(await scalar<string>(sql`order_held_thb_minor(${order.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
  });

  it('refuses to cancel while the schedule is still open, and refuses a closed schedule on a live order', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    // MUTATION (verified): delete the `IF closed IS NULL` branch of assert_order_schedule
    // and this passes — the cancellation succeeds and the exemption becomes silent.
    await expectViolation(
      move(order.orderId, 'cancelled', { payload: { reason: 'no close' } }),
      PG.restrictViolation,
    );

    // And the other direction: "closed" must not be a way to switch the footing rule off
    // on an order that is still live.
    await expectViolation(
      db
        .update(orderPaymentSchedules)
        .set({ closedAt: new Date(), closedReason: 'cancelled' })
        .where(eq(orderPaymentSchedules.orderId, order.orderId)),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// seq, the remainder, and the frontier — plan 7.5(ค)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('seq is dense from 1, the remainder is last, and the frontier is a MAX', () => {
  it('refuses a schedule that starts at 2 or has a hole in it', async () => {
    const first = await createDraft();
    await submit(first);
    await expectViolation(
      writeSchedule(first.orderId, [{ seq: 2, basis: 'remainder', dueThbMinor: GRAND }]),
      PG.restrictViolation,
    );

    const second = await createDraft();
    await submit(second);
    await expectViolation(
      writeSchedule(second.orderId, [
        { seq: 1, basis: 'percent', percentBp: 3000, dueThbMinor: DEPOSIT },
        { seq: 3, basis: 'remainder', dueThbMinor: BALANCE },
      ]),
      PG.restrictViolation,
    );
  });

  it('refuses a second remainder, and a remainder that is not last', async () => {
    const order = await createDraft();
    await submit(order);

    // "At most one" is a partial unique index, so it fails immediately — a better error
    // for the commonest mistake than one that arrives at commit.
    await expectViolation(
      writeSchedule(order.orderId, [
        { seq: 1, basis: 'remainder', dueThbMinor: DEPOSIT },
        { seq: 2, basis: 'remainder', dueThbMinor: BALANCE },
      ]),
      PG.uniqueViolation,
    );

    // "And it is last" has to compare rows, so it is the deferred assertion.
    await expectViolation(
      writeSchedule(order.orderId, [
        { seq: 1, basis: 'remainder', dueThbMinor: DEPOSIT },
        { seq: 2, basis: 'fixed', fixedThbMinor: BALANCE, dueThbMinor: BALANCE },
      ]),
      PG.restrictViolation,
    );
  });

  it('is a MAX over the settled prefix and not a COUNT of settled instalments', async () => {
    const order = await createDraft();
    await submit(order);

    /*
     * Three instalments, and the middle one unpaid. This is the shape where the two
     * formulas give different answers:
     *
     *   MAX over the settled prefix = 0   (nothing is settled *through*)
     *   COUNT of settled instalments = 2  (1 and 3 are paid)
     *
     * A count opens the gate on instalment 2, which nobody paid. `seq` being dense is what
     * makes the two agree in the ordinary case, which is exactly why the difference is
     * invisible until it costs money.
     */
    const third = GRAND - DEPOSIT - DEPOSIT;
    await writeSchedule(order.orderId, [
      { seq: 1, basis: 'fixed', fixedThbMinor: DEPOSIT, dueThbMinor: DEPOSIT },
      {
        seq: 2,
        basis: 'fixed',
        fixedThbMinor: DEPOSIT,
        dueThbMinor: DEPOSIT,
        gatesEntryTo: 'production_confirmed',
      },
      { seq: 3, basis: 'remainder', dueThbMinor: third },
    ]);

    const ids = await instalmentIds(order.orderId);
    const [one, , threeId] = ids;
    if (!one || !threeId) throw new Error('no instalments');

    const slipOne = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipOne, [{ instalmentId: one, amount: DEPOSIT }]);
    const slipThree = await uploadSlip(order.orderId, third);
    await acceptSlip(slipThree, [{ instalmentId: threeId, amount: third }]);

    expect(await scalar<number>(sql`order_settled_through(${order.orderId})`)).toBe(1);

    const settledCount = await scalar<number>(sql`(
      select count(*)::int from order_instalments i
       where i.order_id = ${order.orderId}
         and i.due_thb_minor <= coalesce((
           select sum(a.amount_thb_minor) from slip_allocations a
             join payment_slips s on s.id = a.slip_id and s.status = 'accepted'
            where a.instalment_id = i.id), 0)
    )`);

    // The rival formula, computed here so the disagreement is a number in the log rather
    // than an assertion about a formula nobody ran.
    expect(settledCount).toBe(2);
    expect(settledCount).not.toBe(await scalar<number>(sql`order_settled_through(${order.orderId})`));

    // And the gate it would have opened is still shut.
    expect(
      await scalar<boolean>(sql`order_gate_is_open(${order.orderId}, 'production_confirmed')`),
    ).toBe(false);
  });

  it('opens the gate when the gating instalment is settled, and only then', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    expect(
      await scalar<boolean>(sql`order_gate_is_open(${order.orderId}, 'production_confirmed')`),
    ).toBe(false);
    expect(await scalar<number>(sql`order_settled_through(${order.orderId})`)).toBe(0);

    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);

    expect(await scalar<number>(sql`order_settled_through(${order.orderId})`)).toBe(1);
    expect(
      await scalar<boolean>(sql`order_gate_is_open(${order.orderId}, 'production_confirmed')`),
    ).toBe(true);

    /*
     * Plan 7.5(ข): accepting the slip that closes the *gating* instalment is the
     * transition, and the freeze point has not moved. The balance is still outstanding and
     * there is no `awaiting_balance` status for it to sit in — outstanding is derived.
     */
    await move(order.orderId, 'production_confirmed');
    expect(await scalar<string>(sql`order_outstanding_thb_minor(${order.orderId})`)).toBe(
      BALANCE.toString(),
    );

    // …and there is no status for it to sit in: `awaiting_balance` is not one of the nine.
    const known = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint
       where conname = 'orders_status_known'
         and pg_get_constraintdef(oid) like '%awaiting_balance%'
    `);
    expect(known.rows[0]?.n).toBe(0);
  });

  it('lets a gate close again, and keeps the entitlement anyway', async () => {
    /*
     * ⚠️ "A GATE, ONCE OPEN, NEVER CLOSES" IS FALSE.
     *
     * The remainder cannot be locked — absorbing recomputation is its definition — so a
     * price rise after full payment pushes it above what has been allocated and the
     * frontier moves BACKWARDS. Every design that treated the gate as monotone would
     * conclude the order should never have entered production.
     */
    const order = await createDraft();
    await submit(order);
    await writeSchedule(order.orderId, [
      { seq: 1, basis: 'remainder', dueThbMinor: GRAND, gatesEntryTo: 'production_confirmed' },
    ]);

    const [only] = await instalmentIds(order.orderId);
    if (!only) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, GRAND);
    await acceptSlip(slipId, [{ instalmentId: only, amount: GRAND }]);
    await receiveCash(order.orderId, GRAND, slipId);

    expect(await scalar<number>(sql`order_settled_through(${order.orderId})`)).toBe(1);
    await move(order.orderId, 'production_confirmed');

    // The price rises by ฿100 and the remainder absorbs it, in one transaction.
    const raised = GRAND + 10_000n;
    await reprice(order.orderId, raised, async (tx) => {
      await tx
        .update(orderInstalments)
        .set({ dueThbMinor: raised })
        .where(eq(orderInstalments.id, only));
    });

    // The frontier really did move backwards…
    expect(await scalar<number>(sql`order_settled_through(${order.orderId})`)).toBe(0);
    // …and the order is still entitled to be where it is, because the spine remembers.
    // MUTATION (verified): drop the `EXISTS (… order_events …)` half of
    // order_gate_is_open() and this flips to false on an order already in production.
    expect(
      await scalar<boolean>(sql`order_gate_is_open(${order.orderId}, 'production_confirmed')`),
    ).toBe(true);
    expect(await scalar<string>(sql`order_outstanding_thb_minor(${order.orderId})`)).toBe('10000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What money locks — plan 7.5(ง)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('a settled instalment is locked; the remainder is the one that moves', () => {
  it('refuses to change the amount of an instalment money has touched', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    const ids = await instalmentIds(order.orderId);
    const [deposit, balance] = ids;
    if (!deposit || !balance) throw new Error('no instalments');

    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);

    /*
     * ⚠️ The schedule still FOOTS across this edit — ฿1 moves from the deposit to the
     * remainder — so the deferred footing assertion has nothing to say and only the lock
     * can refuse it. Written that way deliberately: the obvious version of this test
     * (raise the deposit and leave the remainder alone) stays green with the lock removed,
     * because the footing assertion catches it instead. A test that is green because
     * another mechanism is standing in front of it is a test that lies.
     */
    await expectViolation(
      db.transaction(async (tx) => {
        await tx
          .update(orderInstalments)
          .set({ dueThbMinor: DEPOSIT + 100n })
          .where(eq(orderInstalments.id, deposit));
        await tx
          .update(orderInstalments)
          .set({ dueThbMinor: BALANCE - 100n })
          .where(eq(orderInstalments.id, balance));
      }),
      PG.restrictViolation,
    );

    // The remainder is not locked — it is the absorber, and locking it would mean no price
    // may ever change after a deposit, on orders that spend weeks in `redesign`.
    await reprice(order.orderId, GRAND + 10_000n, async (tx) => {
      await tx
        .update(orderInstalments)
        .set({ dueThbMinor: BALANCE + 10_000n })
        .where(eq(orderInstalments.id, balance));
    });
  });

  it('refuses to reduce an instalment below the money already allocated to it', async () => {
    const order = await createDraft();
    await submit(order);
    await writeSchedule(order.orderId, [
      { seq: 1, basis: 'remainder', dueThbMinor: GRAND, gatesEntryTo: 'production_confirmed' },
    ]);

    const [only] = await instalmentIds(order.orderId);
    if (!only) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, GRAND);
    await acceptSlip(slipId, [{ instalmentId: only, amount: GRAND }]);

    /*
     * Plan 7.5(ง)(4) and 7.10: a total below what has already been received is a REFUND,
     * not a smaller instalment. Without this the remainder absorbs itself negative — or,
     * with the non-negative CHECK, down to a figure smaller than the money sitting on it —
     * and the refund process is never entered.
     */
    // The order is repriced DOWN in the same transaction, so the schedule foots to the new
    // total and the footing assertion is silent — only the `due < allocated` rule is left.
    await expectViolation(
      reprice(order.orderId, GRAND - 100_000n, async (tx) => {
        await tx
          .update(orderInstalments)
          .set({ dueThbMinor: GRAND - 100_000n })
          .where(eq(orderInstalments.id, only));
      }),
      PG.restrictViolation,
    );
  });

  /**
   * ⚠️ A ฿0.00 GATE OPENS THE PRODUCTION LINE FOR FREE — 5b red team, A5.1.
   *
   * `order_settled_through()` is `due <= allocated`, so a `fixed 0` row is settled the moment
   * it exists: the frontier reaches it, `order_gate_is_open()` says yes, and the order freezes
   * with `order_cash_thb_minor` = ฿0.00 and the whole ฿18,432.00 outstanding. Correct for "no
   * deposit" and catastrophic for a gate, and the difference is not something the fold can see
   * — so it is a CHECK on the row that carries the gate.
   *
   * The other half is the status the gate names. `gates_entry_to = 'draft'` is a gate on a
   * status the order has already been through, which `order_gate_is_open()`'s spine clause
   * reports open for ever: the same hole spelled differently, and the same CHECK closes it.
   */
  it('refuses a gate with no money behind it, and a gate on a status already passed', async () => {
    const order = await createDraft();
    await submit(order);

    await expectViolation(
      writeSchedule(order.orderId, [
        { seq: 1, basis: 'fixed', fixedThbMinor: 0n, dueThbMinor: 0n, gatesEntryTo: 'production_confirmed' },
        { seq: 2, basis: 'remainder', dueThbMinor: GRAND },
      ]),
      PG.checkViolation,
    );

    /* And the same row without a gate is perfectly legal — a zero instalment is not the bug. */
    await writeSchedule(order.orderId, [
      { seq: 1, basis: 'fixed', fixedThbMinor: 0n, dueThbMinor: 0n },
      { seq: 2, basis: 'remainder', dueThbMinor: GRAND, gatesEntryTo: 'production_confirmed' },
    ]);

    const backwards = await createDraft();
    await submit(backwards);
    await expectViolation(
      db.transaction(async (tx) => {
        await tx.insert(orderPaymentSchedules).values({ orderId: backwards.orderId });
        await tx.insert(orderInstalments).values({
          orderId: backwards.orderId,
          seq: 1,
          basis: 'remainder',
          dueThbMinor: GRAND,
          gatesEntryTo: 'awaiting_payment',
        });
      }),
      PG.checkViolation,
    );
  });

  it('refuses to delete an instalment out of the middle of a schedule', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    /*
     * The one write that reaches `order_instalments_dense_seq` and nothing else: no
     * schedule row is touched and no order row is touched, so the two other entry points
     * into `assert_order_schedule()` never fire. Removing a row leaves seq 2 with no seq 1
     * and a schedule ฿5,529.60 short — two failures, one assertion.
     */
    await expectViolation(
      db.delete(orderInstalments).where(eq(orderInstalments.id, deposit)),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slips and their review — plan 7.6, 7.8
// ─────────────────────────────────────────────────────────────────────────────

describeDb('an accepted slip settles exactly the money it is evidence of', () => {
  it('refuses allocations that do not sum to the slip', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    /*
     * ⚠️ MUTATION (verified): drop `slip_allocations_foot` and this passes. A ฿5,529.60
     * slip settles a ฿5,529.60 instalment *and* ฿12,902.40 more, and nothing referential
     * is broken — every row is individually valid and only the total is a lie. That is
     * exactly the shape a foreign key cannot see.
     */
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await expectViolation(
      acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT + 100n }]),
      PG.restrictViolation,
    );

    // Accepting with nothing allocated at all fails from the other side, on a write that
    // never touches slip_allocations.
    const bare = await uploadSlip(order.orderId, DEPOSIT);
    await expectViolation(
      db
        .update(paymentSlips)
        .set({ status: 'accepted', reviewedByUserId: staffA, reviewedAt: new Date() })
        .where(eq(paymentSlips.id, bare)),
      PG.restrictViolation,
    );
  });

  /**
   * ⚠️ NOTHING CAPPED AN ALLOCATION AT WHAT THE INSTALMENT WAS DUE — 5b red team, A5.2.
   *
   * The mirror image of `order_instalments_guard_write()`, which already refused lowering a
   * `due` below what is allocated to it. One direction was impossible and the other was wide
   * open, and they are the same invariant.
   *
   * The red team committed **฿39,444.48** against an instalment due ฿5,916.67 on a ฿19,722.24
   * order, with the slip inflated to match so the footing check was satisfied: `settled` read
   * ฿39,444.48, `outstanding` read −฿19,722.24, the queue bucket read `settled` — and
   * `order_settled_through()` still reported 1, so the *fully funded* balance instalment read
   * unsettled and its gate stayed shut. Every constraint held. Plan 7.8 asked for the CHECK
   * and it was not there.
   */
  it('refuses an instalment absorbing more than it is due', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    /* The slip is for the money too, so `slip_allocations_foot` is silent and only the new
     * per-instalment rule is left standing. */
    const inflated = await uploadSlip(order.orderId, GRAND * 2n);
    await expectViolation(
      acceptSlip(inflated, [{ instalmentId: deposit, amount: GRAND * 2n }]),
      PG.restrictViolation,
    );

    /* And the other way in: allocations that were legal while the slip was `submitted`, then
     * an acceptance in one statement that no allocation trigger ever sees. */
    const later = await uploadSlip(order.orderId, GRAND * 2n);
    await expectViolation(
      db.transaction(async (tx) => {
        await tx
          .insert(slipAllocations)
          .values({ slipId: later, instalmentId: deposit, amountThbMinor: GRAND * 2n });
        await tx
          .update(paymentSlips)
          .set({ status: 'accepted', reviewedByUserId: staffA, reviewedAt: new Date() })
          .where(eq(paymentSlips.id, later));
      }),
      PG.restrictViolation,
    );
  });

  it('refuses a rejected slip that still settles something', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    const slipId = await uploadSlip(order.orderId, DEPOSIT);

    await expectViolation(
      db.transaction(async (tx) => {
        await tx
          .update(paymentSlips)
          .set({
            status: 'rejected',
            reviewedByUserId: staffA,
            reviewedAt: new Date(),
            rejectedReasonTh: 'ยอดไม่ตรง',
          })
          .where(eq(paymentSlips.id, slipId));
        await tx
          .insert(slipAllocations)
          .values({ slipId, instalmentId: deposit, amountThbMinor: DEPOSIT });
      }),
      PG.restrictViolation,
    );
  });

  it('freezes a reviewed slip and refuses to delete one', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);

    // Plan 7.6's two-column comparison means nothing if the left-hand column can be edited
    // after the decision.
    await expectViolation(
      db
        .update(paymentSlips)
        .set({ amountThbMinor: DEPOSIT * 10n })
        .where(eq(paymentSlips.id, slipId)),
      PG.restrictViolation,
    );

    /*
     * ⚠️ The two assertions above and below are NOT evidence for the freeze trigger on
     * their own, and finding that out was the point of mutating it:
     *
     *   the amount   is also caught by `payment_slips_allocations_foot` — the allocations
     *                no longer sum to it — so dropping the freeze leaves this green;
     *   the delete   is also caught by the `slip_allocations` foreign key, whose RESTRICT
     *                raises SQLSTATE **23001**, the same code the triggers raise by hand.
     *
     * `bank_reference` is guarded by the freeze and by nothing else, so it is the one that
     * goes red when the trigger goes away.
     */
    await expectViolation(
      db
        .update(paymentSlips)
        .set({ bankReference: 'REWRITTEN' })
        .where(eq(paymentSlips.id, slipId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.delete(paymentSlips).where(eq(paymentSlips.id, slipId)),
      PG.restrictViolation,
    );

    // But the PDPA erasure of the image is allowed, which is the whole reason the image
    // and the reconciliation details are separate columns.
    await db
      .update(paymentSlips)
      .set({ storageKey: null, storageKeyErasedAt: new Date() })
      .where(eq(paymentSlips.id, slipId));
  });

  it('refuses a slip against an order that has finished', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    await move(order.orderId, 'cancelled', {
      payload: { reason: 'ยกเลิก' },
      closeSchedule: true,
    });

    /*
     * 0007 predicted this trigger would attach with `'{awaiting_payment}'`. That guess is
     * wrong once there is a deposit — the balance is transferred while the order is
     * already in production — so the list is five statuses. What must be refused is the
     * finished contract: money arriving on a cancelled order is a reconciliation
     * exception, not a payment.
     */
    await expectViolation(uploadSlip(order.orderId, DEPOSIT), PG.restrictViolation);
  });

  it('refuses a reviewer who is the submitter', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    /*
     * ⚠️ `storage_key` is present, and that is not decoration. `payment_slips_evidence_exists`
     * (0047) also raises 23514, so a row with no image *and* no reason would fail this assertion
     * for the wrong constraint and go on passing after somebody deleted the two-person CHECK.
     * The mutation that proves it: drop `payment_slips_reviewer_is_not_submitter` and this test
     * goes red only because the evidence arm is satisfied here.
     */
    await expectViolation(
      db.execute(sql`
        insert into payment_slips
          (order_id, amount_thb_minor, transferred_at, submitted_by_user_id,
           reviewed_by_user_id, reviewed_at, status, storage_key)
        values (${order.orderId}, ${DEPOSIT}, now(), ${staffA}, ${staffA}, now(), 'accepted',
                ${`test/self-${randomUUID()}.png`})
      `),
      PG.checkViolation,
    );
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * ⭐ 0047 — a payment recorded with no slip, and the declared bypass
   * ────────────────────────────────────────────────────────────────────────── */

  it('refuses a slip with no image, no erasure and no reason, and admits each of the three', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    /*
     * ⭐ The invariant `0047_slip_without_evidence.sql` exists for: **evidence exists in one of
     * three forms**. The owner's *"แต่ต้องระบุเหตุผล"* is not a form-validation rule that a second
     * writer can skip — it is a CHECK, so a script, a migration or a future service cannot record
     * a payment nobody can ever explain.
     */
    await expectViolation(
      db.execute(sql`
        insert into payment_slips (order_id, amount_thb_minor, transferred_at)
        values (${order.orderId}, ${DEPOSIT}, now())
      `),
      PG.checkViolation,
    );

    /* ① an image. ② an image that was erased — the PDPA row, which MUST stay legal. ③ a reason. */
    await db.execute(sql`
      insert into payment_slips (order_id, amount_thb_minor, transferred_at, storage_key)
      values (${order.orderId}, 100, now(), ${`test/e1-${randomUUID()}.png`})
    `);
    await db.execute(sql`
      insert into payment_slips (order_id, amount_thb_minor, transferred_at, storage_key_erased_at)
      values (${order.orderId}, 100, now(), now())
    `);
    await db.execute(sql`
      insert into payment_slips (order_id, amount_thb_minor, transferred_at, no_slip_reason_th)
      values (${order.orderId}, 100, now(), 'ลูกค้าโอนแล้วแจ้งทางโทรศัพท์ ไม่ได้แนบสลิป')
    `);

    /* And a reason made of spaces is the absence of a reason wearing a value. */
    await expectViolation(
      db.execute(sql`
        insert into payment_slips (order_id, amount_thb_minor, transferred_at, no_slip_reason_th)
        values (${order.orderId}, 100, now(), '    ')
      `),
      PG.checkViolation,
    );
  });

  it('lets one person review their own entry only when the row says why, in both enforcement points', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    /*
     * 🔒 THE BYPASS THE OWNER CHOSE, AND ITS PRICE.
     *
     * The database cannot see permissions — `payments.self_review_slip` is checked in the
     * application — so what these two statements pin is the half the database *can* guarantee:
     * self-review is never SILENT. The first is refused; the second, identical but for a written
     * reason, is admitted.
     *
     * ⚠️ It exercises the CHECK **and** the trigger, which is the whole reason both had to move
     * in one migration: `payment_slips_reviewer_is_not_submitter` sees `submitted_by_user_id`,
     * `payment_slips_guard_write()` calls `slip_submitter_user_ids()`. Amend one and the other
     * still refuses — a feature that passes in isolation and fails on the first real order.
     *
     * ⚠️ `rejected` and not `accepted`, and it is not laziness: an accepted slip must foot to its
     * allocations at COMMIT (`payment_slips_allocations_foot`), which would make this test about
     * that assertion instead. The rule under test covers *review*, not acceptance — a person who
     * could refuse their own entry could clear their own mistake off the queue before anybody saw
     * it, which is the same control failing in the quieter direction.
     */
    const silent = sql`
      insert into payment_slips
        (order_id, amount_thb_minor, transferred_at, submitted_by_user_id,
         reviewed_by_user_id, reviewed_at, status, rejected_reason_th, no_slip_reason_th)
      values (${order.orderId}, ${DEPOSIT}, now(), ${staffA}, ${staffA}, now(), 'rejected',
              'คีย์ผิดออร์เดอร์', 'ลูกค้าโอนแล้วแต่ไม่ได้แนบสลิป')
    `;
    await expectViolation(db.execute(silent), PG.checkViolation);

    const declared = await db.execute<{ id: string }>(sql`
      insert into payment_slips
        (order_id, amount_thb_minor, transferred_at, submitted_by_user_id,
         reviewed_by_user_id, reviewed_at, status, rejected_reason_th, no_slip_reason_th,
         self_review_reason_th)
      values (${order.orderId}, ${DEPOSIT}, now(), ${staffA}, ${staffA}, now(), 'rejected',
              'คีย์ผิดออร์เดอร์', 'ลูกค้าโอนแล้วแต่ไม่ได้แนบสลิป',
              'อยู่เวรคนเดียว ไม่มีใครตรวจให้ได้')
      returning id
    `);
    const slipId = declared.rows[0]?.id;
    expect(slipId, 'a declared self-review is admitted').toBeDefined();

    /*
     * ⭐ …and the declaration is FROZEN, which is the whole of "ตรวจสอบย้อนหลังได้". A reason
     * somebody can improve after the money landed is a draft, not a trail. Both new columns are
     * in `payment_slips_guard_write()`'s frozen list; remove either and one of these goes green.
     */
    await expectViolation(
      db
        .update(paymentSlips)
        .set({ selfReviewReasonTh: 'เขียนใหม่ทีหลัง' })
        .where(eq(paymentSlips.id, slipId ?? '')),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .update(paymentSlips)
        .set({ noSlipReasonTh: 'เขียนใหม่ทีหลัง' })
        .where(eq(paymentSlips.id, slipId ?? '')),
      PG.restrictViolation,
    );

    /* A declaration with no review behind it is not a declaration — `..._self_review_shape`. */
    await expectViolation(
      db.execute(sql`
        insert into payment_slips
          (order_id, amount_thb_minor, transferred_at, no_slip_reason_th, self_review_reason_th)
        values (${order.orderId}, 100, now(), 'ไม่มีสลิปเพราะลูกค้าไม่ได้ส่ง',
                'เหตุผลที่ไม่มีการตรวจอยู่เบื้องหลัง')
      `),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ledger — plan 7.8
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the ledger is append-only, two-legged, and a balance is a fold', () => {
  it('refuses a one-legged entry and an entry that does not balance', async () => {
    const order = await createDraft();
    await submit(order);

    await expectViolation(
      post(order.orderId, 'forfeited', [{ account: 'forfeited', amount: 100n }]),
      PG.restrictViolation,
    );

    // MUTATION (verified): drop `ledger_postings_balance` and this passes — ฿1 appears in
    // `revenue` from nowhere, every account still looks plausible on its own, and the only
    // symptom is a trial balance nobody runs.
    await expectViolation(
      post(order.orderId, 'forfeited', [
        { account: 'deposit_held', amount: 100n },
        { account: 'revenue', amount: -200n },
      ]),
      PG.restrictViolation,
    );
  });

  it('refuses a leg that arrives after the entry has already balanced', async () => {
    const order = await createDraft();
    await submit(order);
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    const entryId = await receiveCash(order.orderId, DEPOSIT, slipId);

    /*
     * The write that reaches `ledger_postings_balance` and nothing else: the entry
     * committed balanced in an earlier transaction, so the trigger on `ledger_entries`
     * has already fired and will never fire again. Nothing stops a third leg being added
     * to it later except this one.
     */
    await expectViolation(
      db.insert(ledgerPostings).values({
        entryId,
        orderId: order.orderId,
        legNo: 3,
        account: 'revenue',
        amountThbMinor: 1n,
      }),
      PG.restrictViolation,
    );
  });

  it('refuses an acceptance with no slip behind it', async () => {
    const order = await createDraft();
    await submit(order);

    // An unsourced credit: money appearing in the ledger with no evidence naming it.
    await expectViolation(
      db.insert(ledgerEntries).values({ orderId: order.orderId, kind: 'slip_accepted' }),
      PG.checkViolation,
    );
  });

  it('refuses an accepted slip with nobody accountable for accepting it', async () => {
    const order = await createDraft();
    await submit(order);

    // The single control in this design is a person. A slip accepted by nobody is the
    // control switched off with no record that it was.
    await expectViolation(
      db.execute(sql`
        insert into payment_slips (order_id, amount_thb_minor, transferred_at, status)
        values (${order.orderId}, ${DEPOSIT}, now(), 'accepted')
      `),
      PG.checkViolation,
    );
  });

  it('refuses to rewrite or delete anything, because every balance is a fold over it', async () => {
    const order = await createDraft();
    await submit(order);
    // `ledger_entries_slip_required`: an acceptance with no slip is an unsourced credit.
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    const entryId = await receiveCash(order.orderId, DEPOSIT, slipId);

    await expectViolation(
      db.update(ledgerEntries).set({ memoTh: 'แก้' }).where(eq(ledgerEntries.id, entryId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.delete(ledgerPostings).where(eq(ledgerPostings.entryId, entryId)),
      PG.restrictViolation,
    );

    expect(await scalar<string>(sql`order_cash_thb_minor(${order.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
    expect(await scalar<string>(sql`order_held_thb_minor(${order.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
  });

  it('keeps cash and settled apart when a bank fee is written off', async () => {
    /*
     * Plan 7.13: `paidMinor` and `settledMinor` are different numbers and every screen has
     * to say which it means. ฿5,529.60 leaves the customer, ฿5,499.60 arrives, the reviewer
     * settles the instalment in full and `settlement_variance` carries the ฿30.
     */
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    const fee = 3_000n;
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await post(
      order.orderId,
      'slip_accepted',
      [
        { account: 'bank_thb', amount: DEPOSIT - fee },
        { account: 'settlement_variance', amount: fee },
        { account: 'deposit_held', amount: -DEPOSIT },
      ],
      { slipId },
    );

    expect(await scalar<string>(sql`order_cash_thb_minor(${order.orderId})`)).toBe(
      (DEPOSIT - fee).toString(),
    );
    expect(await scalar<string>(sql`order_settled_thb_minor(${order.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
    // Both are right. Which one a screen means has to be said, every time.
    expect(DEPOSIT - fee).not.toBe(DEPOSIT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The forfeit — plan 7.8's ฿5,530 versus ฿18,432
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the forfeit is bounded by the obligation, not by the cash that happened to arrive', () => {
  it('forfeits the deposit obligation and not the whole payment', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);

    const ids = await instalmentIds(order.orderId);
    const [deposit, balance] = ids;
    if (!deposit || !balance) throw new Error('no instalments');

    // The customer pays the whole thing up front.
    const slipId = await uploadSlip(order.orderId, GRAND);
    await acceptSlip(slipId, [
      { instalmentId: deposit, amount: DEPOSIT },
      { instalmentId: balance, amount: BALANCE },
    ]);
    await receiveCash(order.orderId, GRAND, slipId);
    await move(order.orderId, 'production_confirmed');
    await move(order.orderId, 'in_production');
    await move(order.orderId, 'awaiting_installation');

    const forfeit = await scalar<string>(
      sql`order_forfeit_thb_minor(${order.orderId}, 'awaiting_installation', 'customer', ${fullForfeitPolicyId})`,
    );

    /*
     * ⚠️ THE FINDING, AS A NUMBER. ฿5,529.60 is the deposit obligation; ฿18,432.00 is the
     * cash in hand. Bounding by cash forfeits three times what was ever at risk.
     *
     * MUTATION (verified): change `base := least(received, obligation)` to
     * `base := received` and this returns 1843200 — the ฿18,432 the plan names.
     */
    expect(BigInt(forfeit)).toBe(DEPOSIT);
    expect(BigInt(forfeit)).not.toBe(GRAND);
    expect(GRAND - BigInt(forfeit)).toBe(1_290_240n); // ฿12,902.40 goes back

    // And the shipped default forfeits nothing at all, which is what plan 13 says to ship.
    const [shipped] = await db
      .select({ id: forfeitPolicies.id })
      .from(forfeitPolicies)
      .where(eq(forfeitPolicies.code, 'plan13_default'));
    if (!shipped) throw new Error('the default policy is missing');

    expect(
      await scalar<string>(
        sql`order_forfeit_thb_minor(${order.orderId}, 'awaiting_installation', 'customer', ${shipped.id})`,
      ),
    ).toBe('0');
  });

  it('forfeits nothing at the freeze point, and nothing when the company is at fault', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);
    await move(order.orderId, 'production_confirmed');

    /*
     * Plan 7.8: nothing is cut at the freeze point — aluminium is cut in `in_production` —
     * so a customer who confirms and changes their mind five minutes later must not lose
     * what a customer who waited for the finished goods loses.
     */
    expect(
      await scalar<string>(
        sql`order_forfeit_thb_minor(${order.orderId}, 'production_confirmed', 'customer', ${fullForfeitPolicyId})`,
      ),
    ).toBe('0');

    // And it is not a data-entry default: the CHECK makes a non-zero value there
    // unrepresentable, in any policy anybody writes.
    /*
     * One row each, and that matters: an UPDATE that sweeps every
     * `production_confirmed` row also touches its `company`-fault row, so the *other*
     * CHECK refuses it and the test stays green with this one dropped. Two overlapping
     * rules, each masking the other, is how a pair of guards ends up with no evidence
     * between them.
     */
    await expectViolation(
      db.execute(sql`
        update forfeit_policy_rules set forfeit_bp = 10000
         where policy_id = ${fullForfeitPolicyId}
           and from_status = 'production_confirmed' and fault = 'customer'
      `),
      PG.checkViolation,
    );
    await expectViolation(
      db.execute(sql`
        update forfeit_policy_rules set forfeit_bp = 5000
         where policy_id = ${fullForfeitPolicyId}
           and from_status = 'in_production' and fault = 'company'
      `),
      PG.checkViolation,
    );
  });

  it('refuses a policy with a missing cell, and has no ANY wildcard to hide behind', async () => {
    // Plan 7.8: 🚫 no `'ANY'`. A wildcard is a value no CHECK can define, and every answer
    // about which row wins is somebody's refund.
    await expectViolation(
      db.execute(sql`
        insert into forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp)
        values (${fullForfeitPolicyId}, 'ANY', 'customer', 0)
      `),
      PG.checkViolation,
    );

    // MUTATION (verified): drop `forfeit_policy_rules_complete` and this passes — an
    // effective policy with eleven of twelve cells, and the twelfth silently unpriced.
    await expectViolation(
      db.transaction(async (tx) => {
        const [policy] = await tx
          .insert(forfeitPolicies)
          .values({
            code: `incomplete_${randomUUID().slice(0, 8)}`,
            descriptionTh: 'ขาดช่อง redesign/customer',
            effectiveFrom: new Date(),
          })
          .returning({ id: forfeitPolicies.id });
        if (!policy) throw new Error('no policy');

        await tx.insert(forfeitPolicyRules).values(
          (['draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation'] as const).flatMap(
            (fromStatus) =>
              (['customer', 'company'] as const).map((fault) => ({
                policyId: policy.id,
                fromStatus,
                fault,
                forfeitBp: 0,
              })),
          ),
        );
      }),
      PG.restrictViolation,
    );
  });

  it('refuses to remove a cell from a policy that is already effective', async () => {
    /*
     * The write that reaches `forfeit_policy_rules_complete` and nothing else: the policy
     * row is untouched, so `forfeit_policies_complete` never fires. Without this trigger a
     * DELETE quietly leaves a live policy with a hole in it, and the hole is only found
     * the next time somebody cancels from that status.
     */
    await expectViolation(
      db.execute(sql`
        delete from forfeit_policy_rules
         where policy_id = ${fullForfeitPolicyId} and from_status = 'redesign' and fault = 'customer'
      `),
      PG.restrictViolation,
    );
  });

  it('reads the coverage set from the transition table, not from a list in the migration', async () => {
    // So a seventh cancellable status added by a future migration makes every effective
    // policy incomplete at once, loudly, instead of forfeiting nothing from a status
    // nobody remembered to price.
    const source = await db.execute<{ definition: string }>(sql`
      select prosrc as definition from pg_proc where proname = 'assert_forfeit_policy_complete'
    `);
    expect(source.rows[0]?.definition ?? '').toContain('order_status_transitions');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Carrying money to a revision — plan 7.8
// ─────────────────────────────────────────────────────────────────────────────

describeDb('money carried to a revision is an allocation on the ancestor, never a new instalment', () => {
  it('lets the revision fold the ancestor slip, and leaves the ancestor holding nothing new', async () => {
    const ancestor = await createDraft();
    await submit(ancestor);
    await thirtySeventy(ancestor.orderId);
    const [ancestorDeposit] = await instalmentIds(ancestor.orderId);
    if (!ancestorDeposit) throw new Error('no instalments');

    const slipId = await uploadSlip(ancestor.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: ancestorDeposit, amount: DEPOSIT }]);
    await receiveCash(ancestor.orderId, DEPOSIT, slipId);

    await move(ancestor.orderId, 'production_confirmed');

    // Bounce it to redesign and build the revision, which is the only route to superseded.
    const bounceId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(orderEvents).values({
        id: bounceId,
        orderId: ancestor.orderId,
        eventType: 'bounced_to_redesign',
        fromStatus: 'production_confirmed',
        toStatus: 'redesign',
        actorKind: 'staff',
        actorUserId: staffA,
        payload: { reason: 'ทำไม่ได้' },
      });
      await tx
        .update(orders)
        .set({ status: 'redesign', statusEventId: bounceId })
        .where(eq(orders.id, ancestor.orderId));
    });

    const revision = await createDraft({ supersedesOrderId: ancestor.orderId });
    await submit(revision);
    await thirtySeventy(revision.orderId);
    const [revisionDeposit] = await instalmentIds(revision.orderId);
    if (!revisionDeposit) throw new Error('no instalments on the revision');

    // The ancestor becomes `superseded`, which is the only status that lets its schedule
    // close while it still owes ฿12,902.40 it will never be paid.
    const supersedeId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(orderEvents).values({
        id: supersedeId,
        orderId: ancestor.orderId,
        eventType: 'superseded',
        fromStatus: 'redesign',
        toStatus: 'superseded',
        actorKind: 'staff',
        actorUserId: staffA,
        payload: { reason: 'ออกใบใหม่' },
      });
      await tx
        .update(orders)
        .set({ status: 'superseded', statusEventId: supersedeId })
        .where(eq(orders.id, ancestor.orderId));
      await tx
        .update(orderPaymentSchedules)
        .set({ closedAt: new Date(), closedReason: 'superseded' })
        .where(eq(orderPaymentSchedules.orderId, ancestor.orderId));
    });

    const [carried] = await db
      .select({ id: slipAllocations.id })
      .from(slipAllocations)
      .where(eq(slipAllocations.slipId, slipId));
    if (!carried) throw new Error('no allocation to carry');

    /*
     * ⚠️ THE CARRY IS A **MOVE** OF THE ANCESTOR'S ALLOCATION, NOT A SECOND ROW.
     *
     * Writing a second allocation row is what a literal reading of plan 7.8 suggests, and
     * it is refused — by `slip_allocations_foot`, for exactly the right reason: two rows
     * against one ฿5,529.60 slip sum to ฿11,059.20, which IS the same payment counted
     * twice. The plan's "not an instalment row on the new order" rule and its
     * "SUM(allocations) = slip amount" rule are the same rule, and the second one catches
     * the failure the first one describes even when it arrives through another table.
     *
     * So one payment keeps one allocation row, and the row moves forward.
     */
    await expectViolation(
      db.insert(slipAllocations).values({
        slipId,
        instalmentId: revisionDeposit,
        amountThbMinor: DEPOSIT,
        carriedFromOrderId: ancestor.orderId,
      }),
      PG.restrictViolation,
    );

    /*
     * And the move has to SAY where the money came from. This is the one write where that
     * rule is observable on its own: the revision really is a descendant, so the ancestry
     * check passes and only the missing `carried_from_order_id` can refuse it. Allocating
     * to an unrelated order trips the ancestry check first and proves the wrong guard.
     */
    await expectViolation(
      db
        .update(slipAllocations)
        .set({ instalmentId: revisionDeposit })
        .where(eq(slipAllocations.id, carried.id)),
      PG.restrictViolation,
    );

    await db
      .update(slipAllocations)
      .set({ instalmentId: revisionDeposit, carriedFromOrderId: ancestor.orderId })
      .where(eq(slipAllocations.id, carried.id));

    // One payment, allocated exactly once: the revision holds it and the ancestor does not.
    expect(await scalar<string>(sql`order_settled_thb_minor(${revision.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
    expect(await scalar<string>(sql`order_settled_thb_minor(${ancestor.orderId})`)).toBe('0');

    /*
     * ⚠️ AND THE BRANCH MUST BE `held`, NOT `cash`. The carry has no cash leg — the money
     * arrived on the ancestor — so the revision's cash is zero and stays zero. Every
     * "have we been paid?" that asks about cash answers wrongly here, consistently.
     */
    await post(revision.orderId, 'carried_forward', [
      { account: 'credit_clearing', amount: DEPOSIT },
      { account: 'deposit_held', amount: -DEPOSIT },
    ]);

    expect(await scalar<string>(sql`order_cash_thb_minor(${revision.orderId})`)).toBe('0');
    expect(await scalar<string>(sql`order_held_thb_minor(${revision.orderId})`)).toBe(
      DEPOSIT.toString(),
    );

    // And the ancestor's cash is untouched: the ledger remembers where the money arrived.
    expect(await scalar<string>(sql`order_cash_thb_minor(${ancestor.orderId})`)).toBe(
      DEPOSIT.toString(),
    );
  });

  it('refuses money moving sideways, and refuses a carry that does not name its ancestor', async () => {
    const first = await createDraft();
    await submit(first);
    await thirtySeventy(first.orderId);
    const [firstDeposit] = await instalmentIds(first.orderId);
    if (!firstDeposit) throw new Error('no instalments');

    const stranger = await createDraft();
    await submit(stranger);
    await thirtySeventy(stranger.orderId);
    const [strangerDeposit] = await instalmentIds(stranger.orderId);
    if (!strangerDeposit) throw new Error('no instalments');

    /*
     * ⚠️ The slip is for TWICE the deposit and is split across the two orders, so the
     * allocations foot to it exactly and the deferred sum assertion has nothing to say.
     * That isolation is the point: allocate a single deposit to a stranger and the sum
     * assertion refuses it whether or not the ancestry check exists, and the test proves
     * the wrong guard.
     */
    const slipId = await uploadSlip(first.orderId, DEPOSIT * 2n);

    await expectViolation(
      db.transaction(async (tx) => {
        await tx
          .update(paymentSlips)
          .set({ status: 'accepted', reviewedByUserId: staffA, reviewedAt: new Date() })
          .where(eq(paymentSlips.id, slipId));
        await tx.insert(slipAllocations).values([
          { slipId, instalmentId: firstDeposit, amountThbMinor: DEPOSIT },
          {
            slipId,
            instalmentId: strangerDeposit,
            amountThbMinor: DEPOSIT,
            carriedFromOrderId: first.orderId,
          },
        ]);
      }),
      PG.restrictViolation,
    );

    // And a cross-order allocation that says nothing about where the money came from.
    await expectViolation(
      db.transaction(async (tx) => {
        await tx.insert(slipAllocations).values([
          { slipId, instalmentId: firstDeposit, amountThbMinor: DEPOSIT },
          { slipId, instalmentId: strangerDeposit, amountThbMinor: DEPOSIT },
        ]);
      }),
      PG.restrictViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refunds — plan 7.12
// ─────────────────────────────────────────────────────────────────────────────

describeDb('a refund freezes its amount and payee the moment it leaves `requested`', () => {
  const accrue = async (orderId: string, amount: bigint): Promise<string> =>
    post(orderId, 'refund_accrued', [
      { account: 'deposit_held', amount },
      { account: 'refund_payable', amount: -amount },
    ]);

  const request = async (orderId: string, amount: bigint): Promise<string> => {
    const entryId = await accrue(orderId, amount);
    const [refund] = await db
      .insert(refunds)
      .values({
        orderId,
        accrualEntryId: entryId,
        amountThbMinor: amount,
        payeeName: 'สมชาย ใจดี',
        payeeBankCode: 'KBANK',
        payeeAccountLast4: '4321',
        /*
         * `staffC`, not `staffA`. Every slip in this file is accepted by `staffA`, and
         * `refunds_requester_did_not_take_the_money` (0014) refuses a refund requested by
         * whoever accepted the payment — the outbound half of "money in and money out are
         * different people". A fixture that used one id for both would be exercising the new
         * rule by accident in every refund test and asserting it in none.
         */
        requestedByUserId: staffC,
      })
      .returning({ id: refunds.id });
    if (!refund) throw new Error('could not request a refund');
    return refund.id;
  };

  it('refuses to change the amount or the destination account after approval', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);

    const refundId = await request(order.orderId, 359_400n);
    await db
      .update(refunds)
      .set({ status: 'approved', approvedByUserId: staffB, approvedAt: new Date() })
      .where(eq(refunds.id, refundId));

    /*
     * ⚠️ PLAN 7.12's SHARPEST FINDING: approve ฿3,594, then edit the row to ฿359,400 and
     * change the destination account — and the approval approved nothing.
     *
     * MUTATION (verified): remove the `payee_*` columns from the freeze list and the
     * amount stays protected while the money quietly goes somewhere else, which is the
     * half a reviewer is least likely to re-check.
     */
    await expectViolation(
      db
        .update(refunds)
        .set({ amountThbMinor: 35_940_000n })
        .where(eq(refunds.id, refundId)),
      PG.restrictViolation,
    );
    /*
     * ⚠️ REPORTED RATHER THAN ASSERTED: the amount is protected TWICE and the assertion
     * above cannot tell the two apart. Removing the amount from the freeze list leaves
     * this green, because `refunds_match_accrual` then refuses the new figure for not
     * matching the accrued obligation — and `accrual_entry_id` is itself frozen, so there
     * is no way to move both together. That is the design working; it is written down
     * because a green test with two mechanisms behind it is not evidence for either.
     * The payee below is protected once, and it is the assertion that goes red.
     */
    await expectViolation(
      db
        .update(refunds)
        .set({ payeeAccountLast4: '9999', payeeName: 'คนอื่น' })
        .where(eq(refunds.id, refundId)),
      PG.restrictViolation,
    );

    // The status still moves — that is what the row is for.
    await db
      .update(refunds)
      .set({
        status: 'disbursed',
        disbursedByUserId: staffC,
        disbursedAt: new Date(),
        disbursementReference: `OUT-${tag}`,
      })
      .where(eq(refunds.id, refundId));
  });

  /**
   * ⚠️ WRITTEN BECAUSE THE GUARD HAD NO EVIDENCE OF ITS OWN.
   *
   * Mutation, run this round: remove `amount_thb_minor` from `refunds_guard_write()`'s freeze
   * list and the whole suite stays **green**. The refusal above comes from `refunds_match_accrual`
   * — the amount no longer equals the accrual — so the freeze list's amount clause was covered
   * by a different mechanism and asserted by nothing. A guard nobody mutation-tested is a guard
   * nobody has evidence for, and this one turned out to be exactly that.
   *
   * The isolation is also the attack. `ledger_entries` is append-only but a *balanced* pair of
   * legs may be appended to an existing entry, so the accrual can be topped up to agree with a
   * larger figure — and then only the freeze list stands between an approved ฿1,000.00 and a
   * disbursed ฿10,000.00.
   */
  it('refuses to raise an approved amount even when the accrual is topped up to match', async () => {
    const order = await createDraft();
    await submit(order);
    const entryId = await accrue(order.orderId, 100_000n);

    const [refund] = await db
      .insert(refunds)
      .values({
        orderId: order.orderId,
        accrualEntryId: entryId,
        amountThbMinor: 100_000n,
        payeeName: 'สมชาย ใจดี',
        payeeBankCode: 'KBANK',
        payeeAccountLast4: '4321',
        requestedByUserId: staffC,
      })
      .returning({ id: refunds.id });
    if (!refund) throw new Error('could not request a refund');

    await db
      .update(refunds)
      .set({ status: 'approved', approvedByUserId: staffB, approvedAt: new Date() })
      .where(eq(refunds.id, refund.id));

    /* A balanced pair appended to the accrual entry: `refund_payable` now owes ฿10,000.00. */
    await db.insert(ledgerPostings).values([
      { entryId, orderId: order.orderId, legNo: 3, account: 'deposit_held', amountThbMinor: 900_000n },
      { entryId, orderId: order.orderId, legNo: 4, account: 'refund_payable', amountThbMinor: -900_000n },
    ]);

    /* `refunds_match_accrual` is satisfied by the new figure. Only the freeze is left. */
    await expectViolation(
      db.update(refunds).set({ amountThbMinor: 1_000_000n }).where(eq(refunds.id, refund.id)),
      PG.restrictViolation,
    );

    const after = await db
      .select({ amount: refunds.amountThbMinor })
      .from(refunds)
      .where(eq(refunds.id, refund.id));
    expect(after[0]?.amount).toBe(100_000n);
  });

  it('refuses an amount that does not equal what was accrued', async () => {
    const order = await createDraft();
    await submit(order);
    const entryId = await accrue(order.orderId, 100_000n);

    await expectViolation(
      db.insert(refunds).values({
        orderId: order.orderId,
        accrualEntryId: entryId,
        amountThbMinor: 900_000n,
        payeeName: 'สมชาย ใจดี',
        payeeBankCode: 'KBANK',
        payeeAccountLast4: '4321',
        requestedByUserId: staffA,
      }),
      PG.restrictViolation,
    );
  });

  /**
   * 🔒 WHOEVER SAID THE MONEY ARRIVED DOES NOT GET TO ASK FOR IT BACK — 5b red team, RT-3.
   *
   * One person with a plausible payments-officer permission set opened a cart anonymously,
   * uploaded a slip for money that never moved, accepted it themselves, cancelled, requested
   * the refund to their own account, took one approval click from a colleague and disbursed
   * it. `bank_thb` netted to zero — the fake money in and the real money out cancel exactly —
   * so no per-order balance check could ever have caught it.
   *
   * The acceptance half cannot be closed for an anonymous submitter, and `0013` says so in
   * those words. This is the leg where an identity always exists.
   *
   * It adds no approval point, which plan 7.13 warns is the way to kill the only control that
   * means anything: two employees still complete every refund — A accepts, B requests, A
   * approves, B disburses.
   */
  it('refuses a refund requested by whoever accepted the payment', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');
    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);

    const entryId = await accrue(order.orderId, DEPOSIT);
    await expectViolation(
      db.insert(refunds).values({
        orderId: order.orderId,
        accrualEntryId: entryId,
        amountThbMinor: DEPOSIT,
        payeeName: 'สมชาย ใจดี',
        payeeBankCode: 'KBANK',
        payeeAccountLast4: '4321',
        /* `staffA` is the reviewer `acceptSlip` names. */
        requestedByUserId: staffA,
      }),
      PG.restrictViolation,
    );

    /* And a colleague's request goes through, so this is a separation and not a wall. */
    const [ok] = await db
      .insert(refunds)
      .values({
        orderId: order.orderId,
        accrualEntryId: entryId,
        amountThbMinor: DEPOSIT,
        payeeName: 'สมชาย ใจดี',
        payeeBankCode: 'KBANK',
        payeeAccountLast4: '4321',
        requestedByUserId: staffC,
      })
      .returning({ id: refunds.id });
    expect(ok?.id).toBeDefined();
  });

  it('refuses the same approver as requester, and the same disburser as approver', async () => {
    const order = await createDraft();
    await submit(order);
    const refundId = await request(order.orderId, 100_000n);

    /* `staffC` is who `request` names — the rule is about that person, not about a role. */
    await expectViolation(
      db
        .update(refunds)
        .set({ status: 'approved', approvedByUserId: staffC, approvedAt: new Date() })
        .where(eq(refunds.id, refundId)),
      PG.checkViolation,
    );

    await db
      .update(refunds)
      .set({ status: 'approved', approvedByUserId: staffB, approvedAt: new Date() })
      .where(eq(refunds.id, refundId));

    await expectViolation(
      db
        .update(refunds)
        .set({
          status: 'disbursed',
          disbursedByUserId: staffB,
          disbursedAt: new Date(),
          disbursementReference: 'OUT',
        })
        .where(eq(refunds.id, refundId)),
      PG.checkViolation,
    );
  });

  it('refuses to disburse while money is still in transit', async () => {
    const order = await createDraft();
    await submit(order);
    const refundId = await request(order.orderId, 100_000n);
    await db
      .update(refunds)
      .set({ status: 'approved', approvedByUserId: staffB, approvedAt: new Date() })
      .where(eq(refunds.id, refundId));

    // Plan 7.11: an accepted slip for a cross-border transfer sits here for one to two
    // working days. A refund paid in that window is the company's own money going out
    // against money that has not arrived.
    const inflight = await uploadSlip(order.orderId, 500_000n);
    await post(
      order.orderId,
      'slip_accepted',
      [
        { account: 'remittance_in_transit', amount: 500_000n },
        { account: 'deposit_held', amount: -500_000n },
      ],
      { slipId: inflight },
    );

    await expectViolation(
      db
        .update(refunds)
        .set({
          status: 'disbursed',
          disbursedByUserId: staffC,
          disbursedAt: new Date(),
          disbursementReference: 'OUT',
        })
        .where(eq(refunds.id, refundId)),
      PG.restrictViolation,
    );
  });

  it('refuses a refund in a currency the company does not hold', async () => {
    const order = await createDraft();
    await submit(order);
    const entryId = await accrue(order.orderId, 100_000n);

    // Plan 7.12: refunding in đồng means buying đồng, which is taking an FX position
    // nobody decided to take.
    await expectViolation(
      db.execute(sql`
        insert into refunds (order_id, accrual_entry_id, amount_thb_minor, currency,
                             payee_name, payee_bank_code, payee_account_last4, requested_by_user_id)
        values (${order.orderId}, ${entryId}, 100000, 'VND', 'x', 'KBANK', '4321', ${staffA})
      `),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The queue — plan 7.8's terminal branch
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the staff queue tests the terminal status first', () => {
  it('puts a cancelled order that still holds money in its own visible bucket', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    const [deposit] = await instalmentIds(order.orderId);
    if (!deposit) throw new Error('no instalments');

    const slipId = await uploadSlip(order.orderId, DEPOSIT);
    await acceptSlip(slipId, [{ instalmentId: deposit, amount: DEPOSIT }]);
    await receiveCash(order.orderId, DEPOSIT, slipId);

    expect(await scalar<string>(sql`order_payment_queue_bucket(${order.orderId})`)).toBe(
      'awaiting_customer_transfer',
    );

    await move(order.orderId, 'cancelled', {
      payload: { reason: 'ยกเลิก' },
      closeSchedule: true,
    });

    /*
     * ⚠️ MUTATION (verified): move the terminal branch below the outstanding-balance test
     * and this returns `awaiting_customer_transfer` — a cancelled order sitting in
     * "waiting for the customer to pay" forever, holding ฿5,529.60 nobody refunds.
     */
    expect(await scalar<string>(sql`order_payment_queue_bucket(${order.orderId})`)).toBe(
      'terminal_holding_money',
    );
  });

  it('shows a submitted slip as waiting for review, not as waiting for the customer', async () => {
    const order = await createDraft();
    await submit(order);
    await thirtySeventy(order.orderId);
    await uploadSlip(order.orderId, DEPOSIT);

    expect(await scalar<string>(sql`order_payment_queue_bucket(${order.orderId})`)).toBe(
      'awaiting_review',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One code path for the three shapes — plan 7.5(ก)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('zero deposit, 30/70 and payment in full share one code path', () => {
  it('has no branches: one row, one row, two rows, and the same functions answer', async () => {
    // No deposit: a single `remainder` gating the freeze.
    const noDeposit = await createDraft();
    await submit(noDeposit, GRAND);
    await writeSchedule(noDeposit.orderId, [
      { seq: 1, basis: 'remainder', dueThbMinor: GRAND, gatesEntryTo: 'production_confirmed' },
    ]);

    // 100% deposit: the same single row, described the other way round.
    const fullDeposit = await createDraft();
    await submit(fullDeposit, GRAND);
    await writeSchedule(fullDeposit.orderId, [
      {
        seq: 1,
        basis: 'percent',
        percentBp: 10_000,
        dueThbMinor: GRAND,
        gatesEntryTo: 'production_confirmed',
      },
    ]);

    // And 30/70.
    const split = await createDraft();
    await submit(split);
    await thirtySeventy(split.orderId);

    for (const order of [noDeposit, fullDeposit, split]) {
      expect(
        await scalar<boolean>(sql`order_gate_is_open(${order.orderId}, 'production_confirmed')`),
      ).toBe(false);
      expect(await scalar<string>(sql`order_payment_queue_bucket(${order.orderId})`)).toBe(
        'awaiting_customer_transfer',
      );
    }
  });
});
