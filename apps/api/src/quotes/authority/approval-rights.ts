import type { ApprovalKind } from '@wewin/db/schema';

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
 *   `not_a_write_off_approver`
 *                       ⭐ a **write-off** row and the caller lacks `payments.write_off` — 403,
 *                       raised inside `decide` because the guard cannot see which row it is
 *   `already_decided`   `decide`'s status check — 409, and the row is frozen by
 *                       `approvals_guard_write` even if the check were removed
 *   `own_request`       the two-person rule — 409, and `approvals_decider_is_not_requester`
 *   `no_ceiling`        no live `authority_limits` row for any of the caller's roles — 403
 *   `above_ceiling`     a row, and it is smaller than the concession — 403
 *   `above_balance`     ⭐ a write-off larger than the debt still outstanding — 409. Last,
 *                       because it is the only lock that is not about the caller at all: the
 *                       request was valid when it was raised and the customer has since paid.
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

/**
 * ⭐ The **second** code a write-off needs, on top of `DECIDE_PERMISSION`.
 *
 * Forgiving cash the company is owed is a different power from approving a discount at quote
 * time, and it is the only approval that money is *subtracted* from — see `rbac/permissions.ts`,
 * where the reasoning is written out. Held by nobody at boot.
 *
 * ⚠️ Checked here rather than by a decorator because the guard runs before the row is read, and
 * which extra code a decision needs is a fact about the row. `@RequirePermissions` on
 * `POST /quotes/approvals/:id/decision` therefore still names `quotes.approve` alone — the
 * conjunction is completed in `AuthorityService.decide`, which is the same function this file
 * mirrors, so the queue cannot offer a button the endpoint refuses.
 */
export const WRITE_OFF_PERMISSION = 'payments.write_off';

export const APPROVAL_RIGHT_REASONS = [
  'may_decide',
  'not_an_approver',
  'not_a_write_off_approver',
  'already_decided',
  'own_request',
  'no_ceiling',
  'above_ceiling',
  'above_balance',
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
   * ⚠️ `no_ceiling`, `above_ceiling` and `above_balance` block only `mayApprove`. Every other
   * reason blocks both, which is why one field can carry both answers without ambiguity.
   */
  readonly because: ApprovalRightReason;
}

export interface ApprovalFacts {
  readonly status: ApprovalStatus;
  /**
   * ⭐ Which mechanism this is. A `write_off` needs `WRITE_OFF_PERMISSION` as well, and is bounded
   * by `outstandingThbMinor` as well as by the ceiling.
   */
  readonly kind: ApprovalKind;
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
  /**
   * ⭐ What the order still owes **now** — `order_outstanding_thb_minor()`, Postgres's own fold.
   *
   * Read for a `write_off` and `undefined` for a `quote_concession`, where it is not consulted:
   * a discount on a quote whose deposit is already paid may legitimately exceed what is still
   * outstanding, and bounding it by the balance would refuse ordinary quote approvals.
   *
   * ⚠️ `undefined` on a write-off is treated as **zero balance and therefore refused**, not as
   * "unknown, so allow". A caller that forgot to read the fold must not thereby be granted the
   * one approval that subtracts from money — see `approvalRights`.
   */
  readonly outstandingThbMinor: bigint | undefined;
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
  /*
   * ⭐ Second, and it blocks **both** answers on purpose.
   *
   * A refusal is ordinarily wider than an approval — saying no needs no authority — but this is
   * not a ceiling, it is *whether this person has any business in this decision at all*. A quote
   * approver who may not forgive debts should not be the person who rejects somebody's write-off
   * request either: the request would leave the queue answered by somebody with no standing to
   * answer it, and the requester would read a refusal that means nothing.
   */
  if (facts.kind === 'write_off' && !scopeHolds(scope, WRITE_OFF_PERMISSION)) {
    return blocked('not_a_write_off_approver');
  }
  if (facts.status !== 'pending') return blocked('already_decided');
  if (facts.requestedByUserId === scope.userId) return blocked('own_request');

  /* Everything below refuses the *approval* only. Refusing needs no authority. */
  if (facts.ceilingThbMinor === undefined) {
    return { mayApprove: false, mayRefuse: true, because: 'no_ceiling' };
  }
  if (facts.concessionThbMinor > facts.ceilingThbMinor) {
    return { mayApprove: false, mayRefuse: true, because: 'above_ceiling' };
  }

  /*
   * ⭐ THE BALANCE MOVED. Last, and only for a write-off.
   *
   * The request was valid when it was raised — `approvals_write_off_within_balance` refuses one
   * that was not — and the customer has since transferred part of what they owed. Approving now
   * would forgive more than is left and drive the outstanding negative, which every screen in
   * this system reads as *settled* and which the refund module would price a payable from.
   *
   * ⚠️ `mayRefuse` stays true. The correct next step is somebody rejecting this request with a
   * note so the requester raises a smaller one — see `AuthorityService.decide` for why the
   * amount is not silently reduced instead.
   */
  if (facts.kind === 'write_off') {
    const balance = facts.outstandingThbMinor ?? 0n;
    if (facts.concessionThbMinor > balance) {
      return { mayApprove: false, mayRefuse: true, because: 'above_balance' };
    }
  }

  return { mayApprove: true, mayRefuse: true, because: 'may_decide' };
}
