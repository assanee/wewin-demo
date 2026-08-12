import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { and, eq, sql } from '@wewin/db/sql';
import { authorityLimitChanges, authorityLimits, groups, userGroups } from '@wewin/db/schema';

/* The files, not the directory: `src/quotes/authority.ts` shadows `authority/index.ts`. */
import { AuthorityRepository } from '../../../src/quotes/authority/authority.repository';
import { AuthorityService } from '../../../src/quotes/authority/authority.service';
import { userScope } from '../../../src/rbac';
import { client, makeActor, type Actor, type Json } from '../../payments/support/payments-app';
import { messagesOf, sqlStateOf } from '../../orders/scope/support/fixtures';
import { authorityEnv, bootAuthorityApp, type AuthorityApp } from './support/authority-app';
import { purgeAuthorityLimits } from '../support/authority-reset';

/**
 * The ceiling table as a thing an administrator can actually change — task 13.
 *
 * `authority.pg.test.ts` next door owns the *measurement*: what a quote concedes and whether it
 * may be sent. This suite owns the two house rules that stand behind the screen that fills the
 * table in, and every one of them lives between the layers:
 *
 *   - **a ceiling is withdrawn, never deleted.** `authority_limits_block_delete` is a trigger,
 *     so no service-level test can observe it and no unit test can reach it;
 *   - **every change is recorded, in the same transaction, as its last statement.** The
 *     append-only trigger stops a history row being *edited*; nothing in the database stops one
 *     being *skipped*, so the only way to know it was written is to make the write over HTTP and
 *     then read the chain out of Postgres;
 *   - **a withdrawn ceiling grants nothing.** That is one predicate in `ceiling()` and it is the
 *     single most load-bearing line of the change — with it missing, revoking authority does
 *     nothing at all and the failure is silent and fail-*open*.
 *
 * ── Why the ceilings are put back to nothing at the end ──────────────────────────
 *
 * "Fail closed" is a claim about a table with **no rows in it**, asserted by
 * `packages/db/tests/quote.test.ts` and by the opening tests of `authority.pg.test.ts`. This
 * suite fills the table, so it has to leave it as it found it — see `purgeAuthorityLimits`,
 * which needs the sanctioned trigger bypass precisely because the guard under test forbids the
 * ordinary way of doing it.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/**
 * ⭐ How many writers race for one ceiling in the contiguity test — a measured number.
 *
 * See the block comment on that test. Ten was not enough: a reviewer ran the wrong-clock
 * mutation 12 times at ten writers and saw 10 red, 2 green. The escape is real and it is
 * roughly one run in six, so any sample small enough to miss it will report 100 %.
 *
 * Measured at this size, against `changedAt: sql\`now()\`` in `insertLimitChange`. The
 * measurement and its sample size are in the fix-round section of the report; re-measure rather
 * than re-argue if this ever goes quiet.
 */
const RACING_WRITERS = 40;

interface Snapshot {
  readonly maxConcessionThbMinor: string;
  readonly noteTh: string | null;
  readonly isRevoked: boolean;
}

interface ChangeWire {
  readonly id: string;
  readonly groupId: string;
  readonly groupCode: string;
  readonly dimension: string;
  readonly changedByUserId: string;
  readonly changedAt: string;
  readonly before: Snapshot | null;
  readonly after: Snapshot;
}

interface LimitWire {
  readonly groupId: string;
  readonly groupCode: string;
  readonly dimension: string;
  readonly maxConcessionThbMinor: string;
  readonly grantedByUserId: string;
  readonly noteTh: string | null;
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
}

