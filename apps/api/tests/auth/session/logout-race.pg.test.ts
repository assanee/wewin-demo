import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseSessionConfig, type SessionConfig } from '../../../src/auth/session/session.config';
import { SessionRepository } from '../../../src/auth/session/session.repository';
import { SessionService } from '../../../src/auth/session/session.service';
import { parseEnv } from '../../../src/config/env';
import { createPool } from '../../../src/database/database.module';

/**
 * ⓒ Signing out has to work while the same session is refreshing.
 *
 * The bug this file exists for was found by running it rather than reading it, and it is the
 * kind that never shows up in a single-threaded test. `rotate_refresh_token()` claimed a row
 * in `refresh_tokens` and *then* touched `sessions.last_seen_at`; `sessions_revoke_cascade`
 * goes the other way — revoking updates `sessions`, and the trigger updates that session's
 * `refresh_tokens`. Two lock orders over two tables is a cycle, and Postgres breaks a cycle
 * by aborting somebody with 40P01.
 *
 * Nothing retried, so the abort *was* the outcome. Measured before the fix, on this laptop:
 * of 300 concurrent (refresh, logout) pairs, 87 logouts aborted and the session was still
 * live in every one of them — the user pressed sign out, the request failed, and they stayed
 * signed in. "Sign out everywhere" was worse, because it is one statement across every
 * session a user has: a single racing tab took the whole call down.
 *
 * 0004_auth_hardening.sql takes the session lock first, so both paths go `sessions` then
 * `refresh_tokens` and the cycle cannot form. These tests assert the *property* — nobody is
 * aborted, and a session somebody asked to end is ended — rather than any lock mechanics,
 * because the property is what a customer experiences.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const MARKER = 'auth-session-logout-race.pg.test';
const DEADLOCK = '40P01';

/** Enough pairs to have reproduced the deadlock reliably before the fix, and still fast. */
const PAIRS = 60;
const SESSIONS_PER_USER = 5;

