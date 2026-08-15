import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, eq, inArray, sql } from '@wewin/db/sql';
import { groupPermissions, groups, userEmails, userGroups, userPhones, users } from '@wewin/db/schema';
import type { UserStatus } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import { AuditRepository } from './audit.repository';
import type { PermissionCode } from '../rbac/permissions';
import { USER_ADMIN_PERMISSION } from './lockout';
import type { GroupWire, UserPhoneWire, UserSummaryWire } from './users.contract';

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

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
      phones_json: unknown;
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
             /*
              * ⚠️ Every claim, not "where verified_at is not null" the way emails above
              * filters. See UserPhoneWire — the "verify" button needs the unverified row
              * on the screen, and each entry carries its own verifiedAt so none of them
              * reads as a fact it is not.
              */
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', p.id, 'number', p.number, 'isPrimary', p.is_primary,
                        'verifiedAt', p.verified_at, 'verifiedByUserId', p.verified_by_user_id
                      ) order by p.is_primary desc, p.created_at), '[]'::jsonb)
                from user_phones p
               where p.user_id = u.id)                                        as phones_json,
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
      phones: normalisePhoneRows(row.phones_json),
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
  async setSuspended(userId: string, suspended: boolean, actorUserId: string): Promise<void> {
    /*
     * ⭐ A transaction for one UPDATE, and the transaction is the point.
     *
     * This was a bare `db.execute`. The audit row now goes in beside it, so the status change
     * and the record of who made it either both land or neither does — a row written after
     * the commit is missing whenever the process dies in between, and the gap is invisible
     * because the only thing that would have reported it is the row that was never written.
     *
     * `users_status_revoke_sessions` already fires inside this same transaction. It is now
     * three facts committing together rather than two.
     */
    await this.db.transaction(async (tx) => {
      await tx.execute(
        suspended
          ? sql`update users set status = 'suspended', suspended_at = now()
                 where id = ${userId}::uuid and status = 'active'`
          : sql`update users set status = 'active', suspended_at = null
                 where id = ${userId}::uuid and status = 'suspended'`,
      );

      await this.audit.record(tx, {
        action: suspended ? 'user.suspended' : 'user.reinstated',
        actorUserId,
        subjectUserId: userId,
      });
    });
  }

  /** Replace a user's group membership wholesale. */
  async setUserGroups(
    userId: string,
    groupIds: readonly string[],
    actorUserId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(userGroups).where(eq(userGroups.userId, userId));
      if (groupIds.length > 0) {
        await tx
          .insert(userGroups)
          .values(groupIds.map((groupId) => ({ userId, groupId })))
          .onConflictDoNothing();
      }

      /*
       * The group *ids*, not their names. Names change; the audit is about which grants were
       * held, and a renamed group must read the same in a row written a year ago.
       */
      await this.audit.record(tx, {
        action: 'user.groups_changed',
        actorUserId,
        subjectUserId: userId,
        payload: { groupIds: [...groupIds] },
      });
    });
  }

  async setGroupPermissions(
    groupId: string,
    permissions: readonly PermissionCode[],
    actorUserId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(groupPermissions).where(eq(groupPermissions.groupId, groupId));
      if (permissions.length > 0) {
        await tx
          .insert(groupPermissions)
          .values(permissions.map((permissionCode) => ({ groupId, permissionCode })))
          .onConflictDoNothing();
      }

      /*
       * ⚠️ The group's `code` as well as the permissions, because
       * `admin_events_group_actions_carry_a_code` demands it of every `group.*` row — the
       * foreign key is `ON DELETE SET NULL`, so the code is what keeps this readable after
       * the group is gone.
       *
       * This is the call site that found the CHECK: it wrote `{ permissions }` alone and
       * every permission change 500'd until the code went in beside them.
       *
       * Permission codes are the RBAC vocabulary itself — no person is described by them, so
       * they are safe in a row that outlives an erasure.
       */
      const [named] = await tx
        .select({ code: groups.code })
        .from(groups)
        .where(eq(groups.id, groupId))
        .limit(1);

      await this.audit.record(tx, {
        action: 'group.permissions_changed',
        actorUserId,
        subjectGroupId: groupId,
        payload: { code: named?.code ?? 'unknown', permissions: [...permissions] },
      });
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
    readonly actorUserId: string;
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

      /*
       * ⚠️ The id and the groups. **Not the address** — `users.service.ts` logs
       * `created ${userId} (${email})` and an audit row written to match would put an
       * address in the one table an erasure cannot reach.
       * `admin_events_payload_is_impersonal` refuses it, which is the guard rather than the
       * intention. The address lives, and dies, in `user_emails`.
       */
      await this.audit.record(tx, {
        action: 'user.created',
        actorUserId: input.actorUserId,
        subjectUserId: created.id,
        payload: { groupIds: [...input.groupIds] },
      });

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
  async revokeSessions(userId: string, actorUserId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        update sessions set revoked_at = now(), revoked_reason = 'revoked_by_admin'
         where user_id = ${userId}::uuid and revoked_at is null
        returning id
      `);

      /*
       * The count, not the session ids. A session id is a bearer-adjacent identifier and the
       * audit answers "how many devices were signed out", which is the question somebody
       * actually asks afterwards.
       */
      await this.audit.record(tx, {
        action: 'user.sessions_revoked',
        actorUserId,
        subjectUserId: userId,
        payload: { revoked: result.rows.length },
      });

      return result.rows.length;
    });
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
    readonly actorUserId: string;
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

      await this.audit.record(tx, {
        action: 'group.created',
        actorUserId: input.actorUserId,
        subjectGroupId: created.id,
        payload: { code: input.code, permissions: [...input.permissions] },
      });

      return created.id;
    });
  }

  async renameGroup(groupId: string, nameTh: string, actorUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      /*
       * ⚠️ `returning code`, because every `group.*` payload must carry it —
       * `admin_events_group_actions_carry_a_code`. The foreign key is `ON DELETE SET NULL`,
       * so the code is what keeps the row readable after the group is gone.
       */
      const [updated] = await tx
        .update(groups)
        .set({ nameTh })
        .where(eq(groups.id, groupId))
        .returning({ code: groups.code });

      if (updated === undefined) return;

      await this.audit.record(tx, {
        action: 'group.renamed',
        actorUserId,
        subjectGroupId: groupId,
        payload: { code: updated.code, nameTh },
      });
    });
  }

  /**
   * ⚠️ The row is written first, and then the delete nulls its own pointer.
   *
   * `subject_group_id` is `ON DELETE SET NULL` — it was `RESTRICT` for one commit, which
   * made deleting an audited group impossible and turned the audit into a constraint on the
   * thing it was supposed to observe. The 500 that produced was the feature breaking, not
   * the guard working.
   *
   * So the row survives the group and reads as "somebody deleted the group `sales`", which
   * is only true because `code` is in the payload. `admin_events_group_actions_carry_a_code`
   * is what makes that a rule rather than a habit.
   */
  async deleteGroup(groupId: string, actorUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [doomed] = await tx
        .select({ code: groups.code })
        .from(groups)
        .where(eq(groups.id, groupId))
        .limit(1);

      if (doomed === undefined) return;

      await this.audit.record(tx, {
        action: 'group.deleted',
        actorUserId,
        subjectGroupId: groupId,
        payload: { code: doomed.code },
      });

      await tx.delete(groups).where(eq(groups.id, groupId));
    });
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

  /** `undefined` when no such row, so the service can answer 404 rather than crash. */
  async findPhone(phoneId: string): Promise<
    | {
        readonly id: string;
        readonly userId: string;
        readonly verifiedAt: Date | null;
        readonly verifiedByUserId: string | null;
        readonly isPrimary: boolean;
      }
    | undefined
  > {
    const [row] = await this.db
      .select({
        id: userPhones.id,
        userId: userPhones.userId,
        verifiedAt: userPhones.verifiedAt,
        verifiedByUserId: userPhones.verifiedByUserId,
        isPrimary: userPhones.isPrimary,
      })
      .from(userPhones)
      .where(eq(userPhones.id, phoneId))
      .limit(1);

    return row;
  }

  /**
   * ⭐ A staff assertion, not proof of possession — and a compare-and-set, not a blind write.
   *
   * `where verified_at is null` is what makes "verifying an already-verified number does not
   * silently rewrite the original actor and timestamp" true rather than merely intended: two
   * staff opening the same stale row and both pressing verify can only have one UPDATE match.
   * The other returns zero rows, the service reads that as a conflict, and the actor the first
   * caller wrote stands. A read-then-write in the service would have the same race the
   * suspension guard exists to avoid — the check and the write have to be one statement.
   *
   * `userId` is part of the `where`, not only checked earlier in the service — the caller
   * already confirmed the phone belongs to this user, and repeating it here means the UPDATE
   * itself cannot act on the wrong person's row even if that check is ever skipped upstream.
   */
  /**
   * ⭐ Records that somebody issued a set-password link for another account.
   *
   * ⚠️ One statement in its own transaction, which is the exception in this file and is called
   * out rather than hidden: the thing it describes — the `auth_tokens` row — was written by the
   * auth module in a transaction this class never sees. `UsersService.sendSetPasswordLinkTo`
   * carries the full argument and the shape to take if it ever needs to be exact.
   *
   * No payload. `admin_events_payload_is_impersonal` raises on any value containing `@`, and the
   * address is the one value obviously in hand here — which is precisely the mistake that trigger
   * exists to catch. `subject_user_id` already says whose account it was.
   */
  async recordPasswordLinkSent(userId: string, actorUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: 'user.password_link_sent',
        actorUserId,
        subjectUserId: userId,
      });
    });
  }

  async verifyPhone(phoneId: string, userId: string, actorUserId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(userPhones)
        .set({ verifiedAt: new Date(), verifiedByUserId: actorUserId })
        .where(
          and(
            eq(userPhones.id, phoneId),
            eq(userPhones.userId, userId),
            sql`${userPhones.verifiedAt} is null`,
          ),
        )
        .returning({ id: userPhones.id });

      if (updated.length !== 1) return false;

      /*
       * `user_phones.verified_at` / `.verified_by_user_id` are already the record of who and
       * when — see the schema comment. This row exists for what un-verifying does to that
       * pair: it NULLs both, so without a row here the fact that a mistaken assertion (and
       * its correction) ever happened would not survive the undo. Ids only in the payload —
       * the phone number itself is exactly the kind of personal data `admin_events_payload_
       * is_impersonal` exists to keep out.
       */
      await this.audit.record(tx, {
        action: 'user.phone_verified',
        actorUserId,
        subjectUserId: userId,
        payload: { phoneId },
      });

      return true;
    });
  }

  /**
   * Clear a mistaken verification.
   *
   * Both columns go to null together, never one alone — `user_phones_voucher_needs_a_
   * verification` refuses a voucher on a row that is not verified, so "un-verify" can only
   * mean the pair returning to the state a fresh unverified claim starts in. That is also
   * why this is a compare-and-set on `verified_at is not null` and `not is_primary`: the
   * first makes a double un-verify a conflict rather than a silent no-op, and the second is
   * defence in depth alongside the service's own check — `user_phones_primary_is_verified`
   * would refuse the UPDATE outright if a primary number ever reached here, and this keeps
   * that a 0-row miss the service reports cleanly rather than a 23514 the caller has to
   * decode.
   */
  async unverifyPhone(phoneId: string, userId: string, actorUserId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(userPhones)
        .set({ verifiedAt: null, verifiedByUserId: null })
        .where(
          and(
            eq(userPhones.id, phoneId),
            eq(userPhones.userId, userId),
            sql`${userPhones.verifiedAt} is not null and not ${userPhones.isPrimary}`,
          ),
        )
        .returning({ id: userPhones.id });

      if (updated.length !== 1) return false;

      await this.audit.record(tx, {
        action: 'user.phone_unverified',
        actorUserId,
        subjectUserId: userId,
        payload: { phoneId },
      });

      return true;
    });
  }
}

/**
 * `db.execute` returns the phones subquery as parsed JSON already — `jsonb_agg` crossed the
 * wire as JSON, not as the raw-string trap `created_at`/`suspended_at` fall into above — but
 * `verifiedAt` inside each element is still Postgres's own `timestamptz` text rendering
 * (`2024-01-01 12:00:00+00`), not the `Z`-suffixed ISO string the rest of this wire uses. This
 * is where the two are made to agree.
 */
function normalisePhoneRows(raw: unknown): readonly UserPhoneWire[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((entry) => {
    const row = entry as {
      readonly id: string;
      readonly number: string;
      readonly isPrimary: boolean;
      readonly verifiedAt: string | null;
      readonly verifiedByUserId: string | null;
    };

    return {
      id: row.id,
      number: row.number,
      isPrimary: row.isPrimary,
      verifiedAt: row.verifiedAt === null ? null : new Date(row.verifiedAt).toISOString(),
      verifiedByUserId: row.verifiedByUserId,
    };
  });
}
