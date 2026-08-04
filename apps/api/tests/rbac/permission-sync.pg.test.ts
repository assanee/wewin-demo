import { Logger } from '@nestjs/common';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { groupPermissions, groups, permissions, userGroups, users } from '@wewin/db/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PermissionRepository } from '../../src/rbac/permission.repository';
import { PermissionSyncService } from '../../src/rbac/permission-sync.service';
import { PERMISSIONS, PERMISSION_CODES } from '../../src/rbac/permissions';

/**
 * ⓓ The rollback, rehearsed against a real Postgres.
 *
 * Plan 6(d) names the outage precisely: release N+1 adds a permission, the deploy goes
 * wrong, and the rollback to N finds a database holding a code N has never heard of. If N
 * treats that as a mismatch and refuses to boot, the rollback — the thing that was
 * supposed to end the incident — cannot run.
 *
 * So the two directions are tested as two different behaviours, and the second one is the
 * whole point:
 *
 *   missing in the database → inserted, boot continues
 *   extra in the database   → warned about, left alone, boot continues, and the grants
 *                             that depend on it survive so the way back up to N+1 still
 *                             has somebody's access intact
 *
 * `orders.reconcile` below plays the part of the N+1 permission. It is granted to a group
 * a user belongs to, because the interesting question is not whether a row survives — it
 * is whether the person who was granted it can still work while N is running.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** A code from the future release. Prefixed so it can never collide with the real catalogue. */
const FROM_NEXT_RELEASE = 'orders.reconcile';
const TEST_GROUP = 'rbac_sync_probe';

describeWithPg('permission sync against Postgres', () => {
  let pool: Pool;
  let db: Database;
  let sync: PermissionSyncService;
  let repository: PermissionRepository;
  let groupId: string;
  let userId: string;

  beforeAll(async () => {
    // The sync logs what it inserted, which is the right behaviour at boot and noise in a
    // test run. The `warn` assertion below spies on the prototype, so it is unaffected.
    Logger.overrideLogger(false);

    pool = createPool(url ?? '');
    db = createDatabase(pool);
    sync = new PermissionSyncService(db);
    repository = new PermissionRepository(db);

    await cleanUp(db);

    // A user in a group, so "does a grant survive" can be asked as "can this person still
    // do their job", which is the question the incident is actually about.
    const [user] = await db.insert(users).values({ displayName: 'rbac sync probe' }).returning({ id: users.id });
    const [group] = await db
      .insert(groups)
      .values({ code: TEST_GROUP, nameTh: 'กลุ่มทดสอบ' })
      .returning({ id: groups.id });
    if (!user || !group) throw new Error('fixture insert returned nothing');
    userId = user.id;
    groupId = group.id;
    await db.insert(userGroups).values({ userId, groupId });
  });

  afterAll(async () => {
    await cleanUp(db);
    await pool.end();
  });

  it('inserts what the database does not have, and says what it inserted', async () => {
    // Nothing here deletes the whole table: a sync that only works from empty is not the
    // sync that runs on every boot.
    await db.delete(groupPermissions).where(eq(groupPermissions.permissionCode, 'reviews.moderate'));
    await db.delete(permissions).where(eq(permissions.code, 'reviews.moderate'));

    const report = await sync.sync();

    expect(report.ok).toBe(true);
    expect(report.upserted).toContain('reviews.moderate');
    expect(await codesInDatabase(db)).toEqual(expect.arrayContaining([...PERMISSION_CODES]));
  });

  it('is idempotent — the second boot inserts nothing', async () => {
    const report = await sync.sync();

    expect(report.ok).toBe(true);
    expect(report.upserted).toStrictEqual([]);
  });

  it('rewords a description without a migration', async () => {
    await db.update(permissions).set({ description: 'stale wording' }).where(eq(permissions.code, 'orders.read'));

    await sync.sync();

    const [row] = await db
      .select({ description: permissions.description })
      .from(permissions)
      .where(eq(permissions.code, 'orders.read'));
    expect(row?.description).toBe(PERMISSIONS['orders.read']);
  });

  describe('a rollback: the database holds a permission this build has never heard of', () => {
    beforeAll(async () => {
      // Exactly what release N+1 left behind: the row, and a grant somebody was given.
      await db
        .insert(permissions)
        .values({ code: FROM_NEXT_RELEASE, description: 'Added by the release that was rolled back.' })
        .onConflictDoNothing();
      await db.insert(groupPermissions).values({ groupId, permissionCode: FROM_NEXT_RELEASE }).onConflictDoNothing();
      await db.insert(groupPermissions).values({ groupId, permissionCode: 'orders.read' }).onConflictDoNothing();
    });

    it('boots, warns, and does not throw', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      const report = await sync.sync();

      expect(report.ok).toBe(true);
      expect(report.extra).toContain(FROM_NEXT_RELEASE);

      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings.some((message) => message.includes(FROM_NEXT_RELEASE))).toBe(true);
      // The warning has to say what it is, or the next person reads it as corruption.
      expect(warnings.some((message) => message.includes('rollback'))).toBe(true);

      vi.restoreAllMocks();
    });

    it('leaves the unknown permission exactly where it was', async () => {
      /*
       * Deleting it would be the tidy thing to do and the wrong thing to do twice over:
       * `group_permissions` references it ON DELETE RESTRICT, and the grant it carries is
       * what somebody gets back when the deploy rolls forward again.
       */
      expect(await codesInDatabase(db)).toContain(FROM_NEXT_RELEASE);

      const grants = await db
        .select({ code: groupPermissions.permissionCode })
        .from(groupPermissions)
        .where(eq(groupPermissions.groupId, groupId));
      expect(grants.map((grant) => grant.code).sort()).toStrictEqual(['orders.read', FROM_NEXT_RELEASE]);
    });

    it('keeps the user working: the permissions this build recognises still resolve', async () => {
      /*
       * The runtime half. A group carrying one unrecognised code and one recognised one
       * must not fail the read, and must not smuggle the unrecognised one into a scope
       * where a `PermissionCode`-typed comparison would never match it anyway.
       */
      const effective = await repository.effectivePermissions(userId);

      expect([...effective.permissions]).toStrictEqual(['orders.read']);
      expect(effective.groupIds).toStrictEqual([groupId]);
    });
  });
});

async function codesInDatabase(db: Database): Promise<string[]> {
  const rows = await db.select({ code: permissions.code }).from(permissions);
  return rows.map((row) => row.code);
}

/** Only ever removes what this file created. */
async function cleanUp(db: Database): Promise<void> {
  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.code, TEST_GROUP));
  if (group) {
    await db.delete(groupPermissions).where(eq(groupPermissions.groupId, group.id));
    await db.delete(userGroups).where(eq(userGroups.groupId, group.id));
    await db.delete(groups).where(eq(groups.id, group.id));
  }
  await db.delete(users).where(eq(users.displayName, 'rbac sync probe'));
  await db.delete(groupPermissions).where(eq(groupPermissions.permissionCode, FROM_NEXT_RELEASE));
  await db.delete(permissions).where(eq(permissions.code, FROM_NEXT_RELEASE));
}
