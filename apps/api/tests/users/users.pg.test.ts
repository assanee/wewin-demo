import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';

/**
 * User administration over real HTTP, against a real Postgres.
 *
 * `lockout.test.ts` states the two policies against pure functions. This file answers what
 * fakes cannot: **whether the query that feeds them is right.** `administratorsExcluding`
 * decides who "would still hold `users.write`", and every case that matters — a person in
 * two admin groups, a suspended administrator, a group being emptied while another still
 * grants it — is a `WHERE` clause. A fake returning a `Set` proves the arithmetic and
 * nothing about the arithmetic's inputs.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('who works here', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  /** An administrator: holds `users.read` and `users.write`. */
  let admin: Actor;
  /** A second one, so the last-administrator guard has something to count. */
  let deputy: Actor;
  /** Holds `users.read` only — the read-only case the split exists for. */
  let viewer: Actor;
  /** Holds nothing relevant. */
  let outsider: Actor;

  const groupIdOf = async (userId: string): Promise<string> => {
    const rows = await db.execute<{ group_id: string }>(
      sql`select group_id from user_groups where user_id = ${userId}::uuid limit 1`,
    );
    const id = rows.rows[0]?.group_id;
    if (id === undefined) throw new Error('actor has no group');
    return id;
  };

  const listUsers = async (actor: Actor) => call('GET', '/admin/users', { token: actor.token });

  /**
   * A real row in `sessions` for an actor.
   *
   * ⚠️ `makeActor` signs a token with `sessionId: randomUUID()` and **writes no session
   * row** — verification is signature-only by design, so the token works and the table stays
   * empty. Every assertion here about sessions being revoked would otherwise be counting
   * zero against zero and passing for the wrong reason, which is how the first draft of this
   * file "proved" that `users_status_revoke_sessions` worked.
   */
  const giveSession = async (userId: string): Promise<void> => {
    /*
     * Three columns, and that is the whole row: `sessions` holds no token at all. The
     * refresh secret lives in its own table — which is what lets `rotate_refresh_token` be
     * one statement — so a fixture that tried to write a `token_hash` here fails with
     * `column "token_hash" of relation "sessions" does not exist`, as the first draft did.
     */
    await db.execute(sql`
      insert into sessions (user_id, expires_at)
      values (${userId}::uuid, now() + interval '30 days')
    `);
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    admin = await makeActor(db, app, `users admin ${tag}`, ['users.read', 'users.write']);
    deputy = await makeActor(db, app, `users deputy ${tag}`, ['users.read', 'users.write']);
    viewer = await makeActor(db, app, `users viewer ${tag}`, ['users.read']);
    outsider = await makeActor(db, app, `users outsider ${tag}`, ['orders.read']);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * The read/write split
   * ---------------------------------------------------------------- */

  it('lets users.read look and refuses it every change', async () => {
    expect((await listUsers(viewer)).status).toBe(200);

    /*
     * ⭐ The reason the two permissions are separate. A support lead answering "does Somchai
     * still have access?" should not thereby be able to grant themselves `orders.refund`.
     */
    const attempt = await call('POST', `/admin/users/${outsider.userId}/suspension`, {
      token: viewer.token,
      body: { reasonTh: 'ทดสอบว่าคนที่ดูได้อย่างเดียวทำไม่ได้' },
    });
    expect(attempt.status).toBe(403);
  });

  it('refuses somebody holding neither', async () => {
    expect((await listUsers(outsider)).status).toBe(403);
  });

  /* ---------------------------------------------------------------- *
   * Banning
   * ---------------------------------------------------------------- */

  it('⭐ suspends an account and the database ends its sessions in the same breath', async () => {
    const victim = await makeActor(db, app, `users victim ${tag}`, ['orders.read']);

    await giveSession(victim.userId);
    const before = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from sessions
       where user_id = ${victim.userId}::uuid and revoked_at is null
    `);
    expect(before.rows[0]?.n).toBe(1);

    const banned = await call('POST', `/admin/users/${victim.userId}/suspension`, {
      token: admin.token,
      body: { reasonTh: 'ลาออกแล้วแต่ยังไม่ได้คืนเครื่อง' },
    });
    expect(banned.status, JSON.stringify(banned.body)).toBe(204);

    /*
     * Nothing in `UsersService` revokes anything. `users_status_revoke_sessions` fires on the
     * status change, inside the same transaction — which is the only arrangement where a
     * suspension cannot be committed *without* the sessions ending.
     */
    const live = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from sessions
       where user_id = ${victim.userId}::uuid and revoked_at is null
    `);
    expect(live.rows[0]?.n).toBe(0);

    const reasons = await db.execute<{ revoked_reason: string }>(sql`
      select distinct revoked_reason from sessions where user_id = ${victim.userId}::uuid
    `);
    expect(reasons.rows.map((row) => row.revoked_reason)).toEqual(['revoked_by_admin']);
  });

  it('refuses a suspension with no reason on it', async () => {
    const victim = await makeActor(db, app, `users noreason ${tag}`, []);
    const attempt = await call('POST', `/admin/users/${victim.userId}/suspension`, {
      token: admin.token,
      body: { reasonTh: '' },
    });
    // Not enforced by the database — `users_suspended_at_present` only wants the timestamp —
    // so the schema is the only thing standing between this and an unexplainable decision.
    expect(attempt.status).toBe(400);
  });

  it('reinstates, and the account can sign in to the API again', async () => {
    const victim = await makeActor(db, app, `users back ${tag}`, ['orders.read']);

    await call('POST', `/admin/users/${victim.userId}/suspension`, {
      token: admin.token,
      body: { reasonTh: 'พักงานชั่วคราวระหว่างสอบสวน' },
    });
    const reinstated = await call('DELETE', `/admin/users/${victim.userId}/suspension`, {
      token: admin.token,
    });
    expect(reinstated.status, JSON.stringify(reinstated.body)).toBe(204);

    const row = await db.execute<{ status: string; suspended_at: Date | null }>(sql`
      select status, suspended_at from users where id = ${victim.userId}::uuid
    `);
    expect(row.rows[0]?.status).toBe('active');
    // `users_suspended_at_present` is a CHECK in both directions: an active row may not keep
    // the timestamp of a suspension it is no longer under.
    expect(row.rows[0]?.suspended_at).toBeNull();
  });

  it('refuses to suspend an account that is already suspended', async () => {
    const victim = await makeActor(db, app, `users twice ${tag}`, []);
    const body = { reasonTh: 'ระงับซ้ำ' };

    expect((await call('POST', `/admin/users/${victim.userId}/suspension`, { token: admin.token, body })).status).toBe(204);
    const again = await call('POST', `/admin/users/${victim.userId}/suspension`, { token: admin.token, body });

    // 409 and not a silent 204: the UPDATE is guarded by `status = 'active'`, so a second
    // call changes nothing, and reporting success over nothing is how a screen lies.
    expect(again.status).toBe(409);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ The lockouts, against the real query
   * ---------------------------------------------------------------- */

  it('refuses to let an administrator suspend themselves', async () => {
    const attempt = await call('POST', `/admin/users/${admin.userId}/suspension`, {
      token: admin.token,
      body: { reasonTh: 'เผลอกดแถวตัวเอง' },
    });

    expect(attempt.status).toBe(409);
    expect((attempt.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'self-suspend',
    );
  });

  it('refuses to let an administrator change their own groups', async () => {
    const attempt = await call('PUT', `/admin/users/${admin.userId}/groups`, {
      token: admin.token,
      body: { groupIds: [] },
    });
    expect(attempt.status).toBe(409);
  });

  it('allows demoting an administrator while another one exists', async () => {
    const deputyGroup = await groupIdOf(deputy.userId);

    // `deputy` is the other one. This is the ordinary case and must not be refused.
    const demoted = await call('PUT', `/admin/users/${deputy.userId}/groups`, {
      token: admin.token,
      body: { groupIds: [] },
    });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(204);

    /*
     * ⚠️ Put back through the id captured *before* the removal. Reading it afterwards finds
     * nothing — the membership row is what was deleted — and the first draft did exactly
     * that, leaving the suite one administrator short for every test after it.
     */
    const restored = await call('PUT', `/admin/users/${deputy.userId}/groups`, {
      token: admin.token,
      body: { groupIds: [deputyGroup] },
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(204);
  });

  it('⭐ refuses to remove the last administrator, counting only active ones', async () => {
    const solo = await makeActor(db, app, `users solo ${tag}`, ['users.read', 'users.write']);
    const soloGroup = await groupIdOf(solo.userId);

    /*
     * Suspend every *other* administrator so `solo` is the only active holder. This is the
     * case a fake cannot construct honestly: the guard's answer depends on a join through
     * `user_groups`, `group_permissions` and `users.status`, and the third of those is the
     * one an implementation forgets.
     */
    for (const other of [admin, deputy]) {
      await db.execute(
        sql`update users set status = 'suspended', suspended_at = now() where id = ${other.userId}::uuid`,
      );
    }

    try {
      const attempt = await call('PUT', `/admin/groups/${soloGroup}/permissions`, {
        token: solo.token,
        body: { permissions: ['users.read'] },
      });

      expect(attempt.status).toBe(409);
      expect(
        (attempt.body as { error?: { details?: { reason?: string } } }).error?.details?.reason,
      ).toBe('no-administrator-left');
    } finally {
      for (const other of [admin, deputy]) {
        await db.execute(
          sql`update users set status = 'active', suspended_at = null where id = ${other.userId}::uuid`,
        );
      }
    }
  });

  it('allows a group to drop other permissions while it keeps users.write', async () => {
    const group = await groupIdOf(admin.userId);
    const kept = await call('PUT', `/admin/groups/${group}/permissions`, {
      token: admin.token,
      body: { permissions: ['users.read', 'users.write'] },
    });

    // Removing `catalog.publish` from the administrators is not a lockout, and a guard that
    // refused it would be the guard people route around.
    expect(kept.status, JSON.stringify(kept.body)).toBe(204);
  });

  /* ---------------------------------------------------------------- *
   * Creating, and the rest of the surface
   * ---------------------------------------------------------------- */

  it('creates an account with a verified address and no password at all', async () => {
    const email = `hired-${tag}@probe.invalid`;
    const created = await call('POST', '/admin/users', {
      token: admin.token,
      body: { email, displayName: 'พนักงานใหม่', groupIds: [] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const userId = (created.body as { userId: string }).userId;
    const rows = await db.execute<{ verified: boolean; creds: number }>(sql`
      select (e.verified_at is not null) as verified,
             (select count(*)::int from password_credentials p where p.user_id = u.id) as creds
        from users u join user_emails e on e.user_id = u.id
       where u.id = ${userId}::uuid
    `);

    expect(rows.rows[0]?.verified).toBe(true);
    /*
     * ⭐ No credential. The person sets their own through the one-shot link, so no
     * administrator ever knows anybody's password — which is a property that survives the
     * administrator leaving the company.
     */
    expect(rows.rows[0]?.creds).toBe(0);
  });

  it('refuses an address that already belongs to somebody', async () => {
    const email = `dupe-${tag}@probe.invalid`;
    const body = { email, displayName: 'คนแรก', groupIds: [] };

    expect((await call('POST', '/admin/users', { token: admin.token, body })).status).toBe(201);
    const again = await call('POST', '/admin/users', { token: admin.token, body });

    // Said plainly, which is safe here and would not be on the login page: the caller can
    // already see the whole list, so there is nothing to enumerate.
    expect(again.status).toBe(409);
  });

  it('signs somebody out everywhere without suspending them', async () => {
    const victim = await makeActor(db, app, `users lostlaptop ${tag}`, ['orders.read']);
    await giveSession(victim.userId);

    const revoked = await call('POST', `/admin/users/${victim.userId}/sessions/revocation`, {
      token: admin.token,
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(201);
    expect((revoked.body as { revoked: number }).revoked).toBeGreaterThan(0);

    // Still able to work — that is the whole difference from a suspension.
    const row = await db.execute<{ status: string }>(
      sql`select status from users where id = ${victim.userId}::uuid`,
    );
    expect(row.rows[0]?.status).toBe('active');
  });

  it('refuses to delete a group that still has members', async () => {
    const group = await groupIdOf(viewer.userId);
    const attempt = await call('DELETE', `/admin/groups/${group}`, { token: admin.token });

    /*
     * `user_groups` cascades, so the delete would succeed and quietly strip permissions from
     * everybody in it. A button labelled "delete group" must not do that.
     */
    expect(attempt.status).toBe(409);
    expect((attempt.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'group-not-empty',
    );
  });

  it('creates, renames and deletes an empty group', async () => {
    const created = await call('POST', '/admin/groups', {
      token: admin.token,
      body: { code: `temp_${tag}`, nameTh: 'กลุ่มชั่วคราว', permissions: ['orders.read'] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const groupId = (created.body as { groupId: string }).groupId;

    expect(
      (await call('PATCH', `/admin/groups/${groupId}`, { token: admin.token, body: { nameTh: 'เปลี่ยนชื่อแล้ว' } }))
        .status,
    ).toBe(204);

    expect((await call('DELETE', `/admin/groups/${groupId}`, { token: admin.token })).status).toBe(204);
  });

  it('refuses a group code the database would refuse', async () => {
    // `groups_code_shape` is `^[a-z][a-z0-9_]*$`. Caught by the schema so the person gets a
    // sentence rather than a constraint violation printed as a failed INSERT.
    const attempt = await call('POST', '/admin/groups', {
      token: admin.token,
      body: { code: 'has-hyphens', nameTh: 'ไม่ผ่าน', permissions: [] },
    });
    expect(attempt.status).toBe(400);
  });

  it('lists a user with their groups, permissions and live session count', async () => {
    const listed = await listUsers(admin);
    expect(listed.status).toBe(200);

    const me = (listed.body as { users: { id: string; permissions: string[]; groups: unknown[] }[] }).users.find(
      (user) => user.id === admin.userId,
    );
    expect(me?.permissions).toContain('users.write');
    expect(me?.groups.length).toBeGreaterThan(0);
  });
});
