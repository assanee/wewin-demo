import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccessTokenService } from '../../../src/auth/session/access-token';
import { hashSecret } from '../../../src/auth/session/secrets';
import { parseSessionConfig, type SessionConfig } from '../../../src/auth/session/session.config';
import { SessionRepository } from '../../../src/auth/session/session.repository';
import { SessionService, type IssuedSession, type RefreshResult } from '../../../src/auth/session/session.service';
import { parseEnv } from '../../../src/config/env';
import { createPool } from '../../../src/database/database.module';

/**
 * ⓒ Plan 6(c), against a real Postgres.
 *
 * The failure this suite exists to prevent is not an attack. A dashboard opens several
 * panels, every one of them finds the access token expired in the same millisecond, every
 * one refreshes with the same token, and a reuse-detector that cannot tell a race from a
 * theft signs the user out in the middle of their work.
 *
 * Proving that in theory is easy and worthless. Three things are done here to make the
 * proof real:
 *
 *   1. **The contention is observed, not assumed.** `Promise.all` over eight refreshes
 *      does not prove eight backends were ever inside the statement at once — a pool that
 *      serialised them would produce the same outcomes, because the grace window is
 *      fifteen seconds wide and a serialised replay is still inside it. So one test opens
 *      a transaction, claims the token, holds the row lock, and then watches
 *      `pg_stat_activity` until the other seven backends are genuinely *blocked on that
 *      lock* before it commits. Nothing about that is timing-dependent.
 *   2. **The detector is proven still to work**, in real elapsed time, with a one-second
 *      grace window: a replay inside the window is `graced` and the session lives, the same
 *      replay after the window is `reused` and the session dies. A fix that is really
 *      "never detect reuse" fails the second half.
 *   3. **The counterfactual is written down.** With the window closed, the same second use
 *      revokes the session — which is precisely what the eight parallel callers would get
 *      without fix ⓒ, and precisely the user being signed out mid-task.
 *
 * Skipped, not failed, with no database configured. Nothing here can be faked, which is
 * the point.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** Marks every row this file creates, so teardown can remove exactly them. */
const MARKER = 'auth-session-rotation.pg.test';

const PARALLEL_REFRESHES = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const configWith = (overrides: Record<string, string> = {}): SessionConfig =>
  parseSessionConfig({
    // Generated, never a literal: a key checked into a test fixture is a key in the
    // repository, and this suite does not need a stable one.
    AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
    ...overrides,
  });

