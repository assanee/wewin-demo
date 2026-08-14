import { z } from 'zod';

import { APPROVAL_DIMENSIONS, APPROVAL_KINDS, APPROVAL_STATUSES } from '@wewin/db/schema';

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
export const approvalKindSchema = z.enum(APPROVAL_KINDS);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

/** Minor units as a string of digits, and negative is not representable — a concession is a size. */
const minorSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,17})$/u, 'an amount in THB minor units, digits only');

/**
 * ⭐ ขออนุมัติตัดยอดค้างทิ้ง — `POST /orders/:orderId/write-offs`.
 *
 * ── ⚠️ THIS ONE CARRIES AN AMOUNT, AND THE MODULE HEADER FORBIDS THAT ────────────
 *
 * The prohibition above is about a **measurable** concession: a quote's discount is a fact in
 * `quote_lines`, so accepting a figure would be accepting a claim about rows the server can read
 * for itself. A write-off is not measurable — *"the customer settled for half"* exists nowhere in
 * the database until somebody records it — and a route that could only forgive the *whole* balance
 * would answer the wrong half of the owner's requirement, since the part-settlement is the common
 * case.
 *
 * So the amount is named and the **bound is the server's**: `0 < amount ≤
 * order_outstanding_thb_minor(orderId)`, checked in `WriteOffService.request` inside the
 * transaction that inserts the row, again by `approvals_write_off_within_balance` at the database,
 * and a third time at the decision because the balance moves in between. See
 * `write-off.service.ts`.
 *
 * ⚠️ `orderId` is **not** in this body. It is the path, because the resource being written off is
 * the order: a body that could name a different order from the URL is a body somebody eventually
 * points at the wrong one.
 */
export const requestWriteOffSchema = z.strictObject({
  /**
   * How much of the balance to forgive, in THB minor units.
   *
   * `min(1)` after the regex, so `'0'` is a validation failure with a sentence rather than a
   * 23514 from `approvals_concession_positive` — a write-off of nothing is a request nobody can
   * answer, not a boundary case.
   */
  amountThbMinor: minorSchema.refine((value) => value !== '0', 'ยอดที่ขอตัดทิ้งต้องมากกว่าศูนย์'),
  /**
   * Why. **The only field a human wrote, and the whole audit trail for money the company chose
   * not to collect** — `reason_th` is NOT NULL for this reason and there is no default.
   */
  reasonTh: z.string().trim().min(1).max(1000),
});

export type RequestWriteOffWire = z.infer<typeof requestWriteOffSchema>;

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
  /**
   * ⭐ WHAT THIS APPROVAL IS, and the field a client must branch on before printing the figure.
   *
   *   `quote_concession`  money the customer will not be **charged** — measured from the quote.
   *   `write_off`         money the company will not be **paid** — ขออนุมัติตัดยอดค้างทิ้ง, and the
   *                       only kind that `order_outstanding_thb_minor()` subtracts.
   *
   * ⚠️ It is not derivable from `dimension`. A write-off is `cashflow` because it draws on the
   * cashflow ceiling, and so is a quote's `gate_below_floor` concession — one column, two
   * mechanisms, which is exactly why `APPROVAL_KINDS` exists. A screen that read
   * `dimension === 'cashflow'` as "a write-off" would label an approved deposit schedule as a
   * forgiven debt.
   */
  readonly kind: 'quote_concession' | 'write_off';
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
 * ⭐ May the caller decide this request — the server's answer, not the client's arithmetic.
 *
 * Mirrors `ApprovalRights` (`approval-rights.ts`), which is where the rule and the ordering of
 * `because` are written down. Two booleans rather than one, because refusing needs no ceiling
 * and approving does: a screen that offered one button for both would either hide a refusal
 * somebody is entitled to make, or offer an approval that answers 403.
 */
export interface ApprovalRightsWire {
  readonly mayApprove: boolean;
  readonly mayRefuse: boolean;
  /**
   * `may_decide` · `not_an_approver` · `not_a_write_off_approver` · `already_decided` ·
   * `own_request` · `no_ceiling` · `above_ceiling` · `above_balance`. The first lock that stops
   * this caller, in the order the decision endpoint would hit them.
   *
   * ⭐ The two added with write-offs: `not_a_write_off_approver` is a caller holding
   * `quotes.approve` but not `payments.write_off` — it blocks a **refusal** as well, because this
   * is not a ceiling but whether the person has any standing in the decision — and
   * `above_balance` is a request the customer has since part-paid, which nobody may approve and
   * anybody may reject.
   */
  readonly because: string;
  /** The caller's own ceiling in this request's dimension. Always consulted, so always `known`. */
  readonly ceiling: CeilingWire;
}

