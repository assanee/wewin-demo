import 'client-only';

import { apiJson } from '@/lib/api/client';
import {
  APPROVAL_DIMENSIONS_WIRE,
  decodeCeiling,
  decodeDimension,
  type ApprovalDimensionWire,
  type CeilingView,
  type DimensionAssessmentView,
} from '@/components/quotes/authority-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The approver's inbox — `GET /quotes/approvals/queue`, `/:id`, `POST /:id/decision`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ### ⭐ The queue is the server's answer, not this file's arithmetic
 *
 * `GET /quotes/approvals/queue` returns only the requests **this caller may actually decide** —
 * filtered by the two-person rule and by their own `authority_limits` ceiling, by the same
 * function (`apps/api/src/quotes/authority/approval-rights.ts`) that the decision endpoint
 * enforces. So there is no comparison in this folder between a concession and a ceiling, and
 * there must not be one: a client that decided for itself which buttons to show would be a
 * second implementation of the one control this system has, one network hop from the CHECK that
 * makes it true. `rights` on the detail response is read; it is never derived.
 *
 * The withheld counts exist for the opposite failure. A queue that silently dropped what the
 * reader cannot approve would say "nothing is waiting" on the day three requests are stuck above
 * every ceiling in the company — and `pendingTotal` in `approval-decision.ts` is what makes this
 * screen reconcile with the overview's `ใบเสนอราคารออนุมัติ` card instead of contradicting it.
 *
 * ### Why the shapes are narrowed here rather than imported
 *
 * The same reason `components/quotes/authority-api.ts` and `authority/authority-limits-api.ts`
 * both give: these types live in `apps/api/src/quotes/authority/authority.contract.ts`, whose
 * header says they move into `@wewin/contract` when somebody needs them in two places and that
 * *"the move is a copy"*. Reaching into `apps/api` from an app is what `turbo boundaries` exists
 * to stop becoming normal, and `zod` is not a dependency of `@wewin/dashboard`.
 *
 * **When these land in `@wewin/contract`, delete every decoder below and import the schemas.**
 *
 * `decodeCeiling` and `decodeDimension` are imported from `quotes/authority-api.ts` rather than
 * copied, because both carry *rules* — the three-way `known` discriminator and the outcome enum —
 * and a fourth copy of a rule is how two screens end up disagreeing about what `null` means. The
 * primitive narrowers below are local, which is what every other api module in this app does.
 *
 * ### ⚠️ Money is a bare digit string on these endpoints
 *
 * `@wewin/contract` sends `{"unit":"THB.satang","digits":"879100"}` so satang cannot be mistaken
 * for baht; this module's endpoints send `"879100"` and the API's own header defends that as "the
 * client widens as it chooses". `minorOf` is the one place it is widened and it refuses anything
 * that is not canonical digits, so a malformed amount is a decode failure rather than a `NaN` in
 * a ceiling.
 */

export const APPROVAL_STATUSES_WIRE = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatusWire = (typeof APPROVAL_STATUSES_WIRE)[number];

/**
 * ⭐ Why the caller may or may not decide — the server's word, mirroring `ApprovalRightsWire`.
 *
 * The list is closed here so that an unknown reason is a **decode failure** rather than a blank
 * sentence beside a live button. A response from an API one release ahead of this bundle that
 * invented `expired` must not render as "you may decide this".
 */
export const APPROVAL_RIGHT_REASONS_WIRE = [
  'may_decide',
  'not_an_approver',
  'already_decided',
  'own_request',
  'no_ceiling',
  'above_ceiling',
] as const;
export type ApprovalRightReasonWire = (typeof APPROVAL_RIGHT_REASONS_WIRE)[number];

export interface ApprovalRightsView {
  readonly mayApprove: boolean;
  readonly mayRefuse: boolean;
  readonly because: ApprovalRightReasonWire;
  /** The caller's ceiling in this request's dimension. `thbMinor: null` is no live grant at all. */
  readonly ceiling: CeilingView;
}

export interface ApprovalView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  /** ⭐ The quote this request was measured against. See `quoteRevisionNow` on the detail. */
  readonly quoteRevision: string;
  readonly documentRevision: number | null;
  readonly dimension: ApprovalDimensionWire;
  readonly status: ApprovalStatusWire;
  readonly concessionThbMinor: bigint;
  readonly reasonTh: string;
  readonly requestedByUserId: string;
  /** `null` when the actor's name has been erased — see `users.erase`. Never a placeholder. */
  readonly requestedByName: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNoteTh: string | null;
  readonly decidedCeilingThbMinor: bigint | null;
  readonly createdAt: string;
}

export interface ApprovalQueueView {
  readonly approvals: readonly ApprovalView[];
  readonly ceilings: {
    readonly margin: CeilingView;
    readonly cashflow: CeilingView;
  };
  readonly withheld: {
    readonly beyondYourAuthority: number;
    readonly yourOwnRequests: number;
  };
  /** True when there are more pending requests than one read covers — the counts are partial. */
  readonly isTruncated: boolean;
}

