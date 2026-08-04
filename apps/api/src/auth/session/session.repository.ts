import { isIP } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL } from '../../database/database.tokens';

/**
 * Every statement this module sends to Postgres, and nothing else.
 *
 * It takes the raw `pg.Pool` rather than the Drizzle handle. That is a deliberate
 * exception to how `catalog.repository.ts` reads the catalogue, and the reason is fix ⓒ:
 * rotation is a call to `rotate_refresh_token()`, a plpgsql function whose whole value is
 * that it is *one statement*. Drizzle would add a query builder around a string it cannot
 * decompose, an extra nominal-type hop through @wewin/db/sql, and no type safety over the
 * result — the function's `RETURNS TABLE` is not in the schema. Where the ORM helps
 * (composing a filtered read) this module has no such query.
 */

/** What `rotate_refresh_token()` decided. Mirrors the `refresh_rotation_outcome` enum. */
export type RotationOutcome = 'rotated' | 'graced' | 'reused' | 'rejected';

export interface RotationResult {
  readonly outcome: RotationOutcome;
  /** Present on `rotated` and `graced` only — the function returns NULL for the rest. */
  readonly sessionId: string | undefined;
  readonly userId: string | undefined;
  readonly successorId: string | undefined;
  readonly successorExpiresAt: Date | undefined;
  readonly sessionExpiresAt: Date | undefined;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly tokenHash: string;
  readonly sessionTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly sessionExpiresAt: Date;
  readonly refreshTokenId: string;
  readonly refreshTokenExpiresAt: Date;
}

/** The reasons this application may revoke a session. `refresh_reuse` is the database's to write. */
export type RevocationReason = 'logout' | 'password_changed' | 'email_changed' | 'revoked_by_admin';

/** `user_agent` is attacker-controlled and unbounded; it exists for a device list, not for forensics. */
const USER_AGENT_MAX_LENGTH = 512;

interface RotationRow {
  readonly outcome: RotationOutcome;
  readonly in_session: string | null;
  readonly successor_id: string | null;
  readonly user_id: string | null;
  readonly session_expires_at: Date | null;
  readonly db_now: Date;
}

