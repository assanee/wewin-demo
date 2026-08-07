import type { PermissionCode } from '../rbac/permissions';

/**
 * The two refusals that keep a user-administration screen from locking the company out.
 *
 * Pure functions, in their own file, because they are policy rather than plumbing and
 * because the interesting cases are combinations rather than round trips — see
 * `tests/users/lockout.test.ts`, which states each one without a database.
 *
 * ── What the database already covers, so this does not ───────────────────────────
 *
 * `users_status_revoke_sessions` ends every live session the moment a status leaves
 * `active`, inside the same transaction. `users_erasure_is_earned` refuses the `erased`
 * status until the personal data is actually gone. Neither needs help from here.
 *
 * What neither can do is know **who is holding the mouse**. A trigger sees a row changing;
 * it does not see that the row belongs to the person making the request, and it has no
 * notion of a permission that must never reach zero holders. Those two gaps are this file.
 */

/**
 * The permission that grants the permission.
 *
 * ⚠️ Once nobody holds `users.write`, no screen in this application can give it back. Every
 * other permission has a path to recovery through somebody who still holds this one; this
 * one's only recovery is `psql` on the production database, or running `create-staff-user`
 * on a machine that has `DATABASE_URL`.
 *
 * Deliberately not generalised to "no permission may reach zero holders". Losing the last
 * `orders.refund` is a bad afternoon that an administrator fixes in a minute. A guard that
 * fired on all seventeen would be a guard people learn to route around, and the one time it
 * mattered they would already have the habit.
 */
export const USER_ADMIN_PERMISSION: PermissionCode = 'users.write';

export type SelfAction = 'suspend' | 'permissions' | 'disable-mfa';
export type SelfProblem = 'self-suspend' | 'self-permissions' | 'self-disable-mfa';

/**
 * Whether the caller is acting on their own account.
 *
 * Two actions, two answers, and no `default` arm: a third action added later is a compile
 * error here rather than a silent "allowed".
 */
export function selfActionProblem(
  callerUserId: string,
  targetUserId: string,
  action: SelfAction,
): SelfProblem | null {
  if (callerUserId !== targetUserId) return null;

  switch (action) {
    case 'suspend':
      return 'self-suspend';
    case 'permissions':
      return 'self-permissions';
    /*
     * ⚠️ The hole this closes, and it is not obvious.
     *
     * `auth/mfa/reproof.ts` makes disabling a second factor cost the account's password,
     * because an unlocked laptop is otherwise a way to strip one off with nothing but what
     * is on the screen. The administrator route exists so somebody who has lost their phone
     * can be helped — and it asks for no password, because the administrator does not have
     * the other person's.
     *
     * Pointed at *yourself*, those two facts combine into a door round the rule: any holder
     * of `users.write` could turn their own second factor off without proving anything. So
     * the administrator door refuses self-service, and the self-service door is where the
     * password is asked for.
     */
    case 'disable-mfa':
      return 'self-disable-mfa';
  }
}

export interface LastAdministratorCheck {
  /**
   * Everybody who would still hold `users.write` **after** this change lands.
   *
   * Computed by the repository rather than derived here, because the only formulation that
   * survives a person being in two groups at once is a query: "which users hold it, counting
   * every group except the one being edited". A count of the group's own members would say
   * zero for somebody who is also in a second admin group.
   */
  readonly holdersAfter: ReadonlySet<string>;
  /** The permission set the group being edited would carry afterwards. */
  readonly permissionsAfter: ReadonlySet<string>;
}

/**
 * Whether this change would leave nobody able to administer users.
 *
 * The group keeping the permission is checked first and separately: removing
 * `catalog.publish` from the administrators is not a lockout, and a guard that refused it
 * would be wrong in the ordinary case to be right in the rare one.
 */
export function lastAdministratorProblem(
  check: LastAdministratorCheck,
): 'no-administrator-left' | null {
  if (check.permissionsAfter.has(USER_ADMIN_PERMISSION)) return null;
  return check.holdersAfter.size === 0 ? 'no-administrator-left' : null;
}