describeWithPg('refresh rotation under real concurrency', () => {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url ?? 'postgres://unused/unused',
    // Room for the eight racers, the transaction holding the lock and the observer that
    // watches them block. A smaller pool would serialise the very thing under test.
    DATABASE_POOL_MAX: '12',
  });

  let pool: pg.Pool;
  let repository: SessionRepository;

  beforeAll(() => {
    /*
     * Nest's logger writes to stdout, and this suite deliberately provokes the reuse
     * warning a dozen times — which would bury the run's real output. Silencing the
     * transport does not silence the call: `Logger.prototype.warn` still runs, so the test
     * that inspects what is written still inspects the real message.
     */
    Logger.overrideLogger(false);

    pool = createPool(env);
    repository = new SessionRepository(pool);
  });

  afterAll(async () => {
    // Sessions and tokens hang off the user by ON DELETE CASCADE, so one delete is enough.
    await pool.query('delete from users where display_name = $1', [MARKER]);
    await pool.end();
  });

  const serviceWith = (config: SessionConfig): SessionService =>
    new SessionService(repository, new AccessTokenService(config), config);

  async function newUser(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      'insert into users (display_name) values ($1) returning id',
      [MARKER],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('could not create a user for the test');
    return row.id;
  }

  async function sessionRow(sessionId: string): Promise<{ revoked_at: Date | null; revoked_reason: string | null }> {
    const result = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      'select revoked_at, revoked_reason from sessions where id = $1',
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`session ${sessionId} disappeared`);
    return row;
  }

  async function tokenRow(
    tokenHash: string,
  ): Promise<{ id: string; parent_id: string | null; consumed_at: Date | null; revoked_at: Date | null } | undefined> {
    const result = await pool.query<{
      id: string;
      parent_id: string | null;
      consumed_at: Date | null;
      revoked_at: Date | null;
    }>('select id, parent_id, consumed_at, revoked_at from refresh_tokens where token_hash = $1', [tokenHash]);
    return result.rows[0];
  }

  describe('what a sign-in writes', () => {
    it('stores the digest of the refresh token and never the token', async () => {
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser(), userAgent: 'Vitest', ip: '203.0.113.7' });

      const raw = await pool.query('select 1 from refresh_tokens where token_hash = $1', [issued.refreshToken]);
      expect(raw.rowCount).toBe(0);

      const hashed = await tokenRow(hashSecret(issued.refreshToken));
      expect(hashed).toBeDefined();
      expect(hashed?.consumed_at).toBeNull();
      expect(hashed?.parent_id).toBeNull();
    });

    it('clamps a refresh token to its session even when configured longer', async () => {
      // `refresh_tokens_within_session` *rejects* an over-long token rather than clamping
      // it, so a session TTL shorter than the refresh TTL would be a failed sign-in if the
      // repository did not take the minimum itself.
      const service = serviceWith(
        configWith({ AUTH_REFRESH_TOKEN_TTL_SECONDS: '3600', AUTH_SESSION_TTL_SECONDS: '3600' }),
      );
      const issued = await service.start({ userId: await newUser() });

      expect(issued.refreshTokenExpiresAt.getTime()).toBeLessThanOrEqual(issued.sessionExpiresAt.getTime());
    });

    it('survives an IP header that is not an IP', async () => {
      // `sessions.ip` is `inet`, and the value comes from a proxy header anybody can write.
      const service = serviceWith(configWith());
      await expect(
        service.start({ userId: await newUser(), ip: 'not-an-address; drop table users' }),
      ).resolves.toBeDefined();
    });
  });

  /**
   * The choreography that turns "we called `Promise.all`" into a proof.
   *
   * A transaction claims the token and does *not* commit, so the row lock is held. Every
   * other rotation of that token must then block — which is the state a real dashboard is
   * in for the microseconds between its panels arriving, held open here long enough to be
   * observed. `waitUntilBlocked` refuses to continue until Postgres itself reports that
   * many backends queued behind the lock, so a run where the contention did not happen
   * fails loudly instead of passing for the wrong reason.
   *
   * The holder is raw SQL because the service deliberately offers no way to keep a
   * transaction open — one statement, no `begin`, is the fix. The racers all go through
   * `SessionService.refresh`, which is the code under test.
   */
  async function raceOnHeldLock(
    service: SessionService,
    refreshToken: string,
    graceSeconds: number,
  ): Promise<RefreshResult[]> {
    const observer = await pool.connect();
    const holder = await pool.connect();

    try {
      await holder.query('begin');
      const winner = await holder.query<{ outcome: string }>(
        `select outcome from rotate_refresh_token($1::char(64), $2::char(64),
                                                  make_interval(secs => $3::double precision),
                                                  make_interval(secs => $4::double precision))`,
        [hashSecret(refreshToken), hashSecret(randomBytes(32).toString('base64url')), 3600, graceSeconds],
      );
      expect(winner.rows[0]?.outcome).toBe('rotated');

      const racers = Array.from({ length: PARALLEL_REFRESHES - 1 }, () => service.refresh(refreshToken));

      await waitUntilBlocked(observer, PARALLEL_REFRESHES - 1);
      await holder.query('commit');

      return await Promise.all(racers);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      observer.release();
    }
  }

  describe('the race', () => {
    it('lets seven backends that are provably blocked on the row all keep working', async () => {
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser() });
      const presentedHash = hashSecret(issued.refreshToken);

      const results = await raceOnHeldLock(service, issued.refreshToken, 15);

      {
        /*
         * Not one of them was told it had stolen anything. That — and not the label — is
         * fix ⓒ.
         *
         * The label is asserted loosely on purpose, and the reason is worth knowing before
         * anybody tightens it. Under genuine lock contention these callers come back
         * `rotated`, not `graced`. `rotate_refresh_token()` distinguishes the two with
         * `RETURNING old.consumed_at`, and PostgreSQL gives `old` from the *statement's own
         * snapshot* — which for a backend that blocked on the row lock predates the winner's
         * commit, so `old.consumed_at` is NULL and the racer looks like a first claimant.
         * The WHERE clause is a different matter: it *is* re-evaluated against the updated
         * row (EvalPlanQual), which is exactly what the counterfactual below demonstrates by
         * closing the window and watching the same seven callers be accused instead.
         *
         * So `graced` is a lower bound on races, not a count of them: it appears when the
         * second caller's snapshot already contained the first caller's commit, and
         * disappears in the tightest case. Nothing here depends on which word came back,
         * and nothing downstream should either.
         */
        const sessions = new Set<string>();
        const successors = new Set<string>();
        for (const result of results) {
          expect(['rotated', 'graced']).toContain(result.outcome);
          if (result.outcome !== 'rotated' && result.outcome !== 'graced') continue;
          sessions.add(result.session.sessionId);
          successors.add(result.session.refreshToken);
        }

        // One session, and a distinct, usable successor for every caller.
        expect(sessions).toStrictEqual(new Set([issued.sessionId]));
        expect(successors.size).toBe(PARALLEL_REFRESHES - 1);

        const survived = await sessionRow(issued.sessionId);
        expect(survived.revoked_at).toBeNull();
        expect(survived.revoked_reason).toBeNull();

        // Write-once survived eight concurrent updates of the same row: the token was
        // spent exactly once, whatever each caller was told about it.
        const spent = await tokenRow(presentedHash);
        expect(spent?.consumed_at).not.toBeNull();
      }
    });

    /**
     * The counterfactual, under the same proven contention.
     *
     * Identical choreography, identical assertions to write — one parameter different. This
     * is the run that fails if the grace window is removed from `rotate_refresh_token()`'s
     * WHERE clause, and it is also the exact failure plan 6(c) describes: seven of eight
     * parallel panels are told they replayed a stolen token, and the session they were all
     * working in is destroyed underneath them.
     *
     * It is deterministic, which the naive version of this test is not. `now()` is the
     * *transaction start* time, so with a closed window whether a racer is graced or accused
     * depends on whether its transaction began before or after the winner's. Here the holder
     * demonstrably began first, so every racer's `now()` is later than the `consumed_at` it
     * is being compared against, and the answer cannot go the other way.
     */
    it('counterfactual: with the window closed, the same seven are accused of theft', async () => {
      const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '0' }));
      const issued = await service.start({ userId: await newUser() });

      const results = await raceOnHeldLock(service, issued.refreshToken, 0);

      expect(results.map((result) => result.outcome)).toStrictEqual(
        Array.from({ length: PARALLEL_REFRESHES - 1 }, () => 'reused'),
      );

      const destroyed = await sessionRow(issued.sessionId);
      expect(destroyed.revoked_at).not.toBeNull();
      expect(destroyed.revoked_reason).toBe('refresh_reuse');
    });

    it('does the same when the parallelism is left to the runtime', async () => {
      // The choreographed test proves contention; this one proves the ordinary path is the
      // same code with nothing arranged. Only the property that matters is asserted: one
      // token was spent, everybody was served, nobody was accused. The split between
      // `rotated` and `graced` is genuinely nondeterministic here — see the long note above.
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser() });

      await warmPool(pool, PARALLEL_REFRESHES);

      const results = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => service.refresh(issued.refreshToken)),
      );

      const outcomes = results.map((result) => result.outcome);
      expect(outcomes.filter((outcome) => outcome === 'rotated' || outcome === 'graced')).toHaveLength(
        PARALLEL_REFRESHES,
      );
      expect(outcomes.filter((outcome) => outcome === 'reused' || outcome === 'rejected')).toHaveLength(0);

      const survived = await sessionRow(issued.sessionId);
      expect(survived.revoked_at).toBeNull();
    });

    it('gives every racer an access token that verifies for the same session', async () => {
      const config = configWith();
      const service = serviceWith(config);
      const accessTokens = new AccessTokenService(config);
      const issued = await service.start({ userId: await newUser() });

      await warmPool(pool, PARALLEL_REFRESHES);
      const results = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => service.refresh(issued.refreshToken)),
      );

      for (const result of results) {
        expect(['rotated', 'graced']).toContain(result.outcome);
        if (result.outcome !== 'rotated' && result.outcome !== 'graced') continue;

        const verified = accessTokens.verify(result.session.accessToken);
        expect(verified.ok).toBe(true);
        if (!verified.ok) continue;
        expect(verified.claims.sid).toBe(issued.sessionId);
        expect(verified.claims.sub).toBe(issued.userId);
      }
    });

    it('records the race in the chain: every successor points at the token they raced for', async () => {
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser() });
      const parent = await tokenRow(hashSecret(issued.refreshToken));

      await warmPool(pool, PARALLEL_REFRESHES);
      const results = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => service.refresh(issued.refreshToken)),
      );

      const successors: IssuedSession[] = [];
      for (const result of results) {
        if (result.outcome === 'rotated' || result.outcome === 'graced') successors.push(result.session);
      }
      expect(successors).toHaveLength(PARALLEL_REFRESHES);

      for (const successor of successors) {
        const row = await tokenRow(hashSecret(successor.refreshToken));
        expect(row?.parent_id).toBe(parent?.id);
      }
    });

    it('leaves every one of those successors independently usable', async () => {
      // The fan-out is only worth anything if each panel really can keep refreshing on its
      // own token. If a graced caller received a token that the next rotation rejects, the
      // sign-out has merely been postponed by one cycle.
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser() });

      await warmPool(pool, PARALLEL_REFRESHES);
      const first = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => service.refresh(issued.refreshToken)),
      );

      for (const result of first) {
        if (result.outcome !== 'rotated' && result.outcome !== 'graced') continue;
        const again = await service.refresh(result.session.refreshToken);
        expect(again.outcome).toBe('rotated');
      }

      expect((await sessionRow(issued.sessionId)).revoked_at).toBeNull();
    });
  });

  describe('the detector still works', () => {
    it('graces a replay inside the window and kills the session for one after it', async () => {
      // A real one-second window and real elapsed time, so nothing here depends on a
      // parameter being passed as zero. Both halves matter: the first is fix ⓒ, the second
      // is the proof that fix ⓒ is not "never detect reuse".
      const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '1' }));
      const issued = await service.start({ userId: await newUser() });

      const rotated = await service.refresh(issued.refreshToken);
      expect(rotated.outcome).toBe('rotated');

      const withinWindow = await service.refresh(issued.refreshToken);
      expect(withinWindow.outcome).toBe('graced');
      expect((await sessionRow(issued.sessionId)).revoked_at).toBeNull();

      await sleep(1_200);

      const afterWindow = await service.refresh(issued.refreshToken);
      expect(afterWindow.outcome).toBe('reused');

      const revoked = await sessionRow(issued.sessionId);
      expect(revoked.revoked_at).not.toBeNull();
      expect(revoked.revoked_reason).toBe('refresh_reuse');
    });

    it('revokes the whole session, not just the token that was replayed', async () => {
      const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '0' }));
      const issued = await service.start({ userId: await newUser() });

      const rotated = await service.refresh(issued.refreshToken);
      expect(rotated.outcome).toBe('rotated');
      if (rotated.outcome !== 'rotated') return;

      expect((await service.refresh(issued.refreshToken)).outcome).toBe('reused');

      // `sessions_revoke_cascade` stamps the tokens in the same transaction — which is
      // what lets the rotation statement read session state off the token row alone.
      const successor = await tokenRow(hashSecret(rotated.session.refreshToken));
      expect(successor?.revoked_at).not.toBeNull();
    });

    it('does not raise a second alarm for the successor of a session it already killed', async () => {
      // After a revocation the honest tab presents a token that is perfectly valid and
      // simply belongs to a dead session. Reporting that as theft would double-count one
      // incident and revoke a session that is already revoked.
      const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '0' }));
      const issued = await service.start({ userId: await newUser() });

      const rotated = await service.refresh(issued.refreshToken);
      if (rotated.outcome !== 'rotated') throw new Error('expected the first rotation to win');
      expect((await service.refresh(issued.refreshToken)).outcome).toBe('reused');

      const before = await sessionRow(issued.sessionId);
      expect(await service.refresh(rotated.session.refreshToken)).toStrictEqual({ outcome: 'rejected' });

      const after = await sessionRow(issued.sessionId);
      expect(after.revoked_at?.getTime()).toBe(before.revoked_at?.getTime());
      expect(after.revoked_reason).toBe('refresh_reuse');
    });

    it('rejects a token nobody ever issued, and revokes nothing', async () => {
      const service = serviceWith(configWith());
      const issued = await service.start({ userId: await newUser() });

      expect(await service.refresh(randomBytes(32).toString('base64url'))).toStrictEqual({
        outcome: 'rejected',
      });
      expect(await service.refresh('')).toStrictEqual({ outcome: 'rejected' });
      expect((await sessionRow(issued.sessionId)).revoked_at).toBeNull();
    });

    it('names the session in the warning and puts no token material in it', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '0' }));
        const issued = await service.start({ userId: await newUser() });

        expect((await service.refresh(issued.refreshToken)).outcome).toBe('rotated');
        expect((await service.refresh(issued.refreshToken)).outcome).toBe('reused');

        const logged = warn.mock.calls.flat().join(' ');
        expect(logged).toContain(issued.sessionId);
        expect(logged).not.toContain(issued.refreshToken);
        // Not even the digest: a hash is not the secret, but it is still the lookup key
        // for the row, and there is no reason for it to be in a log aggregator.
        expect(logged).not.toContain(hashSecret(issued.refreshToken));
      } finally {
        warn.mockRestore();
      }
    });

    /**
     * The counterfactual, written down.
     *
     * This is what the eight callers above would be told without fix ⓒ. It is asserted
     * sequentially rather than in parallel on purpose: `now()` is the *transaction start*
     * time, so with a zero window whether a given parallel racer is graced or accused
     * depends on whether its transaction began before or after the winner's — genuinely
     * nondeterministic, and not something to hang an assertion on. Sequential removes the
     * ambiguity and makes the same point: with no window, a second use is theft.
     */
    it('counterfactual: with the window closed, the second caller loses the session', async () => {
      const service = serviceWith(configWith({ AUTH_REFRESH_GRACE_SECONDS: '0' }));
      const issued = await service.start({ userId: await newUser() });

      expect((await service.refresh(issued.refreshToken)).outcome).toBe('rotated');
      expect((await service.refresh(issued.refreshToken)).outcome).toBe('reused');
      expect((await sessionRow(issued.sessionId)).revoked_reason).toBe('refresh_reuse');
    });
  });

  describe('signing out', () => {
    it('revokes the session and makes its tokens unusable without accusing anybody', async () => {
      const service = serviceWith(configWith());
      const userId = await newUser();
      const issued = await service.start({ userId });

      expect(await service.signOut(issued.sessionId, userId)).toBe(true);

      const revoked = await sessionRow(issued.sessionId);
      expect(revoked.revoked_reason).toBe('logout');

      // `rejected`, not `reused`: signing out is not an incident, and a support queue that
      // cannot tell the two apart is one that stops reading either.
      expect(await service.refresh(issued.refreshToken)).toStrictEqual({ outcome: 'rejected' });
    });

    it('is idempotent, and keeps the first reason', async () => {
      const service = serviceWith(configWith());
      const userId = await newUser();
      const issued = await service.start({ userId });

      expect(await service.signOut(issued.sessionId, userId)).toBe(true);
      expect(await service.signOut(issued.sessionId, userId)).toBe(false);
      expect((await sessionRow(issued.sessionId)).revoked_reason).toBe('logout');
    });

    it('will not let one user revoke another user’s session', async () => {
      // Plan section 6: every query carries a scope. A session id from a request is a claim
      // about a row, not permission to write it.
      const service = serviceWith(configWith());
      const owner = await newUser();
      const stranger = await newUser();
      const issued = await service.start({ userId: owner });

      expect(await service.signOut(issued.sessionId, stranger)).toBe(false);
      expect((await sessionRow(issued.sessionId)).revoked_at).toBeNull();
    });

    it('signs out everywhere with a reason a human can read', async () => {
      const service = serviceWith(configWith());
      const userId = await newUser();
      const a = await service.start({ userId });
      const b = await service.start({ userId });

      expect(await service.signOutEverywhere(userId, 'password_changed')).toBe(2);
      expect((await sessionRow(a.sessionId)).revoked_reason).toBe('password_changed');
      expect((await sessionRow(b.sessionId)).revoked_reason).toBe('password_changed');
    });
  });
});