export interface ApprovalDetailView {
  readonly approval: ApprovalView;
  readonly rights: ApprovalRightsView;
  readonly liveConcession: {
    readonly margin: DimensionAssessmentView;
    readonly cashflow: DimensionAssessmentView;
    readonly hasMovedSinceRequest: boolean;
  };
  /**
   * ⭐ The quote's digest **now**. When it differs from `approval.quoteRevision`, approving grants
   * nothing at all — the decision names a quote that no longer exists. The screen says so before
   * the button is pressed.
   */
  readonly quoteRevisionNow: string;
}

/* ------------------------------------------------------------------ *
 * Narrowers — throw with the field name so `apiJson` turns it into MALFORMED
 * ------------------------------------------------------------------ */

const DIGITS = /^(?:0|[1-9][0-9]*)$/u;

const object = (input: unknown, what: string): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${what} is not an object`);
  }
  return input as Record<string, unknown>;
};

const str = (row: Record<string, unknown>, key: string, what: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`${what}.${key} is not a string`);
  return value;
};

/**
 * `null` and an absent key are the same answer — correct only where `null` carries no meaning of
 * its own (a name that was erased, a note nobody wrote). Every field below that uses it is one of
 * those; the fields where `null` is a *decision* are `ceiling.thbMinor` (handled by
 * `decodeCeiling`, which reads its discriminator) and `decidedCeilingThbMinor`, which is read
 * with `=== null` beside a `status` that says which case it is.
 */
const nullableStr = (row: Record<string, unknown>, key: string, what: string): string | null =>
  row[key] === null || row[key] === undefined ? null : str(row, key, what);

const bool = (row: Record<string, unknown>, key: string, what: string): boolean => {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`${what}.${key} is not a boolean`);
  return value;
};

/**
 * A whole count.
 *
 * ⚠️ `Number.isInteger` and not `typeof === 'number'`: `count(*)` in Postgres is `int8`, which
 * node-postgres hands back as a **string** unless the query casts it. The API casts (`::int`) and
 * `overview.pg.test.ts` walks every card asserting it — this is the same guard facing the other
 * way, so a regression there arrives here as a decode failure instead of `"3" + 1 === "31"`.
 */
const count = (row: Record<string, unknown>, key: string, what: string): number => {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${what}.${key} is not a whole count`);
  }
  return value;
};

/** ⚠️ Never `Number`: a concession in satang can exceed 2^53, and `'1e3'` must not parse. */
const minorOf = (row: Record<string, unknown>, key: string, what: string): bigint => {
  const value = row[key];
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new TypeError(`${what}.${key} is not an amount in THB minor units`);
  }
  return BigInt(value);
};

const nullableMinorOf = (
  row: Record<string, unknown>,
  key: string,
  what: string,
): bigint | null => (row[key] === null || row[key] === undefined ? null : minorOf(row, key, what));

const oneOf = <T extends string>(
  values: readonly T[],
  row: Record<string, unknown>,
  key: string,
  what: string,
): T => {
  const value = row[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`${what}.${key} is not one of ${values.join(', ')} (got ${String(value)})`);
  }
  return value as T;
};

