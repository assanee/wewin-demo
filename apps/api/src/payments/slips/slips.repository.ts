import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, asc, desc, eq, inArray, sql } from '@wewin/db/sql';
import {
  bankAccounts,
  orderInstalments,
  orders,
  paymentSlips,
  slipAllocations,
  type InstalmentBasis,
  type OrderStatus,
  type SlipStatus,
} from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import { withTranslatedSlipErrors } from './slip-errors';

/**
 * Every statement the slip lifecycle runs, and nothing about when it runs.
 *
 * The same split `src/orders/order.repository.ts` makes, for the same reason: **every write
 * here takes a transaction handle it did not open**, so the ordering rules — lock the order,
 * then the slip, then write the allocations, then the ledger, then move the order — are
 * readable in one place instead of being distributed across a dozen methods each with a
 * private opinion about whether it is atomic.
 *
 * ── There is no `findOrder` here, and there must not be ──────────────────────────
 *
 * Loading an order is `ScopedOrderRepository`'s job and this file has no second way to do
 * it. Plan 7.4 trap 2 is not "remember to check the owner", it is "the row you did not own
 * was never in the result set", and a `select().from(orders).where(eq(orders.id, …))` here
 * would be exactly the unscoped loader a future refactor hands to a review handler. The
 * reads below that mention `orders` at all select *computed* columns — folds and gate
 * predicates — for an id the caller has already loaded through a scoped query.
 *
 * ── The folds are the database's, never this file's ──────────────────────────────
 *
 * `paid`, `held`, `settled`, `outstanding`, the frontier and the queue bucket are six SQL
 * functions in `0011_payment_guards.sql`, and this repository calls them rather than
 * reimplementing any of them. Plan 7.13's finding was not that the formulas were wrong; it
 * was that there were three of them for one number, disagreeing by ฿12,902. A TypeScript
 * copy of `order_settled_through()` — even a correct one — would be the fourth.
 */

/** Drizzle names the transaction type nowhere public, so it is read off the callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Every user identity behind a slip's upload — **the same function the trigger uses**.
 *
 * `slip_submitter_user_ids()` unions `payment_slips.submitted_by_user_id` with the user who
 * claimed the submitting guest (`0013_payment_closure_guards.sql`). Calling it rather than
 * writing the union again in TypeScript is the point: the service refuses first, with a
 * sentence, and the trigger refuses whatever the service does — and a reimplementation here
 * would drop exactly the half that made the rule enforceable, which is how it was missing in
 * the first place.
 */
export interface SlipRow {
  readonly id: string;
  readonly orderId: string;
  readonly status: SlipStatus;
  readonly amountThbMinor: bigint;
  readonly currency: string;
  readonly transferredAt: Date;
  readonly bankReference: string | null;
  readonly storageKey: string | null;
  readonly storageKeyErasedAt: Date | null;
  readonly payerName: string | null;
  readonly payerAccountLast4: string | null;
  readonly submittedByUserId: string | null;
  /**
   * The guest who uploaded it, when nobody was signed in.
   *
   * Half of the two-person rule, and the half that was missing: `submitted_by_user_id` is NULL
   * for every guest slip, the guest funnel is the *main* funnel, and both enforcement points
   * compared against that one nullable column. See `payment_slips_guard_write()` in
   * `0013_payment_closure_guards.sql`.
   */
  readonly submittedByGuestId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly rejectedReasonTh: string | null;
  /** Money on this slip that closed no instalment. Zero on every slip that is not overpaid. */
  readonly unallocatedThbMinor: bigint;
  /** Who read the payer off the image and said it matched. Null means: nobody, so it is a claim. */
  readonly payerVerifiedByUserId: string | null;
  readonly payerVerifiedAt: Date | null;
  readonly createdAt: Date;
  /**
   * Which of the company's accounts received this transfer — F2's fix.
   *
   * Nullable for the reason `0027_organisation.sql` gives: no slip existed when the column
   * was added, so a slip from before it is genuinely ignorant of its own destination account,
   * not merely uninterested in stating it. `receivedBankAccountCode`/`Name` are `null` in that
   * same case and whenever the account has since been deleted — `on delete restrict` on the FK
   * makes the second case unreachable in practice, but the left join costs nothing to make it
   * safe anyway.
   */
  readonly receivedBankAccountId: string | null;
  readonly receivedBankAccountCode: string | null;
  readonly receivedBankAccountName: string | null;
  /**
   * ⭐ Why this payment has no image, when it has none — `0047_slip_without_evidence.sql`.
   *
   * Null on every customer slip, including one whose picture was erased for PDPA. Non-null is
   * the definition of "recorded without evidence" everywhere in this application, and
   * `payment_slips_evidence_exists` is what makes that definition exhaustive rather than a
   * convention: a row with no key, no erasure stamp and no reason cannot exist.
   */
  readonly noSlipReasonTh: string | null;
  /**
   * 🔒 Why the reviewer was also the submitter. Null on every slip two people handled.
   *
   * Written in the same statement as the review and frozen with it. Read `encodeSlip` for why
   * this one is staff-only while `noSlipReasonTh` is not.
   */
  readonly selfReviewReasonTh: string | null;
}

