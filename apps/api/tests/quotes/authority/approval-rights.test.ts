import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  approvalRights,
  DECIDE_PERMISSION,
  type ApprovalFacts,
} from '../../../src/quotes/authority/approval-rights';
import {
  guestScope,
  systemScope,
  userScope,
  PUBLIC_SCOPE,
  type PermissionCode,
  type Scope,
} from '../../../src/rbac';

/**
 * The rule, with no database and no HTTP in it.
 *
 * `authority.pg.test.ts` proves the endpoint agrees with this function — that is the assertion
 * that matters, and it needs Postgres. This file is the truth table underneath it, and it exists
 * for one property the pg suite cannot state cheaply: **the order of the refusals**.
 *
 * `because` is what a screen prints. If this function reported `own_request` to somebody who does
 * not hold `quotes.approve`, the dashboard would tell an ordinary salesperson that the reason they
 * cannot approve their own discount is the two-person rule — implying that a colleague's request
 * *would* be theirs to decide. The sequence below is the sequence of locks the decision endpoint
 * actually hits, and a caller tripping two must be told about the outer one.
 */

const requester = randomUUID();
const approver = randomUUID();

const approverScope = (permissions: readonly PermissionCode[] = [DECIDE_PERMISSION]): Scope =>
  userScope({
    userId: approver,
    sessionId: randomUUID(),
    groupIds: [randomUUID()],
    permissions: new Set(permissions),
  });

const requesterScope = (permissions: readonly PermissionCode[] = [DECIDE_PERMISSION]): Scope =>
  userScope({
    userId: requester,
    sessionId: randomUUID(),
    groupIds: [randomUUID()],
    permissions: new Set(permissions),
  });

const pending: ApprovalFacts = {
  status: 'pending',
  requestedByUserId: requester,
  concessionThbMinor: 53_500n,
  ceilingThbMinor: 100_000n,
};

describe('who may decide one approval request', () => {
  it('lets an approver with a covering ceiling do either thing', () => {
    expect(approvalRights(approverScope(), pending)).toStrictEqual({
      mayApprove: true,
      mayRefuse: true,
      because: 'may_decide',
    });
  });

  it('treats a ceiling exactly equal to the concession as covering it', () => {
    /*
     * The boundary, and the direction it has to fail in. `decide` refuses on
     * `concession > ceiling`, and `approvals_ceiling_covers_concession` is `ceiling >= concession`
     * — so equal is *allowed* in both, and a queue that used `<` here would hide the request an
     * approver is exactly authorised for.
     */
    expect(
      approvalRights(approverScope(), { ...pending, ceilingThbMinor: pending.concessionThbMinor })
        .mayApprove,
    ).toBe(true);
  });

  it('⭐ refuses the approval and allows the refusal one satang above the ceiling', () => {
    const rights = approvalRights(approverScope(), {
      ...pending,
      ceilingThbMinor: pending.concessionThbMinor - 1n,
    });

    expect(rights).toStrictEqual({
      mayApprove: false,
      mayRefuse: true,
      because: 'above_ceiling',
    });
  });

  it('⭐ separates "no ceiling at all" from a ceiling of zero', () => {
    /*
     * Plan 13's distinction, and it is not cosmetic: the two produce different sentences on the
     * screen and `authority_limits`' own schema note says the difference lives in the message.
     * A role with `0` may record a concession and approve none of its own; a role with no row has
     * no authority at all — and a withdrawn ceiling is the second, because
     * `AuthorityRepository.ceiling` filters revoked rows out rather than reading them as `0`.
     */
    expect(approvalRights(approverScope(), { ...pending, ceilingThbMinor: undefined })).toStrictEqual({
      mayApprove: false,
      mayRefuse: true,
      because: 'no_ceiling',
    });

    expect(approvalRights(approverScope(), { ...pending, ceilingThbMinor: 0n })).toStrictEqual({
      mayApprove: false,
      mayRefuse: true,
      because: 'above_ceiling',
    });
  });

  it('refuses the requester as their own approver, ceiling or no ceiling', () => {
    expect(approvalRights(requesterScope(), pending)).toStrictEqual({
      mayApprove: false,
      mayRefuse: false,
      because: 'own_request',
    });

    /* And a limitless ceiling does not buy it — the two-person rule is not an authority question. */
    expect(
      approvalRights(requesterScope(), { ...pending, ceilingThbMinor: 10n ** 12n }).mayApprove,
    ).toBe(false);
  });

  it('refuses a decided request, and says so rather than saying anything about a ceiling', () => {
    for (const status of ['approved', 'rejected'] as const) {
      expect(approvalRights(approverScope(), { ...pending, status })).toStrictEqual({
        mayApprove: false,
        mayRefuse: false,
        because: 'already_decided',
      });
    }
  });

  it('refuses somebody who does not hold the decision permission', () => {
    expect(approvalRights(approverScope(['quotes.read', 'quotes.write']), pending)).toStrictEqual({
      mayApprove: false,
      mayRefuse: false,
      because: 'not_an_approver',
    });
  });

  /* ---------------------------------------------------------------- *
   * ⭐ The order of the reasons — the outer lock wins
   * ---------------------------------------------------------------- */

  it('⭐ reports the missing permission ahead of every other refusal', () => {
    /*
     * A salesperson looking at their own already-decided request over their ceiling trips four
     * locks. The one the endpoint would answer with is the guard's, because it runs before the
     * handler — so that is the one to print. Reporting `own_request` here would tell them a
     * colleague's request would have been theirs to decide.
     */
    const rights = approvalRights(requesterScope(['quotes.read']), {
      status: 'approved',
      requestedByUserId: requester,
      concessionThbMinor: 1_000_000n,
      ceilingThbMinor: undefined,
    });

    expect(rights.because).toBe('not_an_approver');
  });

  it('⭐ reports a decided request ahead of the two-person rule and the ceiling', () => {
    const rights = approvalRights(requesterScope(), {
      status: 'rejected',
      requestedByUserId: requester,
      concessionThbMinor: 1_000_000n,
      ceilingThbMinor: undefined,
    });

    expect(rights.because).toBe('already_decided');
  });

  it('⭐ reports the two-person rule ahead of the ceiling', () => {
    /*
     * Both hold: this is the requester, and they have no ceiling. `own_request` is the honest
     * answer — "get somebody else" is actionable, "ask for a bigger ceiling" is not, and a
     * ceiling granted to this role would still not let them sign their own discount.
     */
    const rights = approvalRights(requesterScope(), { ...pending, ceilingThbMinor: undefined });

    expect(rights.because).toBe('own_request');
  });

  /* ---------------------------------------------------------------- *
   * The scopes that are not a member of staff
   * ---------------------------------------------------------------- */

  it('⚠️ gives the system scope no authority, though it holds every permission', () => {
    /*
     * `scopeHolds(systemScope(...), anything)` is true — that is what the system scope is for. A
     * worker that could approve a concession on its own authority is a worker with a ceiling
     * nobody granted, so this refuses on the scope's *kind* before the permission is consulted,
     * which is the same thing `staffUserId` does one layer up.
     */
    const rights = approvalRights(systemScope('outbox drain'), pending);

    expect(rights).toStrictEqual({ mayApprove: false, mayRefuse: false, because: 'not_an_approver' });
  });

  it('gives a guest and the public nothing', () => {
    const guest = guestScope(randomUUID());

    expect(approvalRights(guest, pending).mayRefuse).toBe(false);
    expect(approvalRights(PUBLIC_SCOPE, pending).mayRefuse).toBe(false);
  });
});
