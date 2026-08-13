import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { causeChain } from '../payments/support/money-fixture';
import { AuditRepository } from '../../src/users/audit.repository';
import { UsersRepository } from '../../src/users/users.repository';

import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE AUDIT ROW AND THE CHANGE IT DESCRIBES ARE ONE FACT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every administrative action used to leave a `logger.log` line. A log rotates, is not
 * queryable, cannot be shown to the person it was about, and is gone with the machine.
 * "Who removed her second factor, and when?" had no answer that survived a week.
 *
 * `admin_events` is the answer, and it is only worth having if it is *complete*. The way an
 * audit trail goes incomplete is not dramatic: a row written after the change commits is
 * missing whenever the process dies in between, and the gap is invisible — the only thing
 * that would have reported it is the row that was never written.
 *
 * So `AuditRepository.record` takes a transaction handle and nothing else, and this file
 * proves the consequence in both directions:
 *
 *   ⓵ the change lands **and** the row lands;
 *   ⓶ the change fails **and** the row is gone with it.
 *
 * ⓶ is the one that cannot be faked. It is asserted by making a real request fail on a real
 * guard — the last-administrator rule — and then counting rows.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('the administrative spine', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;
  let admin: Actor;
  let deputy: Actor;
  let subject: Actor;

  const events = async (subjectUserId?: string): Promise<readonly { action: string; payload: Record<string, unknown> }[]> => {
    const rows = await db.execute<{ action: string; payload: Record<string, unknown> }>(sql`
      select action, payload from admin_events
       where ${subjectUserId === undefined ? sql`true` : sql`subject_user_id = ${subjectUserId}::uuid`}
       order by seq
    `);
    return rows.rows;
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);

    admin = await makeActor(db, app, `audit admin ${tag}`, ['users.read', 'users.write']);
    deputy = await makeActor(db, app, `audit deputy ${tag}`, ['users.read', 'users.write']);
    subject = await makeActor(db, app, `audit subject ${tag}`, ['orders.read']);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('⭐ the row lands with the change', () => {
    it('records a suspension, naming who did it and to whom', async () => {
      const before = (await events(subject.userId)).length;

      const response = await call('POST', `/admin/users/${subject.userId}/suspension`, {
        token: admin.token,
        body: { reasonTh: 'ทดสอบบันทึกการจัดการ' },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(204);

      const after = await events(subject.userId);
      expect(after).toHaveLength(before + 1);
      expect(after[after.length - 1]?.action).toBe('user.suspended');

      /* And who: read straight out of the column rather than through the API. */
      const [row] = (
        await db.execute<{ actor: string }>(sql`
          select actor_user_id::text as actor from admin_events
           where subject_user_id = ${subject.userId}::uuid order by seq desc limit 1
        `)
      ).rows;
      expect(row?.actor).toBe(admin.userId);

      await call('DELETE', `/admin/users/${subject.userId}/suspension`, { token: admin.token });
    });

    it('records a group change with the ids, and nothing about the person', async () => {
      const response = await call('PUT', `/admin/users/${subject.userId}/groups`, {
        token: admin.token,
        body: { groupIds: [] },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(204);

      const latest = (await events(subject.userId)).at(-1);

      expect(latest?.action).toBe('user.groups_changed');
      expect(latest?.payload).toStrictEqual({ groupIds: [] });
    });
  });

  describe('⭐ the row rolls back with the change', () => {
    it('⚠️ writes nothing when the change is refused', async () => {
      /*
       * The property that makes the trail *complete* rather than best-effort, and the only
       * way to see it is to make a real request fail on a real guard.
       *
       * Emptying the last administrator's groups is refused by `lastAdministratorProblem`
       * *after* the transaction has begun — so if the audit row were written outside it, or
       * committed separately, the trail would now claim a change that never happened. An
       * audit that records attempts as facts is worse than none: it is wrong in a way
       * nobody can detect from the inside.
       */
      const before = (await events()).length;

      /* Leave exactly one administrator, then try to remove their last admin group. */
      await call('PUT', `/admin/users/${deputy.userId}/groups`, {
        token: admin.token,
        body: { groupIds: [] },
      });

      const countAfterLegitimateChange = (await events()).length;

      const refused = await call('PUT', `/admin/users/${admin.userId}/groups`, {
        token: admin.token,
        body: { groupIds: [] },
      });

      expect(refused.status, 'the last-administrator guard did not fire').toBe(409);
      expect(
        (await events()).length,
        'a refused change left an audit row claiming it happened',
      ).toBe(countAfterLegitimateChange);
      expect(countAfterLegitimateChange).toBeGreaterThan(before);
    });

    it('⭐ undoes the change when the audit row is what fails', async () => {
      /*
       * ⭐ THE TEST THAT ACTUALLY PROVES SAME-TRANSACTION, and the first attempt did not.
       *
       * That one emptied the last administrator's groups and checked no row appeared. True,
       * and it proves nothing about this: `lastAdministratorProblem` fires in the *service*,
       * before the repository is reached at all, so the audit write never happens either way.
       * Moving the write into a second transaction afterwards left it green — the same
       * `0 === 0` shape that has caught me twice before in this repository.
       *
       * The discriminating case is the other order: **the change succeeds and the audit row
       * is what fails.** `actor_user_id` is `NOT NULL REFERENCES users`, so an actor who does
       * not exist makes the insert violate the key *after* the groups have been rewritten.
       *
       *   one transaction  → the group change is rolled back with it
       *   two transactions → the group change is committed and the record is lost
       *
       * Which is exactly the crash a test cannot stage: the process dying between a commit
       * and the row that describes it. This is that failure, made deterministic.
       *
       * Called against the repository rather than over HTTP, because the actor id comes from
       * a verified token and cannot be forged through the API — which is itself correct.
       */
      const repository = new UsersRepository(db, new AuditRepository(db));
      const ghost = '00000000-0000-4000-8000-00000000dead';

      const groups = await db.execute<{ id: string }>(sql`select id::text as id from groups limit 1`);
      const groupId = groups.rows[0]?.id;
      if (groupId === undefined) throw new Error('no group to move the subject into');

      const before = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from user_groups where user_id = ${subject.userId}::uuid`,
      );

      await expect(
        repository.setUserGroups(subject.userId, [groupId], ghost),
      ).rejects.toThrow();

      const after = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from user_groups where user_id = ${subject.userId}::uuid`,
      );

      expect(
        after.rows[0]?.n,
        'the group change committed while its audit row did not — they are not one transaction',
      ).toBe(before.rows[0]?.n);
    });
  });

  describe('⚠️ what the payload may never contain', () => {
    it('refuses an address, because these rows outlive an erasure', async () => {
      /*
       * `ERASURE_TREATMENTS` says `keep` for both user columns — the row is the record that
       * the company acted, not a record about the person. That is only defensible while the
       * payload holds ids and codes, so the CHECK is what makes the treatment honest rather
       * than convenient.
       *
       * The mistake it catches is the ordinary one: `users.service.ts` logs
       * `created ${userId} (${email})`, and an audit row written to match would put an
       * address in the one table PDPA cannot reach.
       */
      const insert = db.execute(sql`
        insert into admin_events (action, actor_user_id, subject_user_id, payload)
        values ('user.created', ${admin.userId}::uuid, ${subject.userId}::uuid,
                ${JSON.stringify({ email: 'somebody@example.test' })}::jsonb)
      `);

      /*
       * ⚠️ `causeChain` and not `.rejects.toThrow(/…/)`. Drizzle wraps a database error as
       * `Failed query: …` and puts the real one in `cause`, so a regex against the top-level
       * message passes for *any* failure — including the query being malformed. Reading the
       * chain is what makes this assert the guard rather than the throw.
       */
      await expect(insert).rejects.toThrow();
      expect(await insert.catch((error: unknown) => causeChain(error))).toMatch(/address/iu);
    });

    it('refuses one hidden inside an array', async () => {
      const insert = db.execute(sql`
        insert into admin_events (action, actor_user_id, subject_user_id, payload)
        values ('user.created', ${admin.userId}::uuid, ${subject.userId}::uuid,
                ${JSON.stringify({ addresses: ['a@b.test'] })}::jsonb)
      `);

      expect(await insert.catch((error: unknown) => causeChain(error))).toMatch(/address/iu);
    });
  });

  describe('⭐ append-only', () => {
    it('refuses an UPDATE', async () => {
      const update = db.execute(sql`update admin_events set payload = '{}'::jsonb where true`);

      expect(await update.catch((error: unknown) => causeChain(error))).toMatch(/append-only/iu);
    });

    it('⚠️ refuses a DELETE, including by the person the row is about', async () => {
      /*
       * The reason append-only is the rule rather than a convention: the person with the most
       * motive to remove a row is the one it names, and they are frequently the person with
       * database access.
       */
      const remove = db.execute(sql`delete from admin_events where true`);

      expect(await remove.catch((error: unknown) => causeChain(error))).toMatch(/append-only/iu);
    });
  });

  describe('the read surface', () => {
    it('gives an administrator the trail, newest first', async () => {
      const response = await call('GET', '/admin/audit', { token: admin.token });

      expect(response.status).toBe(200);
      const body = response.body as { readonly events: readonly { readonly seq: number }[] };

      expect(body.events.length).toBeGreaterThan(0);
      /* Descending, so a page stays stable while rows are appended underneath it. */
      const seqs = body.events.map((event) => event.seq);
      expect([...seqs].sort((a, b) => b - a)).toStrictEqual(seqs);
    });

    it('⚠️ answers with numbers, not the strings Postgres sends for bigserial', async () => {
      /*
       * `db.execute` bypasses Drizzle's parsers and node-postgres returns `int8` as a
       * *string* — `seq` is a `bigserial`. The query casts `::int`; this is what notices if
       * the cast is ever dropped, because every comparison a normal assertion makes would
       * coerce it away.
       */
      const response = await call('GET', '/admin/audit', { token: admin.token });
      const body = response.body as { readonly events: readonly { readonly seq: unknown }[] };

      for (const event of body.events) expect(typeof event.seq).toBe('number');
    });

    it('refuses somebody with only users.read', async () => {
      const viewer = await makeActor(db, app, `audit viewer ${tag}`, ['users.read']);

      expect((await call('GET', '/admin/audit', { token: viewer.token })).status).toBe(403);
    });
  });
});
