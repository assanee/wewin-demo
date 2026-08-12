import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, eq } from '@wewin/db/sql';
import { groupPermissions, userEmails, userGroups, users, type UserStatus } from '@wewin/db/schema';

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

  /**
   * ⭐ THE SAME JOIN, READ BACKWARDS: who holds this permission, and where do we write to them.
   *
   * `effectivePermissions` answers *"what may this person do"*. This answers *"who may do
   * this"*, which is a different question with the same shape, and it lives in this file for
   * the reason the class header gives about there being one path: `user_groups` →
   * `group_permissions` is the whole of the permission model, and a second file joining those
   * two tables would be a second place that has to learn about it if it ever changes. If a
   * direct user→permission grant is ever added, both directions are fixed here or neither is.
   *
   * Built for `FxStalenessService`, which needs to email the people who can end an exchange-rate
   * outage. Routing by *permission* rather than by a group code or an env var is what makes it
   * follow the model: a super admin holds every code and is therefore included automatically,
   * and delegating `organisation.write` to one new person starts mailing them with nobody
   * editing a recipient list.
   *
   * ── ⚠️ WHO IS EXCLUDED, AND WHY EACH ONE ─────────────────────────────────────────
   *
   * `status = 'active'` only. The other three members of `USER_STATUSES` are all excluded and
   * they are excluded for three different reasons, which is why the filter is a whitelist and
   * not `status <> 'erased'`:
   *
   *   - `erased`   — must never be written to at all. The address is gone under plan 9's
   *                  erasure and the row that remains is a tombstone; the existing customer
   *                  fan-out refuses it with `reason := 'recipient_erased'` for the same
   *                  reason, and this is the stricter surface of the two.
   *   - `closed`   — the account of somebody who has left. `accountUsability` refuses their
   *                  sign-in, so they could not act on the mail even if they read it, and the
   *                  mailbox behind a closed staff account is usually gone.
   *   - `suspended`— holds the permission on paper and cannot use it: the guard refuses every
   *                  request for the rest of the token's life. Mailing them a message whose
   *                  entire content is *"go and fix this"* names an action they are currently
   *                  forbidden from taking.
   *
   * A whitelist also means a fifth status added later is excluded by default, which is the
   * safe direction for a list of people we send mail to.
   *
   * ── ⚠️ `is_primary`, WHICH IS WHY THE ADDRESS IS VERIFIED ────────────────────────
   *
   * `user_emails_primary_is_verified` — *"not is_primary or verified_at is not null"* — means
   * the primary address is verified by construction, so this needs no `verified_at` predicate
   * of its own and cannot drift from one. The same column the customer fan-out selects on.
   * `user_emails_one_primary_per_user` (partial unique) bounds it to one row per person.
   *
   * ⭐ It is also the predicate that excludes a holder with **no** address row, which is not the
   * obvious reading: the `innerJoin` looks like the thing doing that, and it is not. Established
   * by mutation — swapping it for a `leftJoin` changes no result, because the emailless row then
   * carries `is_primary` as `NULL` and `= true` is `NULL`, so the `WHERE` drops it before it can
   * surface as an `address: null`. The inner join states the intent and helps the planner; this
   * predicate is what enforces it.
   *
   * `selectDistinct` is load-bearing: somebody holding `organisation.write` through two groups
   * matches twice, and a duplicate here is a duplicate email. Address rather than user id is
   * enough to dedupe because `user_emails_one_verified_owner` makes a verified address unique
   * across all users, and primary implies verified.
   *
   * Ordered, so a log line and a test read the same way twice.
   */
  async addressesHolding(permission: PermissionCode): Promise<readonly string[]> {
    const rows = await this.db
      .selectDistinct({ address: userEmails.address })
      .from(users)
      .innerJoin(userGroups, eq(userGroups.userId, users.id))
      .innerJoin(groupPermissions, eq(groupPermissions.groupId, userGroups.groupId))
      .innerJoin(userEmails, eq(userEmails.userId, users.id))
      .where(
        and(
          eq(groupPermissions.permissionCode, permission),
          eq(users.status, 'active'),
          eq(userEmails.isPrimary, true),
        ),
      )
      .orderBy(userEmails.address);

    return rows.map((row) => row.address);
  }
}