/**
 * ⭐ THE APPROVER'S QUEUE: what this person may actually decide, and what they may not.
 *
 * ── Why this is not `GET /quotes/approvals?status=pending` ────────────────────────
 *
 * That endpoint answers *"what is waiting?"* for anybody holding `quotes.read` — the requester
 * checking on their own ask, an auditor reading the backlog — and it is unfiltered on purpose.
 * This one answers *"what is waiting **for me**?"*, and the difference is not a convenience:
 * `approvals` carries figures that most readers have no authority to approve, and a queue that
 * lists them teaches the approver to press buttons and read 403s. See `approval-rights.ts`.
 *
 * ── ⚠️ Withheld requests are COUNTED and not listed, and the count is not a leak ──
 *
 * A queue that silently dropped what the reader cannot approve would say "nothing is waiting"
 * on the day three requests are stuck above everybody's ceiling — which is fail-closed becoming
 * invisible, and is the same failure plan 7.13 names: *requests with nowhere to arrive.* So the
 * screen is told how many it is not being shown, and can say so.
 *
 * The overview's `quotes.approvalsPending` card counts **every** pending request in the company,
 * so `approvals.length + beyondYourAuthority + yourOwnRequests` is what reconciles this screen
 * with that number. A queue showing two while the dashboard says five, with no explanation, is
 * how somebody concludes one of the two is broken.
 *
 * ⚠️ It discloses nothing new: this route demands `quotes.read`, which already opens the
 * unfiltered list. `overview/sections.ts`'s rule — never summarise a queue for somebody the
 * queue itself would refuse — is satisfied because the queue would not refuse them.
 */
export interface ApprovalQueueWire {
  /** Oldest first, and every one of them is a decision this caller may actually take. */
  readonly approvals: readonly ApprovalWire[];
  /** The caller's own ceilings, so the screen can say what it is comparing against. */
  readonly ceilings: {
    readonly margin: CeilingWire;
    readonly cashflow: CeilingWire;
  };
  readonly withheld: {
    /** Pending requests somebody else asked for, whose figure this caller's ceiling does not cover. */
    readonly beyondYourAuthority: number;
    /** Pending requests this caller raised. The two-person rule, counted rather than hidden. */
    readonly yourOwnRequests: number;
  };
  /**
   * True when there are more pending requests than one read of this endpoint covers, so the
   * counts above describe the oldest `APPROVAL_QUEUE_SCAN_MAX` and not the whole table.
   *
   * It is a flag rather than a page cursor because a human queue this long is a different
   * problem from a paging problem, and a screen that quietly showed the first page of an
   * unbounded backlog would hide it.
   */
  readonly isTruncated: boolean;
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
  /**
   * ⭐ What **the caller** may do about it. See `ApprovalRightsWire`.
   *
   * On the detail response and not only on the queue, because this route is reachable by URL —
   * from the quote editor's `approvalId`, from a colleague's link — and a screen that decided
   * for itself which buttons to show would be the client re-deriving the rule.
   */
  readonly rights: ApprovalRightsWire;
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
   *
   * ⚠️ It is meaningless for a `write_off` and the screen must not warn on it. Editing a quote
   * line does not un-forgive a debt, and nothing in `decide` matches a write-off to a revision —
   * see `writeOff` below, which is that row's equivalent warning and a sharper one.
   */
  readonly quoteRevisionNow: string;
  /**
   * ⭐ PRESENT EXACTLY WHEN `approval.kind === 'write_off'`, and `null` otherwise.
   *
   * `liveConcession` is the wrong reading for a write-off in both dimensions: `margin` is about a
   * discount nobody asked about, and `cashflow` measures the quote's `gate_below_floor` — a
   * deposit schedule, which has nothing to do with the debt being forgiven. An inbox that showed
   * "ลดอยู่จริงตอนนี้ ฿0.00" beside a ฿20,000 write-off would be telling the approver the request
   * had evaporated.
   *
   * What a write-off's approver needs instead is the **balance**, now:
   *
   *   `outstandingThbMinor`  `order_outstanding_thb_minor()`, this instant. Already net of any
   *                          write-off already approved on this order, so two part write-offs read
   *                          correctly.
   *   `stillCovered`         `concessionThbMinor <= outstandingThbMinor`. `false` means the
   *                          customer has paid something since the request was raised and
   *                          `decide` will refuse the approval — the screen says so before the
   *                          button, and the correct answer is a rejection with a note.
   */
  readonly writeOff: {
    readonly outstandingThbMinor: string;
    readonly stillCovered: boolean;
  } | null;
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

/**
 * ⭐ A role, named — and nothing else about it.
 *
 * The role picker on the authority screen needs a list of groups to choose from, and the only
 * endpoint that served one was `GET /admin/groups` behind **`users.read`**. That made the
 * ceiling table undelegatable: a person holding `groups.read` + `groups.write` — the permission
 * that *owns* this table — could not reach the screen without also being granted sight of the
 * entire staff directory, which this project treats as a PDPA-relevant disclosure.
 *
 * ⚠️ Three fields, deliberately. No permission grants, no member counts, and nothing about any
 * person. `groups.read`'s catalogue entry already describes reading groups; what was missing
 * was a route that asked for it rather than for `users.read`.
 */
export interface AuthorityGroupWire {
  readonly id: string;
  readonly code: string;
  readonly nameTh: string;
}

export interface AuthorityGroupListWire {
  readonly groups: readonly AuthorityGroupWire[];
}
