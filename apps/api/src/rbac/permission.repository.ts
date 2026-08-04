import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq } from '@wewin/db/sql';
import { groupPermissions, userGroups, users, type UserStatus } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import { isPermissionCode, type PermissionCode } from './permissions';

export interface EffectivePermissions {
  /**
   * `users.status`, read on the same request that reads the permissions.
   *
   * It belongs here rather than in a second query because it answers the same question —
   * "what may this person do" — and because an access token is verified by signature alone:
   * suspending an account does not invalidate the tokens already handed out for it. This is
   * the read that stops a non-active account from working for the rest of its token's life.
   *
   * **The status itself and not a boolean.** This used to be `active: boolean`, which was
   * enough while the only two members were `active` and `suspended`. With `closed` and
   * `erased` it is a collapse: the guard said one sentence for every refusal, so nothing
   * downstream could tell a reinstatable closure from an irreversible erasure, and a
   * reinstatement path could not distinguish the state it may reverse from the one it must
   * not. Decisions are made through `accountUsability` (rbac/account-status.ts), whose
   * exhaustive record is what makes a fifth status a compile error here rather than a
   * silent branch.
   *
   * `'erased'` for a user id that does not exist at all: the safest of the four, and the
   * one that cannot be mistaken for a working account.
   */
  readonly status: UserStatus;
  readonly groupIds: readonly string[];
  readonly permissions: ReadonlySet<PermissionCode>;
}

/**
 * user → group → permission. One join, one path.
 *
 * There is deliberately no table granting a permission straight to a user (see the note
 * on `user_groups` in the schema), so this query is the whole of "what may this person
 * do". A second path would be a second place to get it right, and "why can this person
 * refund?" has to have one answer a support conversation can reach.
 *
 * `leftJoin` and not `innerJoin`: a user in a group that carries no permissions is still
 * in that group, and `groupIds` is what a future row-visibility rule ("sales sees sales'
 * orders") will filter on. An inner join would make such a user look like a user in no
 * groups at all.
 */
@Injectable()
export class PermissionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async effectivePermissions(userId: string): Promise<EffectivePermissions> {
    /*
     * Two statements and not one join. Adding `users` to the query below would drop the
     * whole answer for a user in no groups — the common case for a customer — and turning
     * it into a right join to avoid that makes "no such user" and "no groups" the same row.
     * Two reads on a primary key are cheaper than either mistake.
     */
    const [account] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const rows = await this.db
      .select({ groupId: userGroups.groupId, code: groupPermissions.permissionCode })
      .from(userGroups)
      .leftJoin(groupPermissions, eq(groupPermissions.groupId, userGroups.groupId))
      .where(eq(userGroups.userId, userId));

    const groupIds = new Set<string>();
    const permissions = new Set<PermissionCode>();

    for (const row of rows) {
      groupIds.add(row.groupId);
      /*
       * The runtime half of plan 6(d). After a rollback the database holds codes this
       * build has never heard of — release N+1 added them and somebody granted them.
       * They are skipped, not rejected: a group that carries one unknown permission and
       * five known ones still carries the five, and the user keeps working. The strict
       * comparison that notices the difference is the boot sync's warning and CI, not a
       * request that fails for a customer.
       */
      if (row.code !== null && isPermissionCode(row.code)) permissions.add(row.code);
    }

    return { status: account?.status ?? 'erased', groupIds: [...groupIds], permissions };
  }
}
