import { z } from 'zod';

import { APPROVAL_DIMENSIONS, APPROVAL_STATUSES } from '@wewin/db/schema';

import { CONCESSION_SOURCE_KINDS } from './concession';

/**
 * What authority looks like on the wire.
 *
 * Declared here rather than in `@wewin/contract` for the reason `refunds.contract.ts` gives:
 * that package is read by `apps/web` and `apps/dashboard` and is not this round's to change.
 * These shapes move there when somebody builds the approver's screen, and the move is a copy.
 *
 * ── Two fields a request deliberately does not have ──────────────────────────────
 *
 *   `concessionThbMinor`   the size of the concession is measured from `quote_lines` and
 *                          `quote_overrides` in the transaction that records the request. A
 *                          body that could name it is a body that asks for approval of ฿100
 *                          and receives approval of ฿100,000 — the same argument
 *                          `CreateRefundWire` makes about the refundable amount.
 *
 *   `requestedByUserId`    the scope, never the body. An approval whose requester is a field
 *                          is a two-person rule with one person and a text box.
 *
 * ── Money on the wire is a string of digits ──────────────────────────────────────
 *
 * `JSON.parse` on a large integer is where a satang goes missing silently, so every amount is
 * a decimal string in minor units and the client widens as it chooses. Same rule as
 * `@wewin/contract`.
 */

export const approvalDimensionSchema = z.enum(APPROVAL_DIMENSIONS);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

/** Minor units as a string of digits, and negative is not representable — a concession is a size. */
const minorSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,17})$/u, 'an amount in THB minor units, digits only');

export const requestApprovalSchema = z.strictObject({
  orderId: z.uuid(),
  dimension: approvalDimensionSchema,
  /** Read by a human, and the only thing in the request that a human wrote. */
  reasonTh: z.string().trim().min(1).max(1000),
});

export type RequestApprovalWire = z.infer<typeof requestApprovalSchema>;

export const decideApprovalSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  /** Required on a rejection — the requester has to be told what to change. Enforced in the service. */
  noteTh: z.string().trim().min(1).max(1000).optional(),
});

export type DecideApprovalWire = z.infer<typeof decideApprovalSchema>;

