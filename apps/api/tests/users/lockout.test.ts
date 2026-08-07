import { describe, expect, it } from 'vitest';

import {
  lastAdministratorProblem,
  selfActionProblem,
  USER_ADMIN_PERMISSION,
} from '../../src/users/lockout';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The two ways a user-administration screen locks the company out of itself.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything else on this surface is recoverable by an administrator. These two are not,
 * and the database cannot help: `users_status_revoke_sessions` happily suspends the last
 * person who could unsuspend anybody, because a trigger has no idea who is holding the
 * mouse, and `group_permissions` has no notion of a permission that must never reach zero
 * holders.
 *
 * The exit from either is a `psql` prompt on the production database, or `create-staff-user`
 * on a machine with `DATABASE_URL`. Both are things a company with an admin screen has
 * stopped expecting to need — which is exactly why the screen has to refuse.
 */

describe('you may not lock yourself out', () => {
  it('refuses to suspend the account making the request', () => {
    /*
     * The obvious one, and the one that happens by accident: two rows apart in a table, the
     * same button, and the person is signed out mid-click because
     * `users_status_revoke_sessions` fires inside the same transaction.
     */
    expect(selfActionProblem('user-1', 'user-1', 'suspend')).toBe('self-suspend');
    expect(selfActionProblem('user-1', 'user-2', 'suspend')).toBeNull();
  });

  it('refuses to take the caller’s own administration rights away', () => {
    // Slower and worse: the screen stays open and looks fine until the next request 403s.
    expect(selfActionProblem('user-1', 'user-1', 'permissions')).toBe('self-permissions');
    expect(selfActionProblem('user-1', 'user-2', 'permissions')).toBeNull();
  });

  it('allows the caller to act on themselves in no case at all', () => {
    /*
     * Stated as a property rather than case by case, so a third action added later has to
     * come back to this file and decide, rather than defaulting to "allowed" the way a
     * `switch` with two arms and no `default` would.
     */
    for (const action of ['suspend', 'permissions'] as const) {
      expect(selfActionProblem('same', 'same', action)).not.toBeNull();
    }
  });
});

describe('⭐ the last administrator cannot be demoted', () => {
  /*
   * `users.write` is the permission that grants `users.write`. Once nobody holds it, no
   * screen in the application can give it back — `users.read`, `catalog.publish` and
   * `orders.refund` are all still held by somebody, and none of them opens this page.
   *
   * The check is over *holders*, not over the row being edited: the caller has already been
   * stopped from demoting themselves, so this is the case where an administrator removes the
   * rights of the only *other* administrator, having earlier had their own removed by a
   * third person who has since left.
   */
  const holders = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  it('refuses when the group being changed holds the last of it', () => {
    expect(
      lastAdministratorProblem({
        holdersAfter: holders(),
        permissionsAfter: new Set(['catalog.read']),
      }),
    ).toBe('no-administrator-left');
  });

  it('allows the change when somebody else still holds it', () => {
    expect(
      lastAdministratorProblem({
        holdersAfter: holders('someone-else'),
        permissionsAfter: new Set(['catalog.read']),
      }),
    ).toBeNull();
  });

  it('allows a change that keeps the permission on the group being edited', () => {
    // Removing `catalog.publish` from the admin group is not a lockout, and refusing it
    // would make the guard the thing people work around rather than the thing that saves
    // them once.
    expect(
      lastAdministratorProblem({
        holdersAfter: holders(),
        permissionsAfter: new Set([USER_ADMIN_PERMISSION, 'catalog.read']),
      }),
    ).toBeNull();
  });

  it('counts a holder outside the group being edited', () => {
    /*
     * The realistic shape: two groups both carry `users.write`, and one of them is being
     * emptied. `holdersAfter` is computed by the repository as "users who would still hold
     * it once this change is applied", which is the only formulation that survives a person
     * being in two groups at once.
     */
    expect(
      lastAdministratorProblem({
        holdersAfter: holders('in-the-other-group'),
        permissionsAfter: new Set([]),
      }),
    ).toBeNull();
  });

  it('is about `users.write` and nothing else', () => {
    /*
     * ⚠️ Deliberately *not* generalised to "every permission must keep a holder". Losing the
     * last `orders.refund` is a bad afternoon and an administrator fixes it; losing the last
     * `users.write` is the one that cannot be fixed from inside the application, and a guard
     * that fired on all seventeen would be a guard people learn to route around.
     */
    expect(USER_ADMIN_PERMISSION).toBe('users.write');
  });
});

describe('⭐ the administrator door refuses self-service', () => {
  it('⚠️ will not let an administrator disable their own second factor', () => {
    /*
     * The hole this closes is a combination, not a single mistake.
     *
     * `auth/mfa/reproof.ts` makes disabling a second factor cost the account's password —
     * an unlocked laptop is otherwise a way to strip one off with nothing but what is
     * already on the screen. The administrator route asks for no password, correctly,
     * because an administrator does not have somebody else's.
     *
     * Point that route at yourself and the two combine: anybody holding `users.write` turns
     * their own second factor off having proved nothing. Neither half is wrong on its own,
     * which is why nothing catches it except a rule about the pair.
     */
    expect(selfActionProblem('user-1', 'user-1', 'disable-mfa')).toBe('self-disable-mfa');
  });

  it('still lets them disable somebody else’s, which is what the route is for', () => {
    expect(selfActionProblem('user-1', 'user-2', 'disable-mfa')).toBeNull();
  });
});