@Injectable()
export class SessionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * A session and the first token of its chain, in one transaction.
   *
   * Two statements and not one CTE. A data-modifying CTE would look tidier, but
   * `refresh_tokens_within_session` is a BEFORE trigger that reads `sessions` to clamp the
   * expiry, and sibling CTEs cannot see each other's rows — so the tidier version depends
   * on whether a trigger's snapshot happens to include a row inserted by a sibling branch
   * of the same statement. That is not a thing to depend on. Inside a transaction the
   * second statement sees the first, by definition.
   */
  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const session = await client.query<{ id: string; expires_at: Date }>(
        `insert into sessions (user_id, user_agent, ip, expires_at)
         values ($1, $2, $3::inet, now() + make_interval(secs => $4::double precision))
         returning id, expires_at`,
        [input.userId, truncateUserAgent(input.userAgent), normaliseIp(input.ip), input.sessionTtlSeconds],
      );

      const created = session.rows[0];
      if (created === undefined) throw new Error('inserting a session returned no row');

      /*
       * `least(…, s.expires_at)` restates what the trigger enforces rather than trusting
       * it to be lenient: the trigger *rejects* a token that would outlive its session, it
       * does not clamp one. Reading the ceiling from the row we just wrote is also what
       * makes a session TTL shorter than the refresh TTL a survivable misconfiguration
       * rather than a failed login.
       */
      const token = await client.query<{ id: string; expires_at: Date }>(
        `insert into refresh_tokens (session_id, token_hash, expires_at)
         select s.id, $2, least(now() + make_interval(secs => $3::double precision), s.expires_at)
           from sessions s
          where s.id = $1
         returning id, expires_at`,
        [created.id, input.tokenHash, input.refreshTtlSeconds],
      );

      const issued = token.rows[0];
      if (issued === undefined) throw new Error('inserting a refresh token returned no row');

      await client.query('commit');

      return {
        sessionId: created.id,
        sessionExpiresAt: created.expires_at,
        refreshTokenId: issued.id,
        refreshTokenExpiresAt: issued.expires_at,
      };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * ⓒ The whole of fix (c), in one statement.
   *
   * `rotate_refresh_token()` is described at length in
   * packages/db/drizzle/0003_auth_guards.sql. What matters on this side is what must *not*
   * be added around it:
   *
   *   - no `begin`/`commit`. One statement on one pooled connection is already atomic, and
   *     wrapping it would only widen the window in which this connection holds the row
   *     lock that every other parallel refresh is queued behind.
   *   - no read of the token before the call, and no read after it to decide what happened.
   *     Either one reintroduces the read-then-write that the function exists to remove; the
   *     six-panel dashboard is precisely the case where the interleaving is not rare.
   *
   * The two LEFT JOINs are safe to have here and are worth understanding. `sessions` is a
   * row committed by an earlier transaction, so the statement's snapshot sees it. The
   * *successor* token is not joined, on purpose: it is inserted by the function during
   * this statement, so the outer snapshot cannot see it and the join would silently
   * produce NULL. Its expiry is reconstructed instead — see below, where that turns out to
   * be exact rather than approximate.
   */
  async rotate(
    presentedHash: string,
    successorHash: string,
    refreshTtlSeconds: number,
    graceSeconds: number,
  ): Promise<RotationResult> {
    const result = await this.pool.query<RotationRow>(
      `select r.outcome,
              r.in_session,
              r.successor_id,
              s.user_id,
              s.expires_at as session_expires_at,
              now() as db_now
         from rotate_refresh_token(
                $1::char(64),
                $2::char(64),
                make_interval(secs => $3::double precision),
                make_interval(secs => $4::double precision)
              ) r
         left join sessions s on s.id = r.in_session`,
      [presentedHash, successorHash, refreshTtlSeconds, graceSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) throw new Error('rotate_refresh_token() returned no row');

    if (row.outcome !== 'rotated' && row.outcome !== 'graced') {
      return {
        outcome: row.outcome,
        sessionId: undefined,
        userId: undefined,
        successorId: undefined,
        successorExpiresAt: undefined,
        sessionExpiresAt: undefined,
      };
    }

    if (row.in_session === null || row.user_id === null || row.successor_id === null || row.session_expires_at === null) {
      throw new Error(`rotate_refresh_token() reported '${row.outcome}' without a session`);
    }

    return {
      outcome: row.outcome,
      sessionId: row.in_session,
      userId: row.user_id,
      successorId: row.successor_id,
      /*
       * Exact, not an estimate, and the reason is worth one sentence: `now()` is the
       * *transaction* start time, the function ran inside this transaction, and this
       * statement is the transaction — so `db_now` is bit-for-bit the value the function's
       * own `least(now() + p_successor_ttl, s.expires_at)` used. Reading the successor row
       * back would cost a round trip to learn something already known.
       */
      successorExpiresAt: earlier(
        new Date(row.db_now.getTime() + refreshTtlSeconds * 1000),
        row.session_expires_at,
      ),
      sessionExpiresAt: row.session_expires_at,
    };
  }

  /**
   * Revokes one session, scoped to its owner.
   *
   * `user_id` is in the WHERE and not checked beforehand because plan section 6's rule is
   * that every query carries a scope — an id from a request is a claim about a row, not a
   * permission to write it. `revoked_at is null` makes this idempotent and keeps the first
   * reason: a logout after a reuse revocation must not overwrite `refresh_reuse`, which is
   * the only record that an incident happened.
   *
   * The tokens are not touched here. `sessions_revoke_cascade` stamps them in the same
   * transaction, which is what lets the rotation statement above stay single-table.
   */
  async revokeSession(sessionId: string, userId: string, reason: RevocationReason): Promise<boolean> {
    const result = await this.pool.query(
      `update sessions
          set revoked_at = now(), revoked_reason = $3
        where id = $1
          and user_id = $2
          and revoked_at is null`,
      [sessionId, userId, reason],
    );

    return (result.rowCount ?? 0) > 0;
  }

  /** "Sign out everywhere". Same shape, no session id. */
  async revokeAllSessionsOfUser(userId: string, reason: RevocationReason): Promise<number> {
    const result = await this.pool.query(
      `update sessions
          set revoked_at = now(), revoked_reason = $2
        where user_id = $1
          and revoked_at is null`,
      [userId, reason],
    );

    return result.rowCount ?? 0;
  }

  /**
   * Which session a presented token belonged to.
   *
   * Used on the `reused` path only. `rotate_refresh_token()` returns NULL for `in_session`
   * when it detects reuse — correctly, since nothing was issued — but that leaves the
   * warning with no subject, and "we revoked a session for token reuse" is not an audit
   * line without saying which. One extra round trip on the rarest path is the right price;
   * putting it on the hot path to avoid it would not be.
   */
  async findSessionIdByTokenHash(tokenHash: string): Promise<string | undefined> {
    const result = await this.pool.query<{ session_id: string }>(
      'select session_id from refresh_tokens where token_hash = $1',
      [tokenHash],
    );

    return result.rows[0]?.session_id;
  }
}

const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/**
 * A malformed address becomes NULL rather than a 22P02 on the column.
 *
 * `sessions.ip` is `inet`, and the value arrives from a proxy header that anybody can
 * write. Letting Postgres reject it turns "your load balancer sent a hostname" into a
 * failed sign-in; the address is for the user's own device list, so absent is a fine
 * answer and a failed login is not.
 */
function normaliseIp(ip: string | null): string | null {
  if (ip === null) return null;
  const trimmed = ip.trim();
  return isIP(trimmed) === 0 ? null : trimmed;
}

function truncateUserAgent(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  return userAgent.length > USER_AGENT_MAX_LENGTH ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : userAgent;
}
