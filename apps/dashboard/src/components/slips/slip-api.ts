import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';
import type { AllocationRequest } from './allocation-plan';

/**
 * Every call the slip-review screens make.
 *
 * ⚠️ Shapes restated from `apps/api/src/payments/slips/slips.contract.ts` — same boundary
 * debt as the other feature clients, recorded in plan 12.1.
 */

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${what}: expected an array`);
  return value;
};

const asText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${what}: expected a string`);
  return value;
};

const asTextOrNull = (value: unknown, what: string): string | null =>
  value === null || value === undefined ? null : asText(value, what);

/** The unit is checked, never assumed — `THB.satang` and `THB.satang/m2` differ only by tag. */
const asSatang = (value: unknown, what: string): bigint => {
  const money = asRecord(value, what);
  if (money['unit'] !== 'THB.satang') {
    throw new TypeError(`${what}: expected THB.satang, got ${JSON.stringify(money['unit'])}`);
  }
  return BigInt(asText(money['digits'], `${what}.digits`));
};

const asSatangOrNull = (value: unknown, what: string): bigint | null =>
  value === null || value === undefined ? null : asSatang(value, what);

export interface Slip {
  readonly id: string;
  readonly orderId: string;
  readonly status: 'submitted' | 'accepted' | 'rejected';
  readonly amountThbMinor: bigint;
  /** What the customer says they transferred, and when. A claim until somebody reads the image. */
  readonly transferredAt: string;
  readonly bankReference: string | null;
  readonly payerName: string | null;
  readonly payerAccountLast4: string | null;
  /**
   * ⚠️ Whether a person has read the payer off the image.
   *
   * `payerName` arrives on the *customer's* create-slip body and nothing compares it to the
   * picture. Until a reviewer attests it, the name on this screen is a name the payer typed —
   * which is exactly the hole 5b red team RT-2 found in the refund path.
   */
  readonly payerVerified: boolean;
  readonly hasImage: boolean;
  readonly imageErasedAt: string | null;
  readonly reviewedAt: string | null;
  readonly rejectedReasonTh: string | null;
  readonly unallocatedThbMinor: bigint;
  readonly createdAt: string;
  /**
   * Which of the company's accounts received this transfer — F2's fix. `null` when the slip
   * predates the column or (in principle only) its account has since been deleted; the dialog
   * says so rather than leaving the row blank, because an older slip genuinely does not know.
   */
  readonly receivedBankAccount: { readonly bankCode: string; readonly accountName: string } | null;
}

export interface QueueEntry {
  readonly slip: Slip;
  readonly orderNo: string | null;
  readonly orderStatus: string;
  readonly queueBucket: string;
}

export interface Instalment {
  readonly id: string;
  readonly seq: number;
  readonly basis: string;
  readonly dueThbMinor: bigint;
  readonly allocatedThbMinor: bigint;
  readonly remainingThbMinor: bigint;
  readonly gatesEntryTo: string | null;
  readonly isSettled: boolean;
}

export interface SlipReview {
  readonly slip: Slip;
  readonly order: {
    readonly id: string;
    readonly orderNo: string | null;
    readonly status: string;
    readonly grandTotalThbMinor: bigint | null;
    readonly contactName: string | null;
    readonly frozenAt: string | null;
  };
  /**
   * ⚠️ Four numbers, each named so it cannot be mistaken for another.
   *
   * `paid` is cash that arrived; `settled` is what the instalments were credited. They differ
   * the first time a bank fee is written off — ฿10,000 leaves the customer, ฿9,970 arrives,
   * and `settlement_variance` carries the ฿30. Both are right. The screen labels which is
   * which, every time, because `0011_payment_guards.sql` says a screen that does not is how
   * two departments quote different figures.
   */
  readonly money: {
    readonly paidThbMinor: bigint;
    readonly heldThbMinor: bigint;
    readonly settledThbMinor: bigint;
    readonly outstandingThbMinor: bigint;
    readonly settledThroughSeq: number | null;
  };
  readonly instalments: readonly Instalment[];
  readonly comparison: {
    readonly slipAmountThbMinor: bigint;
    readonly expectedNextDueThbMinor: bigint | null;
    readonly differenceThbMinor: bigint | null;
  };
  /** What the server would allocate. Offered, never applied — the reviewer decides. */
  readonly suggestedAllocations: readonly { readonly instalmentId: string; readonly amountThbMinor: bigint }[] | null;
  readonly unallocatableReasonTh: string | null;
}