/**
 * One row of the audit list — `GET /payments/slips/recorded`.
 *
 * The two actor names come from two joins against `users` rather than from a second round trip,
 * because the question this list answers is *"who did this"* and an id is not an answer to it.
 */
export interface RecordedSlipRow {
  readonly slip: SlipRow;
  readonly orderNo: string | null;
  readonly orderStatus: OrderStatus;
  readonly recordedByName: string | null;
  readonly reviewedByName: string | null;
  /**
   * ⚠️ From `slip_submitter_user_ids()`, and never from `reviewed_by = submitted_by`.
   *
   * The column comparison is exactly the bug RT-1 found: it is blind to the guest cart that was
   * later signed into an account, which is the *main* funnel. An audit list that under-reports
   * is worse than no list, because somebody read it and stopped looking.
   */
  readonly selfReviewed: boolean;
}

export interface AllocationRow {
  readonly slipId: string;
  readonly instalmentId: string;
  readonly instalmentSeq: number;
  readonly amountThbMinor: bigint;
  readonly carriedFromOrderId: string | null;
}

export interface InstalmentRow {
  readonly id: string;
  readonly seq: number;
  readonly basis: InstalmentBasis;
  readonly dueThbMinor: bigint;
  /** Folded from **accepted** slips only. A submitted slip is a photograph, not money. */
  readonly allocatedThbMinor: bigint;
  readonly gatesEntryTo: OrderStatus | null;
}

export interface OrderMoneyRow {
  readonly paidThbMinor: bigint;
  readonly heldThbMinor: bigint;
  readonly settledThbMinor: bigint;
  readonly outstandingThbMinor: bigint;
  readonly settledThroughSeq: number | null;
  readonly queueBucket: string;
}

export interface QueueRow {
  readonly slip: SlipRow;
  readonly orderNo: string | null;
  readonly orderStatus: OrderStatus;
  readonly queueBucket: string;
}

