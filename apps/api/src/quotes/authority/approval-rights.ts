import { scopeHolds, type Scope } from '../../rbac';
import type { ApprovalStatus } from './authority.repository';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ MAY *THIS* PERSON DECIDE *THIS* REQUEST — asked once, in one place.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `AuthorityService.decide` already refuses everything this file describes. So why does the
 * file exist?
 *
 * Because until now the only way to learn the answer was **to try**. `GET /quotes/approvals`
 * served every pending request to everybody holding `quotes.read` and said nothing about who
 * could act on any of them, so an approver's queue was a list of requests most of which would
 * answer 403 or 409 when pressed. A queue that offers a decision it cannot take is worse than
 * an empty one: the approver learns the rule by being refused, one request at a time, and the
 * request that genuinely needed *them* is somewhere in the same list.
 *
 * The alternative that must not happen is the client working it out. A dashboard comparing a
 * concession against a ceiling it fetched separately is a second implementation of the one rule
 * this module exists to state — plan 7.13's opening finding (six copies of the two-person rule,
 * five with holes) arriving again, in TypeScript, one network hop away from the CHECK.
 *
 * So the rule is a function of facts, with no database and no HTTP in it. `decide` enforces it,
 * `queue` filters by it, `GET /quotes/approvals/:id` reports it, and the dashboard renders what
 * it is told.
 *
 * ── ⚠️ THE ORDER OF THE REASONS IS THE ORDER OF THE REFUSALS ─────────────────────
 *
 * `because` names the *first* thing that stops this caller, and the sequence deliberately
 * mirrors what a `POST …/decision` would actually answer, outermost lock first:
 *
 *   `not_an_approver`   the guard, before the handler runs at all — 403 from `RbacGuard`
 *   `already_decided`   `decide`'s status check — 409, and the row is frozen by
 *                       `approvals_guard_write` even if the check were removed
 *   `own_request`       the two-person rule — 409, and `approvals_decider_is_not_requester`
 *   `no_ceiling`        no live `authority_limits` row for any of the caller's roles — 403
 *   `above_ceiling`     a row, and it is smaller than the concession — 403
 *
 * A different order would make this module's answer disagree with the endpoint's for somebody
 * who trips two locks at once, and the whole point is that the two cannot disagree.
 * `tests/quotes/authority/approval-rights.test.ts` pins the sequence; the pg suite pins that
 * the endpoint agrees with it, request by request.
 *
 * ── Refusing is not an exercise of authority ─────────────────────────────────────
 *
 * `mayRefuse` is deliberately *wider* than `mayApprove`: it asks for the permission, a pending
 * row and somebody other than the requester, and it asks for **no ceiling at all**. That is
 * `decide`'s own rule ("saying no is not an exercise of authority, and a request that can only
 * be answered by somebody senior enough to say yes is a request that sits in the queue for
 * ever"), and it is the property that keeps a queue from producing approvals by being the only
 * button that works.
 */

/** The permission a decision needs. Its own code, held by nobody at boot — see the controller. */
export const DECIDE_PERMISSION = 'quotes.approve';

export const APPROVAL_RIGHT_REASONS = [
  'may_decide',
  'not_an_approver',
  'already_decided',
  'own_request',
  'no_ceiling',
  'above_ceiling',
] as const;

export type ApprovalRightReason = (typeof APPROVAL_RIGHT_REASONS)[number];

export interface ApprovalRights {
  /** Approve: permission, pending, not the requester, **and** a ceiling that covers the figure. */
  readonly mayApprove: boolean;
  /** Refuse: permission, pending, not the requester. No ceiling — see above. */
  readonly mayRefuse: boolean;
  /**
   * The first thing that stops this caller, or `may_decide` when nothing does.
   *
   * ⚠️ `no_ceiling` and `above_ceiling` block only `mayApprove`. Every other reason blocks both,
   * which is why one field can carry both answers without ambiguity.
   */
  readonly because: ApprovalRightReason;
}

export interface ApprovalFacts {
  readonly status: ApprovalStatus;
  readonly requestedByUserId: string;
  readonly concessionThbMinor: bigint;
  /**
   * The caller's own ceiling in **this request's** dimension.
   *
   * ⚠️ `undefined` is *not* `0n`, and the difference is the whole of plan 13's fail-closed rule:
   * no live row is no authority at all, a row of `0` is a role that may record a concession and
   * approve none of its own. Both refuse; they refuse with different sentences. See
   * `AuthorityRepository.ceiling`, which is the only thing that may produce this value.
   */
  readonly ceilingThbMinor: bigint | undefined;
}

export function approvalRights(scope: Scope, facts: ApprovalFacts): ApprovalRights {
  const blocked = (because: ApprovalRightReason): ApprovalRights => ({
    mayApprove: false,
    mayRefuse: false,
    because,
  });

  /*
   * A non-user scope decides nothing. `scopeHolds` gives a guest and the public no permission at
   * all, so this returns the same answer for them — but `system` *does* hold everything, and a
   * worker that could approve a concession on its own authority is a worker with a ceiling
   * nobody granted. `decide` refuses it in `staffUserId`; this refuses it before that, so the
   * two agree.
   */
  if (scope.kind !== 'user') return blocked('not_an_approver');
  if (!scopeHolds(scope, DECIDE_PERMISSION)) return blocked('not_an_approver');
  if (facts.status !== 'pending') return blocked('already_decided');
  if (facts.requestedByUserId === scope.userId) return blocked('own_request');

  /* Everything below refuses the *approval* only. Refusing needs no authority. */
  if (facts.ceilingThbMinor === undefined) {
    return { mayApprove: false, mayRefuse: true, because: 'no_ceiling' };
  }
  if (facts.concessionThbMinor > facts.ceilingThbMinor) {
    return { mayApprove: false, mayRefuse: true, because: 'above_ceiling' };
  }

  return { mayApprove: true, mayRefuse: true, because: 'may_decide' };
}