const decodeReceivedBankAccount = (
  value: unknown,
): { readonly bankCode: string; readonly accountName: string } | null => {
  if (value === null || value === undefined) return null;
  const account = asRecord(value, 'slip.receivedBankAccount');
  return {
    bankCode: asText(account['bankCode'], 'slip.receivedBankAccount.bankCode'),
    accountName: asText(account['accountName'], 'slip.receivedBankAccount.accountName'),
  };
};

const decodeSlip = (raw: unknown): Slip => {
  const slip = asRecord(raw, 'สลิป');

  return {
    id: asText(slip['id'], 'slip.id'),
    orderId: asText(slip['orderId'], 'slip.orderId'),
    status: asText(slip['status'], 'slip.status') as Slip['status'],
    amountThbMinor: asSatang(slip['amountThbMinor'], 'slip.amountThbMinor'),
    transferredAt: asText(slip['transferredAt'], 'slip.transferredAt'),
    bankReference: asTextOrNull(slip['bankReference'], 'slip.bankReference'),
    payerName: asTextOrNull(slip['payerName'], 'slip.payerName'),
    payerAccountLast4: asTextOrNull(slip['payerAccountLast4'], 'slip.payerAccountLast4'),
    payerVerified: slip['payerVerified'] === true,
    hasImage: slip['hasImage'] === true,
    imageErasedAt: asTextOrNull(slip['imageErasedAt'], 'slip.imageErasedAt'),
    reviewedAt: asTextOrNull(slip['reviewedAt'], 'slip.reviewedAt'),
    rejectedReasonTh: asTextOrNull(slip['rejectedReasonTh'], 'slip.rejectedReasonTh'),
    unallocatedThbMinor: asSatang(slip['unallocatedThbMinor'], 'slip.unallocatedThbMinor'),
    createdAt: asText(slip['createdAt'], 'slip.createdAt'),
    receivedBankAccount: decodeReceivedBankAccount(slip['receivedBankAccount']),
  };
};

export const listQueue = (limit = 200): Promise<readonly QueueEntry[]> =>
  apiJson(`/payments/slips?limit=${String(limit)}`, (body) =>
    asArray(asRecord(body, 'คิวสลิป')['entries'] ?? [], 'entries').map((raw) => {
      const entry = asRecord(raw, 'entry');
      return {
        slip: decodeSlip(entry['slip']),
        orderNo: asTextOrNull(entry['orderNo'], 'entry.orderNo'),
        orderStatus: asText(entry['orderStatus'], 'entry.orderStatus'),
        queueBucket: asText(entry['queueBucket'], 'entry.queueBucket'),
      };
    }),
  );

