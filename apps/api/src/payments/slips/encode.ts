import { encodeThb } from '@wewin/contract/order';

import type {
  AllocationRow,
  InstalmentRow,
  OrderMoneyRow,
  RecordedSlipRow,
  SlipRow,
} from './slips.repository';
import { remainingOf } from './allocations';
import type {
  InstalmentSummaryWire,
  RecordedSlipEntryWire,
  SlipAllocationWire,
  SlipOrderMoneyWire,
  SlipWire,
} from './slips.contract';

/**
 * Rows to wire shapes, in one place, with the audience as an argument.
 *
 * ── Two audiences, derived from reach and never from the request ─────────────────
 *
 * The same rule `src/orders/encode.ts` applies to the spine. A customer is entitled to know
 * that their slip was rejected and why — that is the whole point of `rejected_reason_th`
 * being a required column — and is not entitled to the internal user id of the person who
 * rejected it, nor to the id of whoever uploaded it. Those two columns are the difference
 * between the views, and they are stripped here rather than in a controller so that a new
 * route cannot forget.
 *
 * The audience is computed from `orderReach(scope, 'read').kind === 'all'`, which is
 * exactly "this caller holds `orders.read` over the whole table" — the same fact that let
 * them load the order at all. There is no way to ask for the staff view without holding it.
 *
 * ── Money leaves as `MoneyWire<'THB'>`, always ───────────────────────────────────
 *
 * `encodeThb(bigint)` and never `Number(bigint)` and never a bare digit string: the unit
 * travels with the digits, which is `packages/contract/src/exact.ts`'s whole argument. There
 * is one exception in this file and it is not money — `settledThroughSeq` is an instalment
 * sequence, a small integer with a `seq >= 1` CHECK behind it, and a JSON number is the
 * honest shape for it.
 */

export type SlipAudience = 'staff' | 'customer';

export function encodeSlip(
  row: SlipRow,
  allocations: readonly AllocationRow[],
  audience: SlipAudience,
): SlipWire {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    amountThbMinor: encodeThb(row.amountThbMinor),
    currency: row.currency,
    transferredAt: row.transferredAt.toISOString(),
    bankReference: row.bankReference,
    payerName: row.payerName,
    payerAccountLast4: row.payerAccountLast4,
    /*
     * The storage key never crosses this wire. A client holding one would be a client
     * asking for a route that serves by key, and that route would be the one that ignores
     * which slip the caller is entitled to. Presence and erasure are the two facts a screen
     * needs; the bytes come through a signed grant.
     */
    hasImage: row.storageKey !== null,
    imageErasedAt: row.storageKeyErasedAt === null ? null : row.storageKeyErasedAt.toISOString(),
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    rejectedReasonTh: row.rejectedReasonTh,
    allocations: allocations
      .filter((allocation) => allocation.slipId === row.id)
      .map(encodeAllocation),
    createdAt: row.createdAt.toISOString(),
    /*
     * Money on this slip that closed no instalment. Visible to the customer as well as to
     * staff, deliberately: it is *their* money sitting against the order with no obligation
     * behind it, and the alternative is a customer who transferred ฿20,000.00 seeing ฿19,722.24
     * acknowledged and having to telephone about the rest.
     */
    unallocatedThbMinor: encodeThb(row.unallocatedThbMinor),
    /* Whether the payer on this slip is a reviewer's reading or the payer's own typing. */
    payerVerified: row.payerVerifiedByUserId !== null,
    submittedByUserId: audience === 'staff' ? row.submittedByUserId : null,
    reviewedByUserId: audience === 'staff' ? row.reviewedByUserId : null,
    /*
     * ⭐ Why there is no image — and it crosses to the customer, deliberately.
     *
     * The rule this file already follows is reasons out, identities withheld: `rejectedReasonTh`
     * is on a customer's copy and `reviewedByUserId` is not. A customer who finds a payment on
     * their own order that they never sent a slip for is owed the sentence explaining it, and
     * withholding it produces the telephone call the whole feature exists to avoid.
     */
    noSlipReasonTh: row.noSlipReasonTh,
    /*
     * 🔒 …and the one reason that does NOT cross, which is worth stating rather than leaving to
     * look inconsistent with the line above.
     *
     * This sentence is not about the customer's payment. It is about how the company staffed its
     * payments desk that day — an internal control note the customer can neither act on nor is
     * entitled to. `noSlipReasonTh` above is the half that is about their money.
     */
    selfReviewReasonTh: audience === 'staff' ? row.selfReviewReasonTh : null,
    /*
     * Both columns come from the same left join in `SlipsRepository` (`RECEIVING_ACCOUNT_JOIN`)
     * and are `null` together — a slip with no receiving account on file has neither a code nor
     * a name to report, never one without the other.
     */
    receivedBankAccount:
      row.receivedBankAccountCode === null || row.receivedBankAccountName === null
        ? null
        : { bankCode: row.receivedBankAccountCode, accountName: row.receivedBankAccountName },
  };
}

