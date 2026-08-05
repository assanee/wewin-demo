import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, asc, desc, eq, inArray, sql } from '@wewin/db/sql';
import {
  orderEvents,
  orders,
  paymentSlips,
  refunds,
  type FaultParty,
  type OrderStatus,
  type RefundStatus,
} from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import { withTranslatedPaymentErrors } from '../ledger';
import type { LedgerTx } from '../ledger';
import type { PayerOnRecord } from './payee';

/**
 * Every statement the refund flow reads or writes, and nothing about when it runs.
 *
 * The split from `refunds.service.ts` is the one `src/orders` makes and for the same reason:
 * every method here takes a transaction handle it did not open, so the ordering rules — lock
 * the order, read the spine, post the ledger, then insert the refund — are readable in one
 * place instead of being distributed across a dozen methods each with an opinion about whether
 * it is atomic.
 */

export interface CancelledOrderRow {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly grandTotalThbMinor: bigint | null;
  readonly scheduledDepositThbMinor: bigint | null;
}

/** The cancellation as the spine recorded it. `fault` comes from here or from nowhere. */
export interface CancellationOnSpine {
  readonly eventId: string;
  readonly fromStatus: OrderStatus;
  readonly fault: FaultParty;
}

export interface RefundRow {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: RefundStatus;
  readonly amountThbMinor: bigint;
  readonly currency: string;
  readonly accrualEntryId: string;
  readonly payeeName: string;
  readonly payeeBankCode: string;
  readonly payeeAccountLast4: string;
  readonly payeeIsOriginalAccount: 'yes' | 'no';
  readonly requestedByUserId: string;
  readonly requestedAt: Date;
  readonly approvedByUserId: string | null;
  readonly approvedAt: Date | null;
  readonly disbursedByUserId: string | null;
  readonly disbursedAt: Date | null;
  readonly disbursementReference: string | null;
  readonly rejectedReasonTh: string | null;
}

