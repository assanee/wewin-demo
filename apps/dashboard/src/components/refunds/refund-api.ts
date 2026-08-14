import 'client-only';

import { apiFetch, apiJson } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * Every call the refund screen makes.
 *
 * ⚠️ Shapes restated from `apps/api/src/payments/refunds/refunds.contract.ts`. Same boundary
 * debt as the other feature clients, recorded in plan 12.1.
 */

export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'disbursed';

export interface Refund {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: RefundStatus;
  /** Satang. */
  readonly amountThbMinor: bigint;
  readonly payeeName: string;
  readonly payeeBankCode: string;
  readonly payeeAccountLast4: string;
  /**
   * ⚠️ **Derived, never echoed from a request.**
   *
   * The service compares the payee against the order's accepted slips. A `no` is the system
   * saying it could not match this destination to any money that came in — which is what
   * makes the second approval meaningful rather than ceremonial.
   */
  readonly payeeIsOriginalAccount: 'yes' | 'no';
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly disbursedAt: string | null;
  readonly disbursementReference: string | null;
  readonly rejectedReasonTh: string | null;
}

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

const decodeRefund = (raw: unknown): Refund => {
  const refund = asRecord(raw, 'คำขอคืนเงิน');

  return {
    id: asText(refund['id'], 'refund.id'),
    orderId: asText(refund['orderId'], 'refund.orderId'),
    orderNo: asTextOrNull(refund['orderNo'], 'refund.orderNo'),
    status: asText(refund['status'], 'refund.status') as RefundStatus,
    /*
     * ⚠️ `amountThbMinor` travels as a bare digit string on this endpoint, not as a tagged
     * `MoneyWire`. Restated faithfully rather than "corrected": a decoder that insisted on
     * the tag would reject every refund the API actually sends. Noted here because the
     * inconsistency is the API's and worth fixing there, not papered over here.
     */
    amountThbMinor: BigInt(asText(refund['amountThbMinor'], 'refund.amountThbMinor')),
    payeeName: asText(refund['payeeName'], 'refund.payeeName'),
    payeeBankCode: asText(refund['payeeBankCode'], 'refund.payeeBankCode'),
    payeeAccountLast4: asText(refund['payeeAccountLast4'], 'refund.payeeAccountLast4'),
    payeeIsOriginalAccount:
      refund['payeeIsOriginalAccount'] === 'yes' ? 'yes' : 'no',
    requestedAt: asText(refund['requestedAt'], 'refund.requestedAt'),
    approvedAt: asTextOrNull(refund['approvedAt'], 'refund.approvedAt'),
    disbursedAt: asTextOrNull(refund['disbursedAt'], 'refund.disbursedAt'),
    disbursementReference: asTextOrNull(
      refund['disbursementReference'],
      'refund.disbursementReference',
    ),
    rejectedReasonTh: asTextOrNull(refund['rejectedReasonTh'], 'refund.rejectedReasonTh'),
  };
};

/**
 * How many rows one call can return.
 *
 * ⚠️ Exported rather than inlined because the *screen* needs it: `refund-focus.ts` totals the
 * payable queue, and a total taken from a full page is a partial sum that has to say so. A
 * constant only this file could see would make that caveat impossible to state.
 */
export const REFUND_PAGE_LIMIT = 200;

/**
 * `?payee=different` is the report plan 7.12 asks for: every refund going somewhere other
 * than the account that paid. Not a filter for convenience — a list somebody is meant to read.
 */
export const listRefunds = (filter: {
  readonly statuses?: readonly RefundStatus[];
  readonly payee?: 'any' | 'different';
}): Promise<readonly Refund[]> => {
  const query = new URLSearchParams();
  for (const status of filter.statuses ?? []) query.append('status', status);
  query.set('payee', filter.payee ?? 'any');
  query.set('limit', String(REFUND_PAGE_LIMIT));

  return apiJson(`/payments/refunds?${query.toString()}`, (body) =>
    asArray(asRecord(body, 'รายการคืนเงิน')['refunds'] ?? [], 'refunds').map(decodeRefund),
  );
};

const post = async (path: string, body: unknown): Promise<void> => {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await apiErrorFromResponse(response);
};

export const decideRefund = (refundId: string, body: Record<string, unknown>): Promise<void> =>
  post(`/payments/refunds/${refundId}/decision`, body);

/**
 * Record the transfer that actually happened.
 *
 * ⚠️ The reference is required and is not generated. Plan 7.12: *"ขาออกต้องเข้มเท่ากัน"* — a
 * refund marked paid with no reference is a refund nobody can find in a bank statement, and
 * the outbound half of the evidence a slip provides on the way in.
 */
export const disburseRefund = (refundId: string, disbursementReference: string): Promise<void> =>
  post(`/payments/refunds/${refundId}/disbursement`, {
    disbursementReference: disbursementReference.trim(),
  });