/**
 * ⭐ One row of the audit list — `GET /payments/slips/recorded`.
 *
 * Staff audience, always, and there is no argument for it: the route requires `payments.read`
 * plus `orders.read`, which is precisely the reach `audienceFor` computes to `'staff'`. Passing
 * the audience in would be offering a customer view of a screen no customer can reach.
 *
 * The two actor objects are `null` rather than `{ userId, name: null }` when there is nobody:
 * "not reviewed yet" and "reviewed by an account with no display name" are different facts and a
 * list about accountability must not render them the same way.
 */
export function encodeRecordedSlip(row: RecordedSlipRow): RecordedSlipEntryWire {
  const actor = (
    userId: string | null,
    name: string | null,
  ): RecordedSlipEntryWire['recordedBy'] => (userId === null ? null : { userId, name });

  return {
    slip: encodeSlip(row.slip, [], 'staff'),
    orderId: row.slip.orderId,
    orderNo: row.orderNo,
    orderStatus: row.orderStatus,
    recordedBy: actor(row.slip.submittedByUserId, row.recordedByName),
    reviewedBy: actor(row.slip.reviewedByUserId, row.reviewedByName),
    selfReviewed: row.selfReviewed,
  };
}

function encodeAllocation(row: AllocationRow): SlipAllocationWire {
  return {
    instalmentId: row.instalmentId,
    instalmentSeq: row.instalmentSeq,
    amountThbMinor: encodeThb(row.amountThbMinor),
    carriedFromOrderId: row.carriedFromOrderId,
  };
}

export function encodeMoney(row: OrderMoneyRow): SlipOrderMoneyWire {
  return {
    paidThbMinor: encodeThb(row.paidThbMinor),
    heldThbMinor: encodeThb(row.heldThbMinor),
    settledThbMinor: encodeThb(row.settledThbMinor),
    outstandingThbMinor: encodeThb(row.outstandingThbMinor),
    writtenOffThbMinor: encodeThb(row.writtenOffThbMinor),
    settledThroughSeq: row.settledThroughSeq,
    queueBucket: row.queueBucket,
  };
}

export function encodeInstalment(row: InstalmentRow): InstalmentSummaryWire {
  const remaining = remainingOf({
    id: row.id,
    seq: row.seq,
    dueThbMinor: row.dueThbMinor,
    allocatedThbMinor: row.allocatedThbMinor,
  });

  return {
    id: row.id,
    seq: row.seq,
    basis: row.basis,
    dueThbMinor: encodeThb(row.dueThbMinor),
    allocatedThbMinor: encodeThb(row.allocatedThbMinor),
    remainingThbMinor: encodeThb(remaining),
    gatesEntryTo: row.gatesEntryTo,
    /*
     * The same predicate `order_settled_through()` applies per row: `due <= allocated`.
     * Written as `remaining === 0` here, which is the same test with the clamp already
     * applied — an over-allocated instalment is settled, and stays settled, rather than
     * reporting a negative remainder that a screen would render as a credit.
     */
    isSettled: remaining === 0n,
  };
}
