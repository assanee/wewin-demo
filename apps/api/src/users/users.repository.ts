import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, eq, inArray, sql } from '@wewin/db/sql';
import { groupPermissions, groups, userEmails, userGroups, users } from '@wewin/db/schema';
import type { UserStatus } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import type { PermissionCode } from '../rbac/permissions';
import { USER_ADMIN_PERMISSION } from './lockout';
import type { GroupWire, UserSummaryWire } from './users.contract';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Every account, with the groups it belongs to and the permissions those grant.
   *
   * One query with aggregates rather than a list plus a query per user: an N+1 over a table
   * this screen is *for* looking at would be the first thing to hurt, and it would hurt on
   * the day somebody hires ten people.
   *
   * ⚠️ `verified_at is not null` on the address join. An unverified row is a claim, not an
   * identity — `user_emails_one_verified_owner` is a partial index exactly so somebody
   * else's unverified claim on an address can exist harmlessly — and rendering one on an
   * administrator's screen would make it look like a fact about the account.
   */
  async list(): Promise<readonly UserSummaryWire[]> {
    const rows = await this.db.execute<{
      id: string;
      display_name: string | null;
      status: string;
      /*
       * ⚠️ `string`, not `Date`. `db.execute()` is raw SQL and bypasses Drizzle's type
       * parsers, so a `timestamptz` arrives as whatever `pg` made of it — a string here,
       * because nothing in this path registered a parser for it. The generic on `execute` is
       * a *claim*, checked by nobody, and declaring `Date` produced
       * `row.created_at.toISOString is not a function` at runtime with a clean typecheck.
       * Found by calling the endpoint; no test of the service could have seen it.
       */
      suspended_at: string | null;
      created_at: string;
      emails: string[] | null;
      group_json: unknown;
      permissions: string[] | null;
      live_sessions: number;
    }>(sql`
      select u.id,
             u.display_name,
             u.status,
             u.suspended_at,
             u.created_at,
             (select array_agg(e.address order by e.is_primary desc, e.address)
                from user_emails e
               where e.user_id = u.id and e.verified_at is not null)          as emails,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', g.id, 'code', g.code,
                        'nameTh', g.name_th, 'isSystem', g.is_system
                      ) order by g.code), '[]'::jsonb)
                from user_groups ug join groups g on g.id = ug.group_id
               where ug.user_id = u.id)                                        as group_json,
             (select array_agg(distinct gp.permission_code)
                from user_groups ug join group_permissions gp on gp.group_id = ug.group_id
               where ug.user_id = u.id)                                        as permissions,
             (select count(*)::int from sessions s
               where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())
                                                                               as live_sessions
        from users u
       order by u.display_name nulls last, u.created_at
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status as UserStatus,
      emails: row.emails ?? [],
      groups: (row.group_json ?? []) as UserSummaryWire['groups'],
      permissions: ((row.permissions ?? []) as PermissionCode[]).sort(),
      liveSessions: row.live_sessions,
      suspendedAt: row.suspended_at === null ? null : new Date(row.suspended_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async listGroups(): Promise<readonly GroupWire[]> {
    const rows = await this.db.execute<{
      id: string;
      code: string;
      name_th: string;
      is_system: boolean;
      permissions: string[] | null;
      member_count: number;
    }>(sql`
      select g.id, g.code, g.name_th, g.is_system,
             (select array_agg(gp.permission_code order by gp.permission_code)
                from group_permissions gp where gp.group_id = g.id)  as permissions,
             (select count(*)::int from user_groups ug
               where ug.group_id = g.id)                             as member_count
        from groups g
       order by g.code
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameTh: row.name_th,
      isSystem: row.is_system,
      permissions: (row.permissions ?? []) as PermissionCode[],
      memberCount: row.member_count,
    }));
  }

  /** `undefined` when no such account, so the service can answer 404 rather than crash. */
  async statusOf(userId: string): Promise<UserStatus | undefined> {
    const [row] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.status as UserStatus | undefined;
  }

  /**
   * Suspend, or reinstate.
   *
   * `suspended_at` moves with the status because `users_suspended_at_present` is a CHECK: a
   * suspension without the moment it happened is a record nobody can audit. Nothing here
   * revokes sessions — `users_status_revoke_sessions` does that inside this same statement's
   * transaction, which is the only place it cannot be forgotten.
   */
  async setSuspended(userId: string, suspended: boolean): Promise<void> {
    await this.db.execute(
      suspended
        ? sql`update users set status = 'suspended', suspended_at = now()
               where id = ${userId}::uuid and status = 'active'`
        : sql`update users set status = 'active', suspended_at = null
               where id = ${userId}::uuid and status = 'suspended'`,
    );
  }

  /** Replace a user's group membership wholesale. */
  async setUserGroups(userId: string, groupIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(userGroups).where(eq(userGroups.userId, userId));
      if (groupIds.length > 0) {
        await tx
          .insert(userGroups)
          .values(groupIds.map((groupId) => ({ userId, groupId })))
          .onConflictDoNothing();
      }
    });
  }

  async setGroupPermissions(
    groupId: string,
    permissions: readonly PermissionCode[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(groupPermissions).where(eq(groupPermissions.groupId, groupId));
      if (permissions.length > 0) {
        await tx
          .insert(groupPermissions)
          .values(permissions.map((permissionCode) => ({ groupId, permissionCode })))
          .onConflictDoNothing();
      }
    });
  }

  /**
   * ⭐ Who would still hold `users.write` if this group stopped granting it.
   *
   * The whole of the last-administrator guard turns on this query being *"every group except
   * this one"* rather than *"this group's members"*. Somebody in two administrator groups is
   * not losing anything when one of them is emptied, and a count over the group's own
   * membership would say they were — which makes the guard fire on a change that is fine,
   * which is how a guard becomes something people route around.
   *
   * Also used for the membership change, where `excludeGroupId` is undefined and the
   * exclusion is per *user* instead.
   */
  async administratorsExcluding(options: {
    readonly excludeGroupId?: string;
    readonly excludeUserId?: string;
  }): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .selectDistinct({ userId: userGroups.userId })
      .from(userGroups)
      .innerJoin(groupPermissions, eq(groupPermissions.groupId, userGroups.groupId))
      .innerJoin(users, eq(users.id, userGroups.userId))
      .where(
        and(
          eq(groupPermissions.permissionCode, USER_ADMIN_PERMISSION),
          /*
           * A suspended administrator is not an administrator. Counting one would let the
           * last *usable* account be demoted because a dormant row still names the
           * permission — and reinstating that account needs the very permission nobody
           * would have.
           */
          eq(users.status, 'active'),
          options.excludeGroupId === undefined
            ? sql`true`
            : sql`${userGroups.groupId} <> ${options.excludeGroupId}::uuid`,
          options.excludeUserId === undefined
            ? sql`true`
            : sql`${userGroups.userId} <> ${options.excludeUserId}::uuid`,
        ),
      );

    return new Set(rows.map((row) => row.userId));
  }

  /** The permissions a set of groups would grant together. */
  async permissionsOfGroups(groupIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (groupIds.length === 0) return new Set();

    const rows = await this.db
      .selectDistinct({ code: groupPermissions.permissionCode })
      .from(groupPermissions)
      .where(inArray(groupPermissions.groupId, [...groupIds]));

    return new Set(rows.map((row) => row.code));
  }

  /**
   * Create a staff account with a verified address, in one transaction.
   *
   * No `password_credentials` row: the person sets their own through a one-shot link. An
   * account with no credential is a normal state — somebody who signed up with Google has
   * one too — and `PasswordSignInService` answers it identically to a wrong password.
   *
   * `isPrimary` follows `verified` because `user_emails_primary_is_verified` is a CHECK: an
   * address nobody has proven control of may not be the one the company writes to. Here the
   * operator is the proof, which is why this is behind `users.write` and behind no public
   * route at all.
   */
  async createUser(input: {
    readonly email: string;
    readonly displayName: string;
    readonly groupIds: readonly string[];
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ displayName: input.displayName })
        .returning({ id: users.id });
      if (created === undefined) throw new Error('could not create the user row');

      await tx.insert(userEmails).values({
        userId: created.id,
        address: input.email,
        isPrimary: true,
        verifiedAt: new Date(),
      });

      if (input.groupIds.length > 0) {
        await tx
          .insert(userGroups)
          .values(input.groupIds.map((groupId) => ({ userId: created.id, groupId })))
          .onConflictDoNothing();
      }

      return created.id;
    });
  }

  /** Is this address already somebody's verified identity? */
  async addressTaken(address: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: userEmails.id })
      .from(userEmails)
      .where(and(eq(userEmails.address, address), sql`${userEmails.verifiedAt} is not null`))
      .limit(1);

    return row !== undefined;
  }

  /**
   * End every live session without touching the account's status.
   *
   * The lost-laptop action. Suspension would do it too and would also stop the person
   * working, which is the wrong answer to "my phone was stolen on the way home".
   *
   * `revoked_by_admin` is one of the six words `sessions_revoked_reason_known` allows, and it
   * is the accurate one — a revocation with no reason is an incident nobody can describe.
   */
  async revokeSessions(userId: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      update sessions set revoked_at = now(), revoked_reason = 'revoked_by_admin'
       where user_id = ${userId}::uuid and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }

  /** The primary verified address, for sending a set-password link to. */
  async primaryAddressOf(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ address: userEmails.address })
      .from(userEmails)
      .where(and(eq(userEmails.userId, userId), sql`${userEmails.verifiedAt} is not null`))
      .orderBy(sql`${userEmails.isPrimary} desc`)
      .limit(1);

    return row?.address;
  }

  async createGroup(input: {
    readonly code: string;
    readonly nameTh: string;
    readonly permissions: readonly PermissionCode[];
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(groups)
        .values({ code: input.code, nameTh: input.nameTh })
        .returning({ id: groups.id });
      if (created === undefined) throw new Error('could not create the group row');

      if (input.permissions.length > 0) {
        await tx
          .insert(groupPermissions)
          .values(input.permissions.map((permissionCode) => ({ groupId: created.id, permissionCode })));
      }

      return created.id;
    });
  }

  async renameGroup(groupId: string, nameTh: string): Promise<void> {
    await this.db.update(groups).set({ nameTh }).where(eq(groups.id, groupId));
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.db.delete(groups).where(eq(groups.id, groupId));
  }

  async groupById(groupId: string): Promise<GroupWire | undefined> {
    return (await this.listGroups()).find((group) => group.id === groupId);
  }

  async groupExists(groupId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);

    return row !== undefined;
  }
}