describeWithPg('authority limits — the screen that fills the table in', () => {
  let pool: Pool;
  let db: Database;
  let app: AuthorityApp;
  let call: ReturnType<typeof client>;
  let service: AuthorityService;

  /** Group administration — the only role that may write a ceiling. */
  let owner: Actor;
  /** Holds a ceiling in the tests that are about having one, and never `groups.write`. */
  let sales: Actor;
  let salesGroupId: string;

  const body = <T>(response: Json): T => response.body as T;

  /**
   * The error a statement threw, or `undefined` if it did not throw.
   *
   * ⚠️ Not `rejects.toThrow(/…/)`: drizzle wraps the driver error in one of its own whose
   * message is the SQL it tried to run, so a regex on the outer message matches the query text
   * and passes for a statement that failed for an entirely different reason. `sqlStateOf` and
   * `messagesOf` walk the cause chain — same helpers, same reasoning, as
   * `orders/scope/scoped-order.pg.test.ts`.
   */
  const refusal = async (statement: Promise<unknown>): Promise<unknown> =>
    statement.then(
      () => undefined,
      (caught: unknown) => caught,
    );

  const groupIdOf = async (userId: string): Promise<string> => {
    const [row] = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId));
    if (row === undefined) throw new Error('fixture actor has no group');
    return row.groupId;
  };

  const grant = async (
    groupId: string,
    dimension: 'margin' | 'cashflow',
    maxConcessionThbMinor: string,
    noteTh?: string,
  ): Promise<Json> =>
    call('PUT', '/quotes/authority/limits', {
      token: owner.token,
      body: { groupId, dimension, maxConcessionThbMinor, ...(noteTh === undefined ? {} : { noteTh }) },
    });

  const withdraw = async (groupId: string, dimension: 'margin' | 'cashflow'): Promise<Json> =>
    call('DELETE', `/quotes/authority/limits/${groupId}/${dimension}`, { token: owner.token });

  const historyOf = async (
    groupId: string,
    dimension: 'margin' | 'cashflow',
  ): Promise<readonly ChangeWire[]> => {
    const read = await call('GET', `/quotes/authority/limits/${groupId}/${dimension}/changes`, {
      token: owner.token,
    });
    expect(read.status).toBe(200);
    return body<{ changes: readonly ChangeWire[] }>(read).changes;
  };

  const limitOf = async (
    groupId: string,
    dimension: 'margin' | 'cashflow',
  ): Promise<LimitWire | undefined> => {
    const listed = await call('GET', '/quotes/authority/limits', { token: owner.token });
    expect(listed.status).toBe(200);
    return body<{ limits: readonly LimitWire[] }>(listed).limits.find(
      (row) => row.groupId === groupId && row.dimension === dimension,
    );
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    /*
     * ⚠️ The pool is raised to the fan-out on purpose — see `RACING_WRITERS`. At the default of
     * ten, forty concurrent requests are ten concurrent *transactions* and thirty in a queue,
     * and the queue is what let the wrong-clock mutation escape.
     */
    app = await bootAuthorityApp(
      authorityEnv(url ?? '', { DATABASE_POOL_MAX: String(RACING_WRITERS) }),
    );
    call = client(app.baseUrl);
    service = app.app.get(AuthorityService);

    owner = await makeActor(db, app, `limits owner ${tag}`, [
      'groups.read',
      'groups.write',
      'quotes.read',
    ]);
    sales = await makeActor(db, app, `limits sales ${tag}`, ['quotes.read', 'quotes.write']);
    salesGroupId = await groupIdOf(sales.userId);
  }, 60_000);

  afterAll(async () => {
    await purgeAuthorityLimits(db, salesGroupId);
    await purgeAuthorityLimits(db, await groupIdOf(owner.userId));
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * The history, which is the thing that did not exist
   * ---------------------------------------------------------------- */

  describe('every change is recorded, with a before and an after', () => {
    /**
     * The first grant, and the two things that make it readable a year later.
     *
     * `before: null` on a creation and on nothing else — that is what lets a reader tell "this
     * role was given ฿5,000" from "this role was moved to ฿5,000" without guessing. And
     * `changedByUserId` is the *scope*, never anything the body could carry: a history whose
     * actor is a field is a record one request can lie about.
     */
    it('writes one entry with a null before when a ceiling is first granted', async () => {
      const granted = await grant(salesGroupId, 'margin', '500000', 'เพดานเริ่มต้น');
      expect(granted.status).toBe(200);

      const chain = await historyOf(salesGroupId, 'margin');
      expect(chain).toHaveLength(1);
      expect(chain[0]?.before).toBeNull();
      expect(chain[0]?.after).toEqual({
        maxConcessionThbMinor: '500000',
        noteTh: 'เพดานเริ่มต้น',
        isRevoked: false,
      });
      expect(chain[0]?.changedByUserId).toBe(owner.userId);
      expect(chain[0]?.dimension).toBe('margin');
    });

    /**
     * ⭐ The property the whole table exists for: entry N's `before` **is** entry N−1's `after`.
     *
     * A chain that merely records snapshots proves that somebody wrote a number down. A chain
     * that is contiguous proves that nothing happened in between that nobody recorded — which
     * is the difference between a log and evidence.
     */
    it('chains the next change onto the last, before to after', async () => {
      await grant(salesGroupId, 'margin', '1200000', 'ขยายเพดานสำหรับดีลใหญ่');

      const chain = await historyOf(salesGroupId, 'margin');
      expect(chain).toHaveLength(2);
      expect(chain[1]?.before).toEqual(chain[0]?.after);
      expect(chain[1]?.after).toEqual({
        maxConcessionThbMinor: '1200000',
        noteTh: 'ขยายเพดานสำหรับดีลใหญ่',
        isRevoked: false,
      });
    });

    /**
     * The history is append-only at the database, so a mistake cannot be tidied away.
     *
     * Both verbs, because the trigger is `BEFORE UPDATE OR DELETE` and a guard with two arms
     * needs two assertions — dropping either word from the trigger turns exactly one of these
     * red.
     */
    it('refuses to let a recorded change be edited or removed', async () => {
      const [row] = await db
        .select({ id: authorityLimitChanges.id })
        .from(authorityLimitChanges)
        .where(eq(authorityLimitChanges.groupId, salesGroupId))
        .limit(1);
      expect(row).toBeDefined();

      const edited = await refusal(
        db.execute(
          sql`update authority_limit_changes set after = '{}'::jsonb where id = ${row?.id}::uuid`,
        ),
      );
      expect(sqlStateOf(edited), `expected restrict_violation, got: ${String(edited)}`).toBe('23001');
      expect(messagesOf(edited)).toContain('append-only');

      const dropped = await refusal(
        db.execute(sql`delete from authority_limit_changes where id = ${row?.id}::uuid`),
      );
      expect(sqlStateOf(dropped), `expected restrict_violation, got: ${String(dropped)}`).toBe('23001');
      expect(messagesOf(dropped)).toContain('append-only');
    });
  });

  /* ---------------------------------------------------------------- *
   * Withdrawal — a flag, and what it costs the person who held it
   * ---------------------------------------------------------------- */

  describe('a ceiling is withdrawn, never deleted', () => {
    it('keeps the row, stamps who withdrew it, and records the change', async () => {
      const before = await limitOf(salesGroupId, 'margin');
      expect(before?.revokedAt).toBeNull();

      const removed = await withdraw(salesGroupId, 'margin');
      expect(removed.status).toBe(200);

      /* The row is still there — that is the point. The granter's name survives the revocation. */
      const after = await limitOf(salesGroupId, 'margin');
      expect(after, 'the row was deleted, not withdrawn').toBeDefined();
      expect(after?.revokedAt).not.toBeNull();
      expect(after?.revokedByUserId).toBe(owner.userId);
      expect(after?.maxConcessionThbMinor).toBe('1200000');
      expect(after?.grantedByUserId).toBe(owner.userId);

      const chain = await historyOf(salesGroupId, 'margin');
      expect(chain).toHaveLength(3);
      expect(chain[2]?.before?.isRevoked).toBe(false);
      expect(chain[2]?.after.isRevoked).toBe(true);
      expect(chain[2]?.before).toEqual(chain[1]?.after);
    });

    /**
     * ⭐⭐ THE ONE THAT MATTERS: a withdrawn ceiling grants nothing.
     *
     * `ceiling()` is the only read of this table at decision time — `judge()` and `decide()`
     * both reach it — and `undefined` is what makes fail-closed a fact. Without
     * `revoked_at IS NULL` in that WHERE, revocation is a flag nobody consults: the screen says
     * withdrawn, the salesperson keeps conceding, and nothing anywhere reports a problem.
     *
     * ⚠️ `undefined`, asserted explicitly, and not merely "falsy". A revoked row coerced to a
     * ceiling of `0` would also stop the concession — and would be a *different sentence*, per
     * `authority_limits`' own schema note: `0` is "may record a concession, may approve none of
     * its own", absent is "has no authority at all". Both refuse; only one is true.
     */
    it('stops granting authority the moment it is withdrawn', async () => {
      const scope = userScope({
        userId: sales.userId,
        sessionId: randomUUID(),
        permissions: new Set(['quotes.read', 'quotes.write']),
        groupIds: [salesGroupId],
      });

      expect(await service.ceilingFor(scope, 'margin')).toBeUndefined();

      /* And it is genuinely the flag doing it: put the ceiling back and the authority returns. */
      await grant(salesGroupId, 'margin', '1200000', 'คืนเพดานเดิม');
      expect(await service.ceilingFor(scope, 'margin')).toBe(1_200_000n);

      await withdraw(salesGroupId, 'margin');
      expect(await service.ceilingFor(scope, 'margin')).toBeUndefined();
    });

    /**
     * Reinstating is `PUT`, and it is the same write path — which is why it has the same
     * history discipline rather than a second one that would have to be proved separately.
     */
    it('comes back through the ordinary grant, and says so in the chain', async () => {
      const chainBefore = await historyOf(salesGroupId, 'margin');

      const reinstated = await grant(salesGroupId, 'margin', '900000', 'คืนเพดาน');
      expect(reinstated.status).toBe(200);

      const row = await limitOf(salesGroupId, 'margin');
      expect(row?.revokedAt).toBeNull();
      expect(row?.revokedByUserId).toBeNull();
      expect(row?.maxConcessionThbMinor).toBe('900000');

      const chain = await historyOf(salesGroupId, 'margin');
      expect(chain).toHaveLength(chainBefore.length + 1);
      expect(chain.at(-1)?.before?.isRevoked).toBe(true);
      expect(chain.at(-1)?.after.isRevoked).toBe(false);
    });

    /** Withdrawing twice is a 404, not a silent success that restamps the first withdrawal. */
    it('refuses a second withdrawal of the same ceiling', async () => {
      await withdraw(salesGroupId, 'margin');
      const [stamped] = await db
        .select({ revokedAt: authorityLimits.revokedAt })
        .from(authorityLimits)
        .where(
          and(
            eq(authorityLimits.groupId, salesGroupId),
            eq(authorityLimits.dimension, 'margin'),
          ),
        );

      const again = await withdraw(salesGroupId, 'margin');
      expect(again.status).toBe(404);

      const [unchanged] = await db
        .select({ revokedAt: authorityLimits.revokedAt })
        .from(authorityLimits)
        .where(
          and(
            eq(authorityLimits.groupId, salesGroupId),
            eq(authorityLimits.dimension, 'margin'),
          ),
        );
      expect(unchanged?.revokedAt?.toISOString()).toBe(stamped?.revokedAt?.toISOString());
    });

    /**
     * ⭐ The database-side half of the double-withdrawal guard, driven with no service in front.
     *
     * ⚠️ **This test exists because the two guards were hiding each other.** `removeLimit`
     * checks the locked pre-image, and `revokeLimit` carries `revoked_at IS NULL` in its own
     * WHERE. Over HTTP either one alone produces the same answer, so a review deleted each in
     * turn and the whole suite stayed green — two documented guards, neither of them tested.
     *
     * The other arm is now distinguishable at the service (`removeLimit` reports a zero-row
     * UPDATE under the lock as a broken invariant, not a 404 — so deleting the pre-image check
     * turns the HTTP test below from 404 into 500). This arm is the WHERE clause itself, and it
     * can only be reached by calling the repository directly: the point of it is what still
     * holds if a future path arrives here *without* the group lock, and no service-level test
     * can construct that. Restamping is the failure it prevents — a second withdrawal writing a
     * new name and time over the record of who actually took the authority away.
     */
    it('refuses a second withdrawal at the repository, without restamping the first', async () => {
      const repository = app.app.get(AuthorityRepository);

      await grant(salesGroupId, 'margin', '750000', 'สำหรับทดสอบ WHERE');

      const first = await repository.transaction(async (tx) =>
        repository.revokeLimit(tx, {
          groupId: salesGroupId,
          dimension: 'margin',
          revokedByUserId: owner.userId,
        }),
      );
      expect(first).toBe(true);

      const stamped = await limitOf(salesGroupId, 'margin');
      expect(stamped?.revokedAt).not.toBeNull();

      /* The second call names a *different* actor, so a restamp would be visible by name. */
      const second = await repository.transaction(async (tx) =>
        repository.revokeLimit(tx, {
          groupId: salesGroupId,
          dimension: 'margin',
          revokedByUserId: sales.userId,
        }),
      );
      expect(second, 'a withdrawn ceiling was withdrawn a second time').toBe(false);

      const unchanged = await limitOf(salesGroupId, 'margin');
      expect(unchanged?.revokedAt).toBe(stamped?.revokedAt);
      expect(unchanged?.revokedByUserId).toBe(owner.userId);
    });

    /**
     * The database refuses the delete itself, so this is not a convention the application is
     * trusted to keep. Reachable from `psql`, from a migration, and from the next service —
     * which is exactly why it cannot be a service-level assertion.
     */
    it('refuses a direct DELETE at the database', async () => {
      const refused = await refusal(
        db.execute(
          sql`delete from authority_limits where group_id = ${salesGroupId}::uuid and dimension = 'margin'`,
        ),
      );

      /* The SQLSTATE and the sentence: a trigger that refused *everything* would satisfy the
       * first on its own, and the group-delete test below is what proves it does not. */
      expect(sqlStateOf(refused), `expected restrict_violation, got: ${String(refused)}`).toBe('23001');
      expect(messagesOf(refused)).toContain('revoke it instead of deleting it');
    });

    /**
     * ⚠️ …and yet deleting the *group* still works.
     *
     * `authority_limits.group_id` is `ON DELETE CASCADE` and 0015 defends that as the
     * fail-closed direction: no role, no authority. A block-delete trigger without the
     * parent-gone branch would have made every group that ever held a ceiling undeletable —
     * a regression in group administration, produced by a guard on a different table.
     */
    it('still lets a group be deleted, cascade and all', async () => {
      const [doomed] = await db
        .insert(groups)
        .values({ code: `limits_doomed_${tag}`, nameTh: 'กลุ่มที่จะถูกลบ' })
        .returning({ id: groups.id });
      expect(doomed).toBeDefined();

      const granted = await grant(doomed?.id ?? '', 'cashflow', '250000');
      expect(granted.status).toBe(200);

      await db.delete(groups).where(eq(groups.id, doomed?.id ?? ''));

      const survivors = await db
        .select({ groupId: authorityLimits.groupId })
        .from(authorityLimits)
        .where(eq(authorityLimits.groupId, doomed?.id ?? ''));
      expect(survivors).toEqual([]);

      /* The history outlives the group — it has no foreign key, on purpose. */
      const orphaned = await db
        .select({ id: authorityLimitChanges.id, groupCode: authorityLimitChanges.groupCode })
        .from(authorityLimitChanges)
        .where(eq(authorityLimitChanges.groupId, doomed?.id ?? ''));
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]?.groupCode).toBe(`limits_doomed_${tag}`);
    });
  });

  /* ---------------------------------------------------------------- *
   * What the list says, and who may say it
   * ---------------------------------------------------------------- */

  describe('the list a dashboard renders', () => {
    /**
     * ⭐ `isFailClosed` counts live ceilings, not rows.
     *
     * It was `rows.length === 0`, which was the same question while revocation was a `DELETE`.
     * A company that withdrew every limit would otherwise be told the feature was on, on the
     * day it had been switched off — and this flag exists precisely so the screen can say
     * "nobody may concede anything" out loud.
     */
    it('reports fail-closed when every ceiling has been withdrawn, not only when there are none', async () => {
      const listed = await call('GET', '/quotes/authority/limits', { token: owner.token });
      const wire = body<{ limits: readonly LimitWire[]; isFailClosed: boolean }>(listed);

      expect(wire.limits.length, 'this test needs a row to be meaningful').toBeGreaterThan(0);
      expect(wire.limits.every((row) => row.revokedAt !== null)).toBe(true);
      expect(wire.isFailClosed).toBe(true);

      await grant(salesGroupId, 'cashflow', '0', 'ศูนย์ ไม่ใช่ไม่มีแถว');
      const after = body<{ isFailClosed: boolean }>(
        await call('GET', '/quotes/authority/limits', { token: owner.token }),
      );
      /* ⚠️ A live ceiling of ฿0.00 is authority. It is not the absence of a row. */
      expect(after.isFailClosed).toBe(false);
    });

    /**
     * ⭐ The role picker's source, and the permission dead-end it exists to close.
     *
     * The only list of groups was `GET /admin/groups`, gated on **`users.read`** — the whole
     * staff directory. So `groups.write`, the permission that owns this table, could not be
     * delegated without a PDPA-relevant disclosure, and a reviewer holding `groups.read` +
     * `groups.write` could not reach the screen at all.
     *
     * ⚠️ Two assertions, and the second is the point of the first: the roster is readable with
     * `groups.read` **and** carries nothing but what names a role. A future hand that added
     * `permissions` or `memberCount` here would be re-opening the disclosure under a different
     * route, so the shape is pinned exactly rather than by presence.
     */
    it('serves the role picker under groups.read, and nothing about any person', async () => {
      const listed = await call('GET', '/quotes/authority/groups', { token: owner.token });
      expect(listed.status).toBe(200);

      const wire = body<{ groups: readonly Record<string, unknown>[] }>(listed);
      const ours = wire.groups.find((row) => row['id'] === salesGroupId);
      expect(ours, 'the sales group is missing from the roster').toBeDefined();
      expect(Object.keys(ours ?? {}).sort()).toEqual(['code', 'id', 'nameTh']);

      /* And it is `groups.read` that opens it — a salesperson holding neither is refused. */
      const bySales = await call('GET', '/quotes/authority/groups', { token: sales.token });
      expect(bySales.status).toBe(403);
    });

    it('refuses an unknown group and an unknown dimension as not-found, never a 500', async () => {
      const unknownGroup = await grant(randomUUID(), 'margin', '100');
      expect(unknownGroup.status).toBe(404);

      const unknownDimension = await call(
        'DELETE',
        `/quotes/authority/limits/${salesGroupId}/lead_time`,
        { token: owner.token },
      );
      expect(unknownDimension.status).toBe(404);
    });

    /**
     * The permission split, which is the reason this table is not on the quote screen.
     *
     * A salesperson who could write it would raise their own ceiling and then need nobody's
     * approval for anything — so writing is `groups.write` and reading the history is
     * `groups.read`, and `sales` holds neither.
     */
    it('keeps a salesperson out of the table that decides what they may concede', async () => {
      const written = await grant(salesGroupId, 'margin', '99999999');
      expect(written.status).toBe(200);

      const bySales = await call('PUT', '/quotes/authority/limits', {
        token: sales.token,
        body: { groupId: salesGroupId, dimension: 'margin', maxConcessionThbMinor: '99999999' },
      });
      expect(bySales.status).toBe(403);

      const readBySales = await call(
        'GET',
        `/quotes/authority/limits/${salesGroupId}/margin/changes`,
        { token: sales.token },
      );
      expect(readBySales.status).toBe(403);
    });
  });

  /* ---------------------------------------------------------------- *
   * The clock
   * ---------------------------------------------------------------- */

  /**
   * ⭐ The history reads in commit order, and this is the test that can tell.
   *
   * `now()` is `transaction_timestamp()`, fixed at BEGIN. Two concurrent writes to one ceiling
   * both open before either reaches `lockGroup`, so the one that blocks on the lock can hold
   * the *earlier* stamp while committing *second*. Sorted by `changed_at`, the chain then reads
   * in an order that never happened and entry N's `before` stops equalling entry N−1's `after`.
   * `clock_timestamp()` reads the wall clock at the moment the INSERT executes — after the lock
   * has already forced any earlier writer to commit.
   *
   * ── ⚠️ THE FAN-OUT IS A MEASUREMENT, NOT A GUESS, AND IT HAS BEEN WRONG ONCE ────
   *
   * This ran ten concurrent writers and was reported as catching the wrong-clock mutation on
   * 6 of 6 runs. A reviewer ran the same mutation **12 times and saw 10 red, 2 green — 83 %**.
   * Both measurements were honest; six runs was simply too small a sample to see a one-in-six
   * escape, and a guard that leaks 17 % of the time on the invariant this repository has broken
   * three times is not a guard.
   *
   * It is now `RACING_WRITERS` below, and the number was chosen by measuring rather than by
   * argument: the wrong-clock mutation was run against this test repeatedly at each size until
   * a size reddened every run of a sample large enough to have caught the 83 % case many times
   * over. The sample size and the result are recorded on the constant. If this ever goes quiet
   * again, **raise the number and re-measure — do not delete the test.**
   *
   * ⚠️ Two things this test does NOT depend on, so that a future reader does not mistake what
   * it is pinning:
   *
   *   - **Not the column default.** Since migration 0039 the default is `clock_timestamp()`
   *     too, so deleting the explicit value from `insertLimitChange` is no longer a defect and
   *     no longer reddens anything. That is the net doing its job. The mutation that must stay
   *     red is a writer that names the *wrong* clock — `sql\`now()\`` — which is a real defect
   *     whatever the default says.
   *   - **Not a particular winner.** Which of N concurrent writes lands last is genuinely
   *     undefined; pinning it would be a test of the scheduler. Contiguity is the property.
   */
  describe('the history reads in the order the changes committed', () => {
    it('stays contiguous under concurrent writes to one ceiling', async () => {
      const [racing] = await db
        .insert(groups)
        .values({ code: `limits_race_${tag}`, nameTh: 'กลุ่มแข่งกัน' })
        .returning({ id: groups.id });
      const groupId = racing?.id ?? '';

      await grant(groupId, 'margin', '1');

      await Promise.all(
        Array.from({ length: RACING_WRITERS }, (_unused, index) =>
          grant(groupId, 'margin', String((index + 2) * 1000)),
        ),
      );

      const chain = await historyOf(groupId, 'margin');
      expect(chain).toHaveLength(RACING_WRITERS + 1);

      /*
       * Contiguity: read in `changed_at` order, each entry's `before` is the previous entry's
       * `after` — the property that says nothing happened in between that nobody recorded.
       */
      for (let index = 1; index < chain.length; index += 1) {
        expect(chain[index]?.before, `entry ${index} does not follow entry ${index - 1}`).toEqual(
          chain[index - 1]?.after,
        );
      }

      /* And the last entry describes the row as it now stands. */
      const [live] = await db
        .select({ max: authorityLimits.maxConcessionThbMinor })
        .from(authorityLimits)
        .where(
          and(eq(authorityLimits.groupId, groupId), eq(authorityLimits.dimension, 'margin')),
        );
      expect(chain.at(-1)?.after.maxConcessionThbMinor).toBe(live?.max?.toString());

      await purgeAuthorityLimits(db, groupId);
      await db.delete(groups).where(eq(groups.id, groupId));
    }, 120_000);
  });
});