const SLIP_COLUMNS = {
  id: paymentSlips.id,
  orderId: paymentSlips.orderId,
  status: paymentSlips.status,
  amountThbMinor: paymentSlips.amountThbMinor,
  currency: paymentSlips.currency,
  transferredAt: paymentSlips.transferredAt,
  bankReference: paymentSlips.bankReference,
  storageKey: paymentSlips.storageKey,
  storageKeyErasedAt: paymentSlips.storageKeyErasedAt,
  payerName: paymentSlips.payerName,
  payerAccountLast4: paymentSlips.payerAccountLast4,
  submittedByUserId: paymentSlips.submittedByUserId,
  submittedByGuestId: paymentSlips.submittedByGuestId,
  reviewedByUserId: paymentSlips.reviewedByUserId,
  reviewedAt: paymentSlips.reviewedAt,
  rejectedReasonTh: paymentSlips.rejectedReasonTh,
  unallocatedThbMinor: paymentSlips.unallocatedThbMinor,
  payerVerifiedByUserId: paymentSlips.payerVerifiedByUserId,
  payerVerifiedAt: paymentSlips.payerVerifiedAt,
  createdAt: paymentSlips.createdAt,
  receivedBankAccountId: paymentSlips.receivedBankAccountId,
  /*
   * From the left-joined account, not from `paymentSlips` — see `RECEIVING_ACCOUNT_JOIN`.
   * Both are `null` on a slip that predates the column and on the (practically unreachable,
   * `on delete restrict`-guarded) case of a deleted account, and the service renders that
   * honestly rather than treating it as blank.
   */
  receivedBankAccountCode: bankAccounts.bankCode,
  receivedBankAccountName: bankAccounts.accountName,
  noSlipReasonTh: paymentSlips.noSlipReasonTh,
  selfReviewReasonTh: paymentSlips.selfReviewReasonTh,
} as const;

/**
 * The join every `SLIP_COLUMNS` read applies, so `receivedBankAccountCode`/`Name` are never
 * selected without it — inlined at each call site rather than wrapped in a helper, because
 * drizzle's query builder narrows its own return type on every chained call and a generic
 * wrapper around `.leftJoin` cannot describe that narrowing without erasing it.
 *
 * `leftJoin`, not `innerJoin`: a slip with no receiving account on file — either because it
 * predates the column or, in principle, because the account was later removed — is still a
 * slip, and an inner join would silently drop it from every list.
 */
const RECEIVING_ACCOUNT_JOIN = [bankAccounts, eq(bankAccounts.id, paymentSlips.receivedBankAccountId)] as const;