const nullableInt = (row: Record<string, unknown>, key: string, what: string): number | null => {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${what}.${key} is not a whole number`);
  }
  return value;
};

export function decodeApproval(input: unknown): ApprovalView {
  const row = object(input, 'approval');
  const id = str(row, 'id', 'approval');
  const what = `approval ${id}`;

  return {
    id,
    orderId: str(row, 'orderId', what),
    orderNo: nullableStr(row, 'orderNo', what),
    quoteRevision: str(row, 'quoteRevision', what),
    documentRevision: nullableInt(row, 'documentRevision', what),
    dimension: oneOf(APPROVAL_DIMENSIONS_WIRE, row, 'dimension', what),
    status: oneOf(APPROVAL_STATUSES_WIRE, row, 'status', what),
    concessionThbMinor: minorOf(row, 'concessionThbMinor', what),
    reasonTh: str(row, 'reasonTh', what),
    requestedByUserId: str(row, 'requestedByUserId', what),
    requestedByName: nullableStr(row, 'requestedByName', what),
    decidedByUserId: nullableStr(row, 'decidedByUserId', what),
    decidedAt: nullableStr(row, 'decidedAt', what),
    decisionNoteTh: nullableStr(row, 'decisionNoteTh', what),
    decidedCeilingThbMinor: nullableMinorOf(row, 'decidedCeilingThbMinor', what),
    createdAt: str(row, 'createdAt', what),
  };
}

/**
 * ⚠️ `mayApprove` and `mayRefuse` are read as booleans, never inferred from `because`.
 *
 * A decoder that reconstructed them — "`because === 'may_decide'` means both" — would be this
 * client re-deriving the rule from a label, which is the exact move the API's `rights` field
 * exists to remove. A response missing either flag is malformed, not permissive: `bool` throws,
 * `apiJson` turns it into MALFORMED, and the screen shows an error instead of a live button.
 */
export function decodeRights(input: unknown, what: string): ApprovalRightsView {
  const row = object(input, what);

  return {
    mayApprove: bool(row, 'mayApprove', what),
    mayRefuse: bool(row, 'mayRefuse', what),
    because: oneOf(APPROVAL_RIGHT_REASONS_WIRE, row, 'because', what),
    ceiling: decodeCeiling(row['ceiling'], `${what}.ceiling`),
  };
}

export function decodeQueue(input: unknown): ApprovalQueueView {
  const row = object(input, 'approval queue');
  const approvals = row['approvals'];
  if (!Array.isArray(approvals)) throw new TypeError('approval queue has no approvals array');

  const ceilings = object(row['ceilings'], 'approval queue.ceilings');
  const withheld = object(row['withheld'], 'approval queue.withheld');

  return {
    approvals: approvals.map(decodeApproval),
    ceilings: {
      margin: decodeCeiling(ceilings['margin'], 'approval queue.ceilings.margin'),
      cashflow: decodeCeiling(ceilings['cashflow'], 'approval queue.ceilings.cashflow'),
    },
    withheld: {
      beyondYourAuthority: count(withheld, 'beyondYourAuthority', 'approval queue.withheld'),
      yourOwnRequests: count(withheld, 'yourOwnRequests', 'approval queue.withheld'),
    },
    isTruncated: bool(row, 'isTruncated', 'approval queue'),
  };
}

export function decodeApprovalDetail(input: unknown): ApprovalDetailView {
  const row = object(input, 'approval detail');
  const live = object(row['liveConcession'], 'approval detail.liveConcession');

  return {
    approval: decodeApproval(row['approval']),
    rights: decodeRights(row['rights'], 'approval detail.rights'),
    liveConcession: {
      margin: decodeDimension(live['margin'], 'approval detail.liveConcession.margin'),
      cashflow: decodeDimension(live['cashflow'], 'approval detail.liveConcession.cashflow'),
      hasMovedSinceRequest: bool(live, 'hasMovedSinceRequest', 'approval detail.liveConcession'),
    },
    quoteRevisionNow: str(row, 'quoteRevisionNow', 'approval detail'),
  };
}

/* ------------------------------------------------------------------ *
 * The calls
 * ------------------------------------------------------------------ */

export const fetchApprovalQueue = (): Promise<ApprovalQueueView> =>
  apiJson('/quotes/approvals/queue', decodeQueue);

export const fetchApproval = (approvalId: string): Promise<ApprovalDetailView> =>
  apiJson(`/quotes/approvals/${encodeURIComponent(approvalId)}`, decodeApprovalDetail);

/**
 * ⭐ The unfiltered list — *"what is waiting, or what was decided"*, for anybody with `quotes.read`.
 *
 * A different question from the queue and therefore a different call: this one takes no account of
 * the caller's ceiling, which is exactly right for its two readers.
 *
 *   `status: 'approved' | 'rejected'`   the decided history, newest first. Until this call existed,
 *                                       a decision left the queue and appeared **nowhere** — the
 *                                       note an approver was required to write had no reader at
 *                                       all, and "the approval is a record" was a claim about a
 *                                       row rather than about anything a person could see.
 *   `orderId`                           every request on one order, which is how the *requester*
 *                                       reads why they were refused (see `authority-panel.tsx`).
 *
 * ⚠️ Both parameters existed on `GET /quotes/approvals` from the day it shipped and neither had a
 * caller anywhere in the monorepo. `?orderId=` in particular is the one the refusal loop needs.
 */
export const listApprovals = (query: {
  readonly status: ApprovalStatusWire;
  readonly orderId?: string;
  readonly limit?: number;
}): Promise<readonly ApprovalView[]> => {
  const search = new URLSearchParams({ status: query.status });
  if (query.orderId !== undefined) search.set('orderId', query.orderId);
  if (query.limit !== undefined) search.set('limit', String(query.limit));

  return apiJson(`/quotes/approvals?${search.toString()}`, (body) => {
    const row = object(body, 'approval list');
    const approvals = row['approvals'];
    if (!Array.isArray(approvals)) throw new TypeError('approval list has no approvals array');
    return approvals.map(decodeApproval);
  });
};

/**
 * Approve or refuse.
 *
 * One call for both answers, because it is one decision — the API has one route for the reason
 * its controller gives: two would let a caller take neither, and the queue would have no way to
 * record that a request was *considered*.
 *
 * ⚠️ The body is built by `decisionBody` and not here, so that "a refusal carries a reason" is a
 * rule with a test rather than a shape assembled at a click handler.
 */
export const decideApproval = (
  approvalId: string,
  body: Record<string, unknown>,
): Promise<ApprovalView> =>
  apiJson(
    `/quotes/approvals/${encodeURIComponent(approvalId)}/decision`,
    decodeApproval,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