export const getReview = (slipId: string): Promise<SlipReview> =>
  apiJson(`/payments/slips/${slipId}`, (body) => {
    const review = asRecord(body, 'สลิป');
    const order = asRecord(review['order'], 'review.order');
    const money = asRecord(review['money'], 'review.money');
    const comparison = asRecord(review['comparison'], 'review.comparison');
    const suggested = review['suggestedAllocations'];

    return {
      slip: decodeSlip(review['slip']),
      order: {
        id: asText(order['id'], 'order.id'),
        orderNo: asTextOrNull(order['orderNo'], 'order.orderNo'),
        status: asText(order['status'], 'order.status'),
        grandTotalThbMinor: asSatangOrNull(order['grandTotalThbMinor'], 'order.grandTotalThbMinor'),
        contactName: asTextOrNull(order['contactName'], 'order.contactName'),
        frozenAt: asTextOrNull(order['frozenAt'], 'order.frozenAt'),
      },
      money: {
        paidThbMinor: asSatang(money['paidThbMinor'], 'money.paidThbMinor'),
        heldThbMinor: asSatang(money['heldThbMinor'], 'money.heldThbMinor'),
        settledThbMinor: asSatang(money['settledThbMinor'], 'money.settledThbMinor'),
        outstandingThbMinor: asSatang(money['outstandingThbMinor'], 'money.outstandingThbMinor'),
        settledThroughSeq:
          typeof money['settledThroughSeq'] === 'number' ? money['settledThroughSeq'] : null,
      },
      instalments: asArray(review['instalments'] ?? [], 'instalments').map((raw) => {
        const instalment = asRecord(raw, 'instalment');
        return {
          id: asText(instalment['id'], 'instalment.id'),
          seq: typeof instalment['seq'] === 'number' ? instalment['seq'] : 0,
          basis: asText(instalment['basis'], 'instalment.basis'),
          dueThbMinor: asSatang(instalment['dueThbMinor'], 'instalment.dueThbMinor'),
          allocatedThbMinor: asSatang(instalment['allocatedThbMinor'], 'instalment.allocatedThbMinor'),
          remainingThbMinor: asSatang(instalment['remainingThbMinor'], 'instalment.remainingThbMinor'),
          gatesEntryTo: asTextOrNull(instalment['gatesEntryTo'], 'instalment.gatesEntryTo'),
          isSettled: instalment['isSettled'] === true,
        };
      }),
      comparison: {
        slipAmountThbMinor: asSatang(comparison['slipAmountThbMinor'], 'comparison.slipAmountThbMinor'),
        expectedNextDueThbMinor: asSatangOrNull(
          comparison['expectedNextDueThbMinor'],
          'comparison.expectedNextDueThbMinor',
        ),
        differenceThbMinor: asSatangOrNull(
          comparison['differenceThbMinor'],
          'comparison.differenceThbMinor',
        ),
      },
      suggestedAllocations:
        suggested === null || suggested === undefined
          ? null
          : asArray(suggested, 'suggestedAllocations').map((raw) => {
              const allocation = asRecord(raw, 'allocation');
              return {
                instalmentId: asText(allocation['instalmentId'], 'allocation.instalmentId'),
                amountThbMinor: asSatang(allocation['amountThbMinor'], 'allocation.amountThbMinor'),
              };
            }),
      unallocatableReasonTh: asTextOrNull(
        review['unallocatableReasonTh'],
        'review.unallocatableReasonTh',
      ),
    };
  });

/**
 * A short-lived URL for the slip image.
 *
 * Two steps rather than one, and the reason is in `slip-images.controller.ts`: the image
 * itself is served anonymously off an unguessable grant, so the *permission* check happens
 * here — where a session exists — and the bytes are then reachable by an `<img>` tag, which
 * cannot carry an `Authorization` header.
 */
export const mintImageUrl = async (slipId: string): Promise<string> => {
  const response = await apiFetch(`/payments/slips/${slipId}/image-grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'view' }),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);

  const grant = asRecord(await response.json(), 'สิทธิ์ดูภาพ');
  return asText(grant['path'], 'grant.path');
};

export interface Acceptance {
  readonly allocations: readonly AllocationRequest[];
  readonly noteTh?: string;
  /** Read off the image by a person. Omitted leaves the payer unverified — which fails closed. */
  readonly payer?: { readonly name: string; readonly accountLast4: string };
  readonly acknowledgeOverpaymentThbMinor?: { readonly unit: 'THB.satang'; readonly digits: string };
}

export const acceptSlip = async (slipId: string, body: Acceptance): Promise<void> => {
  const response = await apiFetch(`/payments/slips/${slipId}/acceptance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};

export const rejectSlip = async (slipId: string, reasonTh: string): Promise<void> => {
  const response = await apiFetch(`/payments/slips/${slipId}/rejection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reasonTh: reasonTh.trim() }),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};