@Injectable()
export class SlipsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Inside a transaction when there is one, outside when there is not.
   *
   * The optional handle is not convenience: a read taken inside the review's transaction
   * sees the allocations that transaction has just written, and the same read from a
   * controller assembling a response must not open a transaction of its own to get an
   * answer that is already committed.
   */
  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  /** The one door into a transaction, so a caller cannot forget to open one. */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return withTranslatedSlipErrors(() => this.db.transaction(run));
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async findSlip(slipId: string, tx?: Tx): Promise<SlipRow | undefined> {
    const [row] = await this.executor(tx)
      .select(SLIP_COLUMNS)
      .from(paymentSlips)
      .leftJoin(...RECEIVING_ACCOUNT_JOIN)
      .where(eq(paymentSlips.id, slipId))
      .limit(1);
    return row;
  }

  /**
   * The same row, locked, inside a transaction the caller opened.
   *
   * ⚠️ **This is the second half of plan 7.4 trap 6 and it is not the important half.**
   * `FOR UPDATE` orders two reviewers pressing accept at the same instant; it forbids
   * nothing on its own. What forbids the second acceptance is `markAccepted`'s
   * `WHERE status = 'submitted'`, which is a compare-and-set and reports zero rows to a
   * caller that lost — and behind that, `payment_slips_guard_write()`, which refuses any
   * change to a slip that has left `submitted` whoever is asking.
   *
   * `FOR UPDATE OF payment_slips`, not a bare `for('update')`, once the receiving-account
   * join is here: Postgres refuses `FOR UPDATE` outright on the nullable side of an outer
   * join, and an unqualified lock clause tries to lock every table the query touches —
   * `bank_accounts` included. Naming the table keeps the lock exactly where trap 6 needs it.
   */
  async lockSlip(tx: Tx, slipId: string): Promise<SlipRow | undefined> {
    const [row] = await tx
      .select(SLIP_COLUMNS)
      .from(paymentSlips)
      .leftJoin(...RECEIVING_ACCOUNT_JOIN)
      .where(eq(paymentSlips.id, slipId))
      .limit(1)
      .for('update', { of: paymentSlips });
    return row;
  }

  /**
   * How many slips this order already carries, of any status.
   *
   * Any status, deliberately: a rejected slip still cost a write to the bucket, so counting
   * only the live ones would make the bound clearable by uploading rubbish and rejecting it.
   */
  async countSlips(orderId: string, tx?: Tx): Promise<number> {
    const [row] = await this.executor(tx)
      .select({ n: sql<string>`count(*)` })
      .from(paymentSlips)
      .where(eq(paymentSlips.orderId, orderId));

    return Number(row?.n ?? 0);
  }

  async listSlipsByOrder(orderId: string, tx?: Tx): Promise<SlipRow[]> {
    return this.executor(tx)
      .select(SLIP_COLUMNS)
      .from(paymentSlips)
      .leftJoin(...RECEIVING_ACCOUNT_JOIN)
      .where(eq(paymentSlips.orderId, orderId))
      .orderBy(asc(paymentSlips.transferredAt), asc(paymentSlips.id));
  }

  /**
   * The reviewer's queue: everything waiting, oldest transfer first.
   *
   * The queue bucket of each slip's order rides along, and that is plan 7.8's terminal
   * branch made visible rather than merely correct: an order cancelled while its slip sat
   * here reports `terminal_holding_money` (once money is on it) or `closed`, and the
   * reviewer sees that before they open the comparison screen.
   */
  async listSubmitted(limit: number, tx?: Tx): Promise<QueueRow[]> {
    const rows = await this.executor(tx)
      .select({
        ...SLIP_COLUMNS,
        orderNo: orders.orderNo,
        orderStatus: orders.status,
        queueBucket: sql<string>`order_payment_queue_bucket(${orders.id})`,
      })
      .from(paymentSlips)
      .innerJoin(orders, eq(orders.id, paymentSlips.orderId))
      .leftJoin(...RECEIVING_ACCOUNT_JOIN)
      .where(eq(paymentSlips.status, 'submitted'))
      .orderBy(asc(paymentSlips.transferredAt), asc(paymentSlips.id))
      .limit(limit);

    return rows.map(({ orderNo, orderStatus, queueBucket, ...slip }) => ({
      slip,
      orderNo,
      orderStatus,
      queueBucket,
    }));
  }

  async allocationsForSlips(slipIds: readonly string[], tx?: Tx): Promise<AllocationRow[]> {
    /* Drizzle's `inArray` with an empty array is a SQL syntax hazard, and the caller often has one. */
    if (slipIds.length === 0) return [];

    return this.executor(tx)
      .select({
        slipId: slipAllocations.slipId,
        instalmentId: slipAllocations.instalmentId,
        instalmentSeq: orderInstalments.seq,
        amountThbMinor: slipAllocations.amountThbMinor,
        carriedFromOrderId: slipAllocations.carriedFromOrderId,
      })
      .from(slipAllocations)
      .innerJoin(orderInstalments, eq(orderInstalments.id, slipAllocations.instalmentId))
      .where(inArray(slipAllocations.slipId, [...slipIds]))
      .orderBy(asc(orderInstalments.seq));
  }

  /**
   * The schedule, with what accepted slips have already put on each row.
   *
   * The `FILTER (WHERE status = 'accepted')` is the whole of the difference between this
   * and a number that would let a reviewer settle an instalment by uploading a photograph.
   * It is the same filter `order_settled_through()` uses, restated here because this query
   * needs the per-row figure the function does not return — and pinned against it by
   * `slips.pg.test.ts`, which asserts the frontier and this fold agree.
   */
  /**
   * Who, in user terms, uploaded this slip — direct submitter and guest-claimer alike.
   *
   * Empty for a slip uploaded by a guest nobody has claimed, which is the residual
   * `0013_payment_closure_guards.sql` writes down: nothing identity-based can catch an
   * anonymous submitter, and the outbound half of that walk is closed at the refund instead.
   */
  async submitterUserIds(slipId: string, tx?: Tx): Promise<readonly string[]> {
    const rows = await (tx ?? this.db).execute<{ user_id: string }>(
      sql`select user_id::text as user_id from slip_submitter_user_ids(${slipId}::uuid)`,
    );

    return rows.rows.map((row) => row.user_id);
  }

  async instalments(orderId: string, tx?: Tx): Promise<InstalmentRow[]> {
    const rows = await this.executor(tx)
      .select({
        id: orderInstalments.id,
        seq: orderInstalments.seq,
        basis: orderInstalments.basis,
        dueThbMinor: orderInstalments.dueThbMinor,
        gatesEntryTo: orderInstalments.gatesEntryTo,
        allocated: sql<string>`coalesce(sum(${slipAllocations.amountThbMinor}) filter (where ${paymentSlips.status} = 'accepted'), 0)`,
      })
      .from(orderInstalments)
      .leftJoin(slipAllocations, eq(slipAllocations.instalmentId, orderInstalments.id))
      .leftJoin(paymentSlips, eq(paymentSlips.id, slipAllocations.slipId))
      .where(eq(orderInstalments.orderId, orderId))
      .groupBy(
        orderInstalments.id,
        orderInstalments.seq,
        orderInstalments.basis,
        orderInstalments.dueThbMinor,
        orderInstalments.gatesEntryTo,
      )
      .orderBy(asc(orderInstalments.seq));

    return rows.map(({ allocated, ...instalment }) => ({
      ...instalment,
      allocatedThbMinor: BigInt(allocated),
    }));
  }

  /**
   * The six numbers, from the six functions that define them.
   *
   * `bigint` columns arrive from `pg` as strings, which is the driver being right: an int8
   * does not fit a JavaScript number and a driver that quietly produced one would lose a
   * satang somewhere above ฿90 trillion and nowhere before it. `BigInt()` here is the only
   * conversion.
   */
  async orderMoney(orderId: string, tx?: Tx): Promise<OrderMoneyRow | undefined> {
    const [row] = await this.executor(tx)
      .select({
        paid: sql<string>`order_cash_thb_minor(${orders.id})`,
        held: sql<string>`order_held_thb_minor(${orders.id})`,
        settled: sql<string>`order_settled_thb_minor(${orders.id})`,
        outstanding: sql<string>`order_outstanding_thb_minor(${orders.id})`,
        settledThrough: sql<number | null>`order_settled_through(${orders.id})`,
        queueBucket: sql<string>`order_payment_queue_bucket(${orders.id})`,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (row === undefined) return undefined;

    return {
      paidThbMinor: BigInt(row.paid),
      heldThbMinor: BigInt(row.held),
      settledThbMinor: BigInt(row.settled),
      outstandingThbMinor: BigInt(row.outstanding),
      settledThroughSeq: row.settledThrough === null ? null : Number(row.settledThrough),
      queueBucket: row.queueBucket,
    };
  }

  /**
   * ⚠️ `order_gate_is_open()` — *ever entered this status* **OR** the money gate is open now.
   *
   * Called and never reimplemented, because the first half of that disjunction is the part
   * a TypeScript copy would leave out. Plan 7.5(ค): a `remainder` instalment cannot be
   * locked, so a price rise after full payment pushes it above what has been allocated and
   * the frontier **moves backwards**. "A gate, once open, never closes" is false, and an
   * order already in production would otherwise be sitting behind a gate that had shut
   * behind it.
   */
  async gateIsOpen(orderId: string, status: OrderStatus, tx?: Tx): Promise<boolean> {
    const [row] = await this.executor(tx)
      .select({ open: sql<boolean>`order_gate_is_open(${orders.id}, ${status})` })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    return row?.open ?? false;
  }

  /** Is there an instalment that gates this status at all? See `SlipsService.gateDecision`. */
  async hasGate(orderId: string, status: OrderStatus, tx?: Tx): Promise<boolean> {
    const [row] = await this.executor(tx)
      .select({ id: orderInstalments.id })
      .from(orderInstalments)
      .where(and(eq(orderInstalments.orderId, orderId), eq(orderInstalments.gatesEntryTo, status)))
      .limit(1);

    return row !== undefined;
  }

  /* ---------------------------------------------------------------- *
   * Writing
   * ---------------------------------------------------------------- */

  /**
   * A submitted slip.
   *
   * `payment_slips_live_orders_only` fires here and takes a `FOR SHARE` on the order, which
   * is the database half of trap 6 — the half that holds when a second code path forgets to
   * take the row lock. The list it checks is five statuses and not `'{awaiting_payment}'`,
   * because with a deposit the balance slip arrives while the order is already in
   * production; what must be refused is a slip against a *finished* contract.
   */
  async insertSlip(
    tx: Tx,
    input: {
      readonly orderId: string;
      readonly amountThbMinor: bigint;
      readonly transferredAt: Date;
      readonly bankReference: string | null;
      /**
       * The object key, or `null` on a staff-recorded payment that never had a picture.
       *
       * ⚠️ Nullable here and required-in-practice on the customer path, because
       * `payment_slips_evidence_exists` decides the real rule and it is a *disjunction*: null
       * here is only legal beside a `noSlipReasonTh`. A second insert method for the staff case
       * would have been two writers of one table diverging the first time a column is added —
       * the seam plan 7.13 found three times. One writer, one CHECK, and the CHECK is the thing
       * that cannot be forgotten.
       */
      readonly storageKey: string | null;
      readonly payerName: string | null;
      readonly payerAccountLast4: string | null;
      readonly submittedByUserId: string | null;
      readonly submittedByGuestId: string | null;
      /** Which of the company's accounts this transfer names — task 13 fix round 1. */
      readonly receivedBankAccountId: string | null;
      /** ⭐ Why there is no image. Null on every slip that has one. */
      readonly noSlipReasonTh: string | null;
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(paymentSlips)
      .values({
        orderId: input.orderId,
        amountThbMinor: input.amountThbMinor,
        transferredAt: input.transferredAt,
        bankReference: input.bankReference,
        storageKey: input.storageKey,
        payerName: input.payerName,
        payerAccountLast4: input.payerAccountLast4,
        submittedByUserId: input.submittedByUserId,
        submittedByGuestId: input.submittedByGuestId,
        receivedBankAccountId: input.receivedBankAccountId,
        noSlipReasonTh: input.noSlipReasonTh,
      })
      .returning({ id: paymentSlips.id });

    if (!row) throw new Error('payments/slips: the slip could not be created');
    return row.id;
  }

  /**
   * ⭐ Every payment recorded with no slip, newest transfer first — the audit list.
   *
   * `no_slip_reason_th is not null` is the predicate, and `payment_slips_no_slip_idx` is the
   * partial index behind it, so this is a scan of the exceptions rather than of the payments.
   *
   * ⚠️ `selfReviewed` is a LATERAL against `slip_submitter_user_ids()` — the function the
   * trigger itself calls — and not `reviewed_by_user_id = submitted_by_user_id`. Written the
   * short way it would miss the guest cart later signed into an account, which is the case RT-1
   * walked end to end, and the list would quietly under-report the thing it exists to report.
   *
   * Every status. A recorded payment that was *rejected* is still an evidence-free entry
   * somebody made, and a list of only the successful ones hides the pattern an auditor is
   * looking for.
   */
  async listRecordedWithoutSlip(
    limit: number,
    selfReviewedOnly: boolean,
    tx?: Tx,
  ): Promise<RecordedSlipRow[]> {
    /*
     * Correlated scalar subqueries rather than two aliased joins against `users`. The rows here
     * are the exceptions — a handful, bounded by `limit` — so the join is not worth the second
     * name `users` would need in this query, and `@wewin/db/sql` deliberately re-exports a small
     * vocabulary that `alias` is not part of. Widening that export map for one list would be a
     * change to a shared surface for a local convenience.
     */
    /*
     * `display_name` and nothing else. `users` carries no address column — an address is an
     * `auth_identities` row and a person may hold several — so a fallback to one would be a third
     * join to pick an arbitrary member of a set. Null here means one of two things and the wire
     * says which: no user at all (`recordedBy` is null) or an account with no name on it, which
     * on an **erased** account is not an omission but a guarantee: `users_erased_has_no_name`.
     */
    const recordedByName = sql<string | null>`
      (select u.display_name from users u where u.id = ${paymentSlips.submittedByUserId})`;
    const reviewedByName = sql<string | null>`
      (select u.display_name from users u where u.id = ${paymentSlips.reviewedByUserId})`;

    const selfReviewed = sql<boolean>`exists (
      select 1 from slip_submitter_user_ids(${paymentSlips.id}) s
       where s.user_id = ${paymentSlips.reviewedByUserId}
    )`;

    const recorded = sql`${paymentSlips.noSlipReasonTh} is not null`;

    const rows = await this.executor(tx)
      .select({
        ...SLIP_COLUMNS,
        orderNo: orders.orderNo,
        orderStatus: orders.status,
        recordedByName,
        reviewedByName,
        selfReviewed,
      })
      .from(paymentSlips)
      .innerJoin(orders, eq(orders.id, paymentSlips.orderId))
      .leftJoin(...RECEIVING_ACCOUNT_JOIN)
      .where(selfReviewedOnly ? and(recorded, selfReviewed) : recorded)
      .orderBy(desc(paymentSlips.transferredAt), asc(paymentSlips.id))
      .limit(limit);

    return rows.map(
      ({ orderNo, orderStatus, recordedByName, reviewedByName, selfReviewed: isSelf, ...slip }) => ({
        slip,
        orderNo,
        orderStatus,
        recordedByName,
        reviewedByName,
        selfReviewed: isSelf,
      }),
    );
  }

  /**
   * Accept, as a compare-and-set.
   *
   * The `WHERE status = 'submitted'` is what makes two simultaneous reviewers produce one
   * acceptance and one 409 rather than two acceptances and a doubled ledger. Returning
   * `false` rather than throwing lets the service say *which* thing happened, in Thai, with
   * the slip's current status in it.
   */
  async markAccepted(
    tx: Tx,
    input: {
      readonly slipId: string;
      readonly reviewerId: string;
      /** The excess this slip could place nowhere. Zero on every ordinary acceptance. */
      readonly unallocatedThbMinor: bigint;
      /**
       * What the reviewer read off the image, when they read it.
       *
       * Written in the *same statement* as the review, because `payment_slips_guard_write()`
       * refuses an attestation by anybody other than the reviewer and refuses any change to a
       * slip that has already left `submitted`. There is therefore no window in which a payer
       * could be stamped verified by the person who typed it.
       */
      readonly payer: { readonly name: string; readonly accountLast4: string } | null;
      /**
       * 🔒 The declared bypass, written in the SAME statement as the review — and it has to be.
       *
       * `payment_slips_guard_write()` refuses reviewer-is-submitter when this column is null, and
       * refuses *any* change once the row has left `submitted`. So there is no order of two
       * statements that works: setting it first is refused by `payment_slips_self_review_shape`
       * (no reviewer yet), setting it after is refused by the freeze. One UPDATE or nothing,
       * which is exactly the property that makes the trail non-optional.
       */
      readonly selfReviewReasonTh: string | null;
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(paymentSlips)
      .set({
        status: 'accepted',
        reviewedByUserId: input.reviewerId,
        reviewedAt: new Date(),
        unallocatedThbMinor: input.unallocatedThbMinor,
        selfReviewReasonTh: input.selfReviewReasonTh,
        ...(input.payer === null
          ? {}
          : {
              payerName: input.payer.name,
              payerAccountLast4: input.payer.accountLast4,
              payerVerifiedByUserId: input.reviewerId,
              payerVerifiedAt: new Date(),
            }),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentSlips.id, input.slipId), eq(paymentSlips.status, 'submitted')))
      .returning({ id: paymentSlips.id });

    return updated.length === 1;
  }

  async markRejected(
    tx: Tx,
    input: {
      readonly slipId: string;
      readonly reviewerId: string;
      readonly reasonTh: string;
      /** The declared bypass — see `markAccepted`, which explains why it is this statement's. */
      readonly selfReviewReasonTh: string | null;
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(paymentSlips)
      .set({
        status: 'rejected',
        reviewedByUserId: input.reviewerId,
        reviewedAt: new Date(),
        rejectedReasonTh: input.reasonTh,
        selfReviewReasonTh: input.selfReviewReasonTh,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentSlips.id, input.slipId), eq(paymentSlips.status, 'submitted')))
      .returning({ id: paymentSlips.id });

    return updated.length === 1;
  }

  /**
   * The allocations, in one statement.
   *
   * `carried_from_order_id` is deliberately absent from every row this module writes. A
   * carry is a *move* of the ancestor's existing allocation onto the revision's instalment
   * (plan 7.8, and `slip_allocations_guard_write()` enforces the shape); it belongs to the
   * supersede path and never to a reviewer typing into a review screen, which is why
   * `planAllocations` refuses an instalment that is not this order's.
   */
  async insertAllocations(
    tx: Tx,
    rows: readonly { readonly slipId: string; readonly instalmentId: string; readonly amountThbMinor: bigint }[],
  ): Promise<void> {
    if (rows.length === 0) return;

    await tx.insert(slipAllocations).values(
      rows.map((row) => ({
        slipId: row.slipId,
        instalmentId: row.instalmentId,
        amountThbMinor: row.amountThbMinor,
      })),
    );
  }

  /**
   * The money arriving, as two legs that sum to zero.
   *
   *     debit  bank_thb       +A     cash is in the company's baht account
   *     credit deposit_held   −A     and it is the customer's until it is earned
   *
   * ⚠️ **SEAM — this is the only ledger write in this module, and it is here so that it can
   * be moved in one edit.** The ledger is 5b's, shared between three modules written in
   * parallel; if a `LedgerRepository` lands, this method's body becomes a call to it and
   * nothing else in this directory changes. Writing it here rather than waiting is
   * deliberate: without the posting, `order_held_thb_minor()` stays zero, and every forfeit
   * and refund downstream reads an order that holds no money while holding the customer's.
   *
   * `remittance_in_transit` is not used, and that is plan 13's default rather than an
   * omission: the foreign-currency line is closed, every slip here is THB, and a domestic
   * transfer that has cleared is cash. The account exists in the chart for the day it is
   * opened — see `LEDGER_ACCOUNTS`.
   */
  /**
   * Destroy the image, keep the row — plan 7.6's PDPA line, and the schema's own hint.
   *
   * `storage_key_erased_at` is what distinguishes a slip whose picture was deleted on
   * policy from one that never had a picture, and `payment_slips_erasure_shape` refuses the
   * two columns disagreeing. `payment_slips_guard_write()` permits exactly this change on a
   * reviewed slip and refuses putting a *new* key back, so an erasure cannot be undone by
   * re-uploading over it.
   */
  async eraseImage(tx: Tx, slipId: string): Promise<boolean> {
    const updated = await tx
      .update(paymentSlips)
      .set({ storageKey: null, storageKeyErasedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(paymentSlips.id, slipId), sql`${paymentSlips.storageKey} is not null`))
      .returning({ id: paymentSlips.id });

    return updated.length === 1;
  }
}