export const approvalQuerySchema = z.strictObject({
  status: approvalStatusSchema.default('pending'),
  orderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ApprovalQuery = z.infer<typeof approvalQuerySchema>;

export const setAuthorityLimitSchema = z.strictObject({
  groupId: z.uuid(),
  dimension: approvalDimensionSchema,
  /**
   * `0` is legal and is not the same as no row: a role with `0` may record a concession and
   * approve none of its own, a role with no row has no authority at all. The schema comment on
   * `authority_limits` says the difference lives in the error message, and it does.
   */
  maxConcessionThbMinor: minorSchema,
  noteTh: z.string().trim().min(1).max(1000).optional(),
});

export type SetAuthorityLimitWire = z.infer<typeof setAuthorityLimitSchema>;

export const concessionSourceKindSchema = z.enum(CONCESSION_SOURCE_KINDS);

export interface ConcessionSourceWire {
  readonly kind: (typeof CONCESSION_SOURCE_KINDS)[number];
  readonly amountThbMinor: string;
  readonly quoteLineId: string | null;
  readonly overrideId: string | null;
  readonly reasonCode: string | null;
}

/**
 * ⭐ What this response says about the **caller's** ceiling — and on most outcomes it says
 * nothing, which is a different sentence from "you have none".
 *
 * This was a bare `ceilingThbMinor: string | null`, and `null` carried two meanings split by a
 * branch no client can see: *"your roles hold no live `authority_limits` row"* on
 * `needs_approval`, and *"this outcome never consulted the table"* on the other three.
 * `AuthorityService.judge` returns before reading the ceiling when nothing has been conceded,
 * and a covered concession is a fact about somebody else's authority rather than the caller's.
 *
 * The dashboard read that `null` as "no ceiling" and printed **ยังไม่มีการกำหนดเพดานอำนาจ
 * สำหรับบทบาทของคุณ** on every quote carrying no discount — which is most quotes — including
 * for roles that had just been granted one. It was fixed on that client by reconstructing the
 * distinction from `outcome`, which left the trap armed for the next client and made a wire
 * field mean something only one reader knew. So the wire says it itself:
 *
 *     { known: false }                     this response reports no ceiling — conclude nothing
 *     { known: true, thbMinor: '500000' }  the caller's roles may concede up to ฿5,000
 *     { known: true, thbMinor: null }      the caller's roles hold no live ceiling at all
 *
 * ⚠️ `known: true` with `thbMinor: '0'` is a **real grant** and not the absence of one — the
 * distinction `authority_limits`' own schema note exists for: `0` may record a concession and
 * approve none of its own; no row has no authority at all.
 */
export type CeilingWire =
  | { readonly known: false }
  | { readonly known: true; readonly thbMinor: string | null };

export interface DimensionAssessmentWire {
  readonly dimension: 'margin' | 'cashflow';
  readonly concessionThbMinor: string;
  readonly sources: readonly ConcessionSourceWire[];
  /** `nothing_conceded` · `within_authority` · `covered_by_approval` · `needs_approval`. */
  readonly outcome: string;
  readonly ceiling: CeilingWire;
  readonly approvalId: string | null;
}

export interface AuthorityAssessmentWire {
  readonly orderId: string;
  readonly orderNo: string | null;
  /** The digest of the quote every figure below was measured from — and that an approval names. */
  readonly quoteRevision: string;
  readonly margin: DimensionAssessmentWire;
  readonly cashflow: DimensionAssessmentWire;
  /** The one field the quote editor branches on: may this go to the customer as it stands? */
  readonly allowed: boolean;
}

export interface ApprovalWire {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  /** Evidence of which pinned revision the approver was looking at. Null before any submit. */
  readonly orderDocumentId: string | null;
  readonly documentRevision: number | null;
  /**
   * ⭐ The subject. An approval covers **this** quote, and stops covering it the moment anybody
   * edits a line — which is what "the approver approved this document" means once it is
   * enforced rather than assumed. See `AuthorityService.judge`.
   */
  readonly quoteRevision: string;
  readonly dimension: 'margin' | 'cashflow';
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly concessionThbMinor: string;
  readonly reasonTh: string;
  readonly requestedByUserId: string;
  readonly requestedByName: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNoteTh: string | null;
  /** The decider's own ceiling at the moment they approved. Null on pending and on rejected. */
  readonly decidedCeilingThbMinor: string | null;
  readonly createdAt: string;
}

export interface ApprovalListWire {
  readonly approvals: readonly ApprovalWire[];
}

/**
 * One request as the approver sees it: what was asked, and what the quote concedes **now**.
 *
 * The two differ whenever sales carried on editing after asking. An inbox that showed only the
 * stored figure would have the approver agreeing to a document that no longer exists, which is
 * the same class of mistake plan 7.9(จ) closes at pin time by re-verifying every baseline.
 */
export interface ApprovalDetailWire {
  readonly approval: ApprovalWire;
  readonly liveConcession: {
    readonly margin: DimensionAssessmentWire;
    readonly cashflow: DimensionAssessmentWire;
    /** True when the quote now concedes more than the figure on the request. */
    readonly hasMovedSinceRequest: boolean;
  };
  /**
   * The quote's digest **now**.
   *
   * When it differs from `approval.quoteRevision`, approving this request grants nothing at
   * all: the decision names a quote that no longer exists, and `judge` will not match it. The
   * screen has to say that before the button is pressed, not after.
   */
  readonly quoteRevisionNow: string;
}

export interface AuthorityLimitWire {
  readonly groupId: string;
  readonly groupCode: string;
  readonly groupNameTh: string;
  readonly dimension: 'margin' | 'cashflow';
  readonly maxConcessionThbMinor: string;
  readonly grantedByUserId: string;
  readonly updatedAt: string;
  readonly noteTh: string | null;
  /**
   * ⭐ `null` is live; an ISO instant is a ceiling that has been withdrawn.
   *
   * Withdrawn rows are **in this list**, not filtered out of it — the same call `tax_countries`
   * makes about `is_active`. A screen dims them; it does not hide them, because a ceiling
   * somebody took away is the thing an administrator has to see in order to put it back.
   *
   * ⚠️ A withdrawn ceiling grants nothing at all, and is not the same as a ceiling of `0`. See
   * `isFailClosed` below and `AuthorityRepository.ceiling`.
   */
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
}

export interface AuthorityLimitListWire {
  readonly limits: readonly AuthorityLimitWire[];
  /**
   * ⚠️ Ships true, and that is plan 13's fail-closed default rather than a bug.
   *
   * An empty table means nobody may concede anything and nobody may approve anything. The flag
   * is on the response so that a dashboard can say so out loud instead of rendering an empty
   * list that looks like a feature nobody has used yet.
   *
   * ⚠️ It is **"no live ceiling"**, not "no rows". Since 0038 a revoked limit stays in the
   * table, so `limits.length === 0` stopped being the question: a list of nothing but withdrawn
   * ceilings is exactly as fail-closed as an empty one, and a flag that said otherwise would
   * tell an administrator the feature was working on the day it had been switched off.
   */
  readonly isFailClosed: boolean;
}

/** The `authority_limits` fields a change records. See `AuthorityService.snapshot`. */
export interface AuthorityLimitSnapshotWire {
  readonly maxConcessionThbMinor: string;
  readonly noteTh: string | null;
  readonly isRevoked: boolean;
}

/**
 * One entry in the chain. `before` is `null` on the first grant and on nothing else, so a
 * reader can tell a ceiling being created from a ceiling being changed without guessing.
 */
export interface AuthorityLimitChangeWire {
  readonly id: string;
  readonly groupId: string;
  readonly groupCode: string;
  readonly dimension: 'margin' | 'cashflow';
  readonly changedByUserId: string;
  readonly changedAt: string;
  readonly before: AuthorityLimitSnapshotWire | null;
  readonly after: AuthorityLimitSnapshotWire;
}

export interface AuthorityLimitChangeListWire {
  readonly changes: readonly AuthorityLimitChangeWire[];
}