@Injectable()
export class RefundsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private executor(tx?: LedgerTx): LedgerTx {
    return tx ?? (this.db as unknown as LedgerTx);
  }

  async transaction<T>(run: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return withTranslatedPaymentErrors(() => this.db.transaction(run));
  }

  /* ---------------------------------------------------------------- *
   * Reading, before anything is written
   * ---------------------------------------------------------------- */

  /**
   * The order, locked.
   *
   * ⚠️ Unscoped, and it has to be: refunds are staff work behind `orders.refund`, and there is
   * no customer variant of this route. `src/orders/scope` exists because a customer may load
   * *their own* order; a refund queue is a list of other people's. The reach is the permission
   * on the route, and the route is the only door — which is the same argument
   * `notifications.repository.ts` makes for the dead-letter queue.
   *
   * The lock is what makes "compute the forfeit, then accrue it" atomic against a second
   * reviewer doing the same thing: without it two requests both read the same held balance and
   * both accrue it, and the order's `deposit_held` goes negative with two internally consistent
   * refunds pointing at it.
   */
  async lockOrder(tx: LedgerTx, orderId: string): Promise<CancelledOrderRow | undefined> {
    const [row] = await tx
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        grandTotalThbMinor: orders.grandTotalThbMinor,
        scheduledDepositThbMinor: orders.scheduledDepositThbMinor,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update');

    return row;
  }

  /**
   * 🔒 The cancellation, read from `order_events` — the only place `fault` may come from.
   *
   * Plan 7.8: *"`fault` ห้ามรับจาก request body — มันตัดสินว่าลูกค้าได้เงินคืนเท่าไร"*. 5a
   * derives it at the moment of cancellation from the actor and from an *unresolved* bounce
   * (`faultFor`, `hasUnresolvedBounce`) and writes it onto an append-only row that
   * `order_events_guard_insert` refuses without the key. This method reads that row. There is
   * no parameter on any method in this module through which a caller could supply it.
   *
   * The latest `cancelled` event wins: an order can be cancelled only once from a live status,
   * but reading `max(seq)` rather than `min` means a future reinstate-and-recancel is scored on
   * the cancellation being refunded rather than on the first one that ever happened.
   *
   * A pre-freeze cancellation carries no `fault` key at all — `order_status_transitions` marks
   * those `cancel_pre_freeze` with `required_payload_keys = {reason}` — and the absence is not
   * ambiguity: only a post-freeze cancellation by staff on an order with a recorded bounce may
   * be the company's fault, so anything else is the customer's. That default is applied here,
   * where it can be read, rather than by a `coalesce` in SQL where it cannot.
   */
  async cancellationOnSpine(
    tx: LedgerTx,
    orderId: string,
  ): Promise<CancellationOnSpine | undefined> {
    const [row] = await tx
      .select({
        eventId: orderEvents.id,
        fromStatus: orderEvents.fromStatus,
        payload: orderEvents.payload,
      })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.toStatus, 'cancelled')))
      .orderBy(desc(orderEvents.seq))
      .limit(1);

    if (row === undefined || row.fromStatus === null) return undefined;

    return {
      eventId: row.eventId,
      fromStatus: row.fromStatus,
      fault: faultOnEvent(row.payload),
    };
  }

  /**
   * The accounts money has actually arrived from, newest first.
   *
   * Accepted slips only. A `submitted` slip is a photograph and a `rejected` one is a
   * photograph somebody disbelieved; neither is evidence that an account paid anything, and
   * refunding to an account named on a rejected slip is the fraud path with an extra step.
   *
   * ⚠️ **AND ATTESTED SLIPS ONLY** — 5b red team, RT-2, the sharpest finding about this module.
   *
   * `payer_name` and `payer_account_last4` arrive on the *customer's own* create-slip body.
   * Nothing compared them to the image, to the bank reference, or to anything a bank said. So
   * whoever uploaded the slip chose the account that later read as "the account the money came
   * from": name a mule account, request the refund to the same mule account, and it comes back
   * `payeeIsOriginalAccount: 'yes'` — no reason required at request, no acknowledgement at
   * approval, and absent from the `?payee=different` report. Plan 7.12's entire fraud control,
   * switched off by the party it is a control against.
   *
   * `payer_verified_by_user_id` is a reviewer stating they read those two fields off the
   * picture (`0012_payment_closure.sql`, written only by the statement that accepts the slip).
   * An unattested payer is therefore no payer at all here, which makes an unverified refund
   * `no` — the answer that demands a reason and a separate acknowledgement. It fails into the
   * customer's inconvenience rather than into somebody else's bank account.
   */
  async acceptedPayers(tx: LedgerTx, orderId: string): Promise<readonly PayerOnRecord[]> {
    return tx
      .select({
        slipId: paymentSlips.id,
        payerName: paymentSlips.payerName,
        payerAccountLast4: paymentSlips.payerAccountLast4,
      })
      .from(paymentSlips)
      .where(
        and(
          eq(paymentSlips.orderId, orderId),
          eq(paymentSlips.status, 'accepted'),
          sql`${paymentSlips.payerVerifiedByUserId} is not null`,
        ),
      )
      .orderBy(desc(paymentSlips.transferredAt));
  }

  /**
   * The id of an accepted slip on this order that this very user reviewed, if there is one.
   *
   * The read behind `RefundsService.request`'s outbound separation of duties (RT-3). It returns
   * an id rather than a boolean so the refusal can name the slip: a person told "you cannot
   * request this refund" needs to know which of their own decisions is in the way, and a
   * reviewer who accepted a payment months ago will not otherwise remember.
   *
   * Accepted slips only, matching `acceptedPayers` above — a rejected slip is a decision that
   * moved no money, and disqualifying its reviewer would be ceremony rather than control.
   */
  async acceptedSlipReviewedBy(
    tx: LedgerTx,
    orderId: string,
    userId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: paymentSlips.id })
      .from(paymentSlips)
      .where(
        and(
          eq(paymentSlips.orderId, orderId),
          eq(paymentSlips.status, 'accepted'),
          eq(paymentSlips.reviewedByUserId, userId),
        ),
      )
      .limit(1);

    return row?.id;
  }

  /** Is there already a refund on this order that has not been settled one way or the other? */
  async openRefundId(tx: LedgerTx, orderId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), inArray(refunds.status, ['requested', 'approved'])))
      .limit(1);

    return row?.id;
  }

  /* ---------------------------------------------------------------- *
   * Writing
   * ---------------------------------------------------------------- */

  async insertRefund(
    tx: LedgerTx,
    input: {
      readonly orderId: string;
      readonly accrualEntryId: string;
      readonly amountThbMinor: bigint;
      readonly payeeName: string;
      readonly payeeBankCode: string;
      readonly payeeAccountLast4: string;
      readonly payeeIsOriginalAccount: 'yes' | 'no';
      readonly requestedByUserId: string;
    },
  ): Promise<string> {
    const id = randomUUID();

    await withTranslatedPaymentErrors(() =>
      tx.insert(refunds).values({
        id,
        orderId: input.orderId,
        accrualEntryId: input.accrualEntryId,
        amountThbMinor: input.amountThbMinor,
        payeeName: input.payeeName,
        payeeBankCode: input.payeeBankCode,
        payeeAccountLast4: input.payeeAccountLast4,
        payeeIsOriginalAccount: input.payeeIsOriginalAccount,
        requestedByUserId: input.requestedByUserId,
      }),
    );

    return id;
  }

  /**
   * The refund, locked, with the order number joined on for the queue.
   *
   * `FOR UPDATE OF refunds` and not a bare `for('update')`: the join is to `orders`, and locking
   * an order row from the refund path would take a lock the order lifecycle also wants, in the
   * opposite order from the one `lockOrder` takes it in. Two paths taking two rows in two orders
   * is the deadlock this codebase has not had yet.
   */
  async lockRefund(tx: LedgerTx, refundId: string): Promise<RefundRow | undefined> {
    const [row] = await tx
      .select(refundColumns)
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.id, refundId))
      .for('update', { of: refunds });

    return row === undefined ? undefined : toRefundRow(row);
  }

  async findRefund(refundId: string, tx?: LedgerTx): Promise<RefundRow | undefined> {
    const [row] = await this.executor(tx)
      .select(refundColumns)
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.id, refundId));

    return row === undefined ? undefined : toRefundRow(row);
  }

  /**
   * Move the status and stamp who did it — the only UPDATE this module makes to `refunds`.
   *
   * Every frozen column is absent from this statement by construction: the amount, the currency,
   * the order, the accrual entry and every payee column are simply not settable through it.
   * `refunds_guard_write()` refuses them anyway once the row has left `requested`, and neither
   * check is redundant — the trigger is the guarantee (it also covers a second writer nobody has
   * written yet), and this is the reason a reader of this file does not have to go and check.
   */
  async approve(tx: LedgerTx, refundId: string, approverUserId: string): Promise<boolean> {
    const updated = await withTranslatedPaymentErrors(() =>
      tx
        .update(refunds)
        .set({ status: 'approved', approvedByUserId: approverUserId, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(refunds.id, refundId), eq(refunds.status, 'requested')))
        .returning({ id: refunds.id }),
    );

    return updated.length === 1;
  }

  async reject(tx: LedgerTx, refundId: string, reasonTh: string): Promise<boolean> {
    const updated = await withTranslatedPaymentErrors(() =>
      tx
        .update(refunds)
        .set({ status: 'rejected', rejectedReasonTh: reasonTh, updatedAt: new Date() })
        .where(and(eq(refunds.id, refundId), eq(refunds.status, 'requested')))
        .returning({ id: refunds.id }),
    );

    return updated.length === 1;
  }

  async disburse(
    tx: LedgerTx,
    refundId: string,
    input: { readonly disburserUserId: string; readonly disbursementReference: string },
  ): Promise<boolean> {
    const updated = await withTranslatedPaymentErrors(() =>
      tx
        .update(refunds)
        .set({
          status: 'disbursed',
          disbursedByUserId: input.disburserUserId,
          disbursedAt: new Date(),
          disbursementReference: input.disbursementReference,
          updatedAt: new Date(),
        })
        .where(and(eq(refunds.id, refundId), eq(refunds.status, 'approved')))
        .returning({ id: refunds.id }),
    );

    return updated.length === 1;
  }

  /* ---------------------------------------------------------------- *
   * The queue
   * ---------------------------------------------------------------- */

  async list(filter: {
    readonly statuses?: readonly RefundStatus[] | undefined;
    readonly differentAccountOnly: boolean;
    readonly limit: number;
  }): Promise<readonly RefundRow[]> {
    const terms = [
      filter.statuses === undefined || filter.statuses.length === 0
        ? undefined
        : inArray(refunds.status, [...filter.statuses]),
      filter.differentAccountOnly ? eq(refunds.payeeIsOriginalAccount, 'no') : undefined,
    ].filter((term): term is NonNullable<typeof term> => term !== undefined);

    const rows = await this.db
      .select(refundColumns)
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(terms.length === 0 ? undefined : and(...terms))
      /* Oldest first: a payable queue sorted newest-first is a queue whose bottom is never read. */
      .orderBy(asc(refunds.requestedAt))
      .limit(filter.limit);

    return rows.map(toRefundRow);
  }

  /**
   * What the company currently owes and has not yet transferred, across every order.
   *
   * Folded from `refunds` and not from `refund_payable`, deliberately — they answer two
   * different questions and both are wanted. The ledger account is the accounting truth
   * (accruals that have been reversed have left it); this is the *promise* the company has made
   * to named people, which is what the queue is for. They agree whenever every accrual has a
   * live refund row, and when they disagree that is a reconciliation exception worth seeing.
   */
  async payableTotalThbMinor(): Promise<bigint> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${refunds.amountThbMinor}), 0)::text` })
      .from(refunds)
      .where(eq(refunds.status, 'approved'));

    return row === undefined ? 0n : BigInt(row.total);
  }
}

/* ------------------------------------------------------------------------- *
 * Shapes
 * ------------------------------------------------------------------------- */

const refundColumns = {
  id: refunds.id,
  orderId: refunds.orderId,
  orderNo: orders.orderNo,
  status: refunds.status,
  amountThbMinor: refunds.amountThbMinor,
  currency: refunds.currency,
  accrualEntryId: refunds.accrualEntryId,
  payeeName: refunds.payeeName,
  payeeBankCode: refunds.payeeBankCode,
  payeeAccountLast4: refunds.payeeAccountLast4,
  payeeIsOriginalAccount: refunds.payeeIsOriginalAccount,
  requestedByUserId: refunds.requestedByUserId,
  requestedAt: refunds.requestedAt,
  approvedByUserId: refunds.approvedByUserId,
  approvedAt: refunds.approvedAt,
  disbursedByUserId: refunds.disbursedByUserId,
  disbursedAt: refunds.disbursedAt,
  disbursementReference: refunds.disbursementReference,
  rejectedReasonTh: refunds.rejectedReasonTh,
} as const;

/**
 * Written out rather than derived from `refundColumns`, so a column whose type changes in
 * `packages/db` fails this file at compile time instead of widening silently.
 */
interface RefundSelection {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: RefundStatus;
  readonly amountThbMinor: bigint;
  readonly currency: string;
  readonly accrualEntryId: string;
  readonly payeeName: string;
  readonly payeeBankCode: string;
  readonly payeeAccountLast4: string;
  readonly payeeIsOriginalAccount: 'yes' | 'no';
  readonly requestedByUserId: string;
  readonly requestedAt: Date;
  readonly approvedByUserId: string | null;
  readonly approvedAt: Date | null;
  readonly disbursedByUserId: string | null;
  readonly disbursedAt: Date | null;
  readonly disbursementReference: string | null;
  readonly rejectedReasonTh: string | null;
}

/**
 * `payee_is_original_account` is `text` with a two-value CHECK, and drizzle's `{ enum }` narrows
 * it in TypeScript and *not* in Postgres — the exact gap `packages/db`'s own note records
 * finding by test on `forfeit_policy_rules.from_status`. There the CHECK was missing; here it
 * exists, so the ternary below is a no-op to the type checker and a real narrowing at runtime.
 *
 * It is written the safe way round on purpose: anything unrecognised becomes `'no'`, which is
 * the value that *demands* the extra approval. A default of `'yes'` would turn a corrupt row
 * into a refund to an unverified account that nobody was asked about.
 */
function toRefundRow(row: RefundSelection): RefundRow {
  return { ...row, payeeIsOriginalAccount: row.payeeIsOriginalAccount === 'yes' ? 'yes' : 'no' };
}

/**
 * 🔒 `fault`, from a jsonb payload written by 5a and by nothing else.
 *
 * Exported for one reason: it is the only guard in this module that cannot be reached through
 * the API. `order_events.payload` is `jsonb NOT NULL` and `order_events_guard_insert()` refuses a
 * `cancelled` event whose payload does not carry `reason`, which only an object can — so the
 * non-object branch below is unreachable over HTTP and a mutation of it stays green through
 * every end-to-end test. `tests/payments/refunds/fault.test.ts` is the independent evidence.
 *
 * Anything that is not the literal `'company'` is `'customer'`. Not a parse that throws: a
 * pre-freeze cancellation legitimately has no `fault` key at all, and the two cases — absent,
 * and present-but-unrecognised — have the same correct answer. The direction of the default is
 * the point: unrecognised must never mean `'company'`, because `'company'` is the value that
 * forfeits nothing and refunds everything.
 */
export function faultOnEvent(payload: unknown): FaultParty {
  if (typeof payload !== 'object' || payload === null) return 'customer';
  const value = (payload as Record<string, unknown>)['fault'];
  return value === 'company' ? 'company' : 'customer';
}