/**
 * Blocks until `expected` backends are waiting on a lock inside `rotate_refresh_token`.
 *
 * This is what turns "we called Promise.all" into "eight backends were inside the
 * statement at the same instant". `wait_event_type = 'Lock'` is Postgres saying the
 * backend is queued behind another transaction's row lock — not merely running, not merely
 * connected. `pg_backend_pid()` is excluded because this observing query contains the
 * function's name in its own text and would otherwise count itself.
 *
 * `application_name` is not decoration. packages/db's own auth suite calls the same
 * function and manufactures the same contention, and under `turbo run test` it may be doing
 * so against this database at this instant — counting its backends would let this wait
 * return before *these* seven had blocked, and the proof would be of somebody else's race.
 * `createPool` in src/database/database.module.ts stamps every connection this app opens;
 * packages/db's pool sets no name at all.
 */
async function waitUntilBlocked(observer: pg.PoolClient, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    const result = await observer.query<{ blocked: number }>(
      `select count(*)::int as blocked
         from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and application_name = 'wewin-api'
          and state = 'active'
          and wait_event_type = 'Lock'
          and query ilike '%rotate_refresh_token%'`,
    );

    const blocked = result.rows[0]?.blocked ?? 0;
    if (blocked >= expected) return;

    if (Date.now() > deadline) {
      throw new Error(
        `only ${String(blocked)} of ${String(expected)} refreshes were blocked on the row lock; ` +
          'the concurrency this test claims to exercise did not happen',
      );
    }

    await sleep(25);
  }
}

/**
 * Opens `size` connections before the timed section.
 *
 * `pg.Pool` connects lazily, so the first eight parallel queries would otherwise be eight
 * TCP handshakes and eight authentications — enough serialisation to make a race that
 * exists in production not happen here.
 */
async function warmPool(pool: pg.Pool, size: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
  await Promise.all(clients.map((client) => client.query('select 1')));
  for (const client of clients) client.release();
}