describeWithPg('signing out while the session is refreshing', () => {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url ?? 'postgres://unused/unused',
    // Wide enough that the pairs genuinely overlap; a narrow pool serialises the thing
    // under test and the suite passes by never provoking it.
    DATABASE_POOL_MAX: '24',
  });

  let pool: pg.Pool;
  let repository: SessionRepository;
  let service: SessionService;

  const config = (): SessionConfig =>
    parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url') });

  beforeAll(() => {
    Logger.overrideLogger(false);
    pool = createPool(env);
    repository = new SessionRepository(pool);
    const parsed = config();
    service = new SessionService(repository, new AccessTokenService(parsed), parsed);
  });

  afterAll(async () => {
    await pool.query('delete from users where display_name = $1', [MARKER]);
    await pool.end();
  });

  async function newUser(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      'insert into users (display_name) values ($1) returning id',
      [MARKER],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('could not create a user for the test');
    return row.id;
  }

  const revokedAt = async (sessionId: string): Promise<Date | null> => {
    const result = await pool.query<{ revoked_at: Date | null }>(
      'select revoked_at from sessions where id = $1',
      [sessionId],
    );
    return result.rows[0]?.revoked_at ?? null;
  };

  /** Rethrows anything that is not the deadlock, so a different failure is never counted as one. */
  const countingDeadlocks = async (work: Promise<unknown>, onDeadlock: () => void): Promise<void> => {
    try {
      await work;
    } catch (error) {
      if ((error as { code?: string }).code !== DEADLOCK) throw error;
      onDeadlock();
    }
  };

  it('never aborts either side, and always ends the session', async () => {
    const sessions = await Promise.all(
      Array.from({ length: PAIRS }, async () => {
        const userId = await newUser();
        return { userId, issued: await service.start({ userId }) };
      }),
    );

    let deadlocks = 0;

    await Promise.all(
      sessions.flatMap(({ userId, issued }) => [
        countingDeadlocks(service.refresh(issued.refreshToken), () => (deadlocks += 1)),
        countingDeadlocks(service.signOut(issued.sessionId, userId), () => (deadlocks += 1)),
      ]),
    );

    expect(deadlocks).toBe(0);

    /*
     * The assertion that matters more than the count. A deadlock that aborted the *refresh*
     * would be survivable — the client retries. The one that was happening aborted the
     * logout, and a logout that failed left a live session behind a success the user had
     * already been shown.
     */
    const live = (await Promise.all(sessions.map(({ issued }) => revokedAt(issued.sessionId)))).filter(
      (at) => at === null,
    );
    expect(live).toHaveLength(0);
  }, 60_000);

  it('signs out everywhere even when one of those sessions is mid-refresh', async () => {
    /*
     * `revokeAllSessionsOfUser` is a single UPDATE across every session a user has, so
     * before the fix one racing tab did not cost one session — it aborted the whole
     * statement and left all of them alive. That is the shape of "an administrator revoked
     * this account and nothing happened".
     */
    const users = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const userId = await newUser();
        const issued = await Promise.all(
          Array.from({ length: SESSIONS_PER_USER }, () => service.start({ userId })),
        );
        return { userId, issued };
      }),
    );

    let deadlocks = 0;

    await Promise.all(
      users.flatMap(({ userId, issued }) => [
        // One tab refreshing while the "sign out everywhere" lands.
        ...issued.map((session) =>
          countingDeadlocks(service.refresh(session.refreshToken), () => (deadlocks += 1)),
        ),
        countingDeadlocks(service.signOutEverywhere(userId, 'revoked_by_admin'), () => (deadlocks += 1)),
      ]),
    );

    expect(deadlocks).toBe(0);

    for (const { issued } of users) {
      const states = await Promise.all(issued.map((session) => revokedAt(session.sessionId)));
      expect(states.filter((at) => at === null)).toHaveLength(0);
    }
  }, 60_000);

  /**
   * ⓒ's own property, restated here because this file is where the session dies.
   *
   * A refresh presented against a session that has been revoked must be refused, and must
   * not be mistaken for theft: nothing was stolen, the session simply ended. `rejected`, and
   * the reason on the session row stays the one the revoker wrote.
   */
  it('refuses a refresh after the session is signed out, without calling it theft', async () => {
    const userId = await newUser();
    const issued = await service.start({ userId });

    expect(await service.signOut(issued.sessionId, userId)).toBe(true);

    const result = await service.refresh(issued.refreshToken);
    expect(result.outcome).toBe('rejected');

    const reason = await pool.query<{ revoked_reason: string | null }>(
      'select revoked_reason from sessions where id = $1',
      [issued.sessionId],
    );
    expect(reason.rows[0]?.revoked_reason).toBe('logout');
  });

  /**
   * Suspension reaches the refresh chain, not only the sign-in page.
   *
   * Refusing a suspended account at sign-in alone leaves a thirty-day refresh token that
   * keeps rotating, so the ban expires when the token does. The `users` join inside
   * `rotate_refresh_token()` ends it at the next rotation — at most one access-token
   * lifetime away — and answers `rejected` rather than `reused`, because suspension is not
   * theft and must not overwrite the reason an administrator set.
   */
  it('stops a suspended account from rotating its refresh token', async () => {
    const userId = await newUser();
    const issued = await service.start({ userId });

    // It works right up until the suspension, so the test cannot pass for the wrong reason.
    const before = await service.refresh(issued.refreshToken);
    expect(before.outcome === 'rotated' || before.outcome === 'graced').toBe(true);
    if (before.outcome !== 'rotated' && before.outcome !== 'graced') throw new Error('unreachable');

    await pool.query(`update users set status = 'suspended', suspended_at = now() where id = $1`, [
      userId,
    ]);

    const after = await service.refresh(before.session.refreshToken);
    expect(after.outcome).toBe('rejected');

    // Not revoked-as-theft: the session row is untouched, so an administrator's own reason
    // is still the one recorded when they get round to revoking it.
    expect(await revokedAt(issued.sessionId)).toBeNull();
  });
});
