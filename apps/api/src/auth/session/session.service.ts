import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccessTokenService, type AccessTokenVerification } from './access-token';
import { hashSecret, mintSecret } from './secrets';
import type { SessionConfig } from './session.config';
import { SessionRepository, type RevocationReason } from './session.repository';
import { SESSION_CONFIG } from './session.tokens';

/**
 * Sessions, and the rotation that keeps one alive.
 *
 * The credentials this hands back are values, not cookies: transport belongs to whichever
 * controller is doing the signing-in, and this module has no opinion about the URL it is
 * mounted at. `refresh-cookie.ts` beside this file supplies the one thing that is *not* a
 * transport decision — the attributes a refresh cookie must carry — and nothing else.
 */

export interface StartSessionInput {
  readonly userId: string;
  /** From the request. Both are for the user's own device list; both may be absent. */
  readonly userAgent?: string | null;
  readonly ip?: string | null;
}

/** A session and the two credentials that address it. The raw secrets exist only here and in the response. */
export interface IssuedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionExpiresAt: Date;
}

/**
 * The four things a refresh can be, kept apart all the way to the caller.
 *
 * `rotated` and `graced` are not folded together — the database distinguishes them and it
 * would be rude to throw that away — but **nothing may branch on which one arrived**, and
 * `graced` must not be treated as a count of races. It is a lower bound on them, for a
 * reason that is not obvious and is measured in tests/auth-session-rotation.pg.test.ts:
 * `rotate_refresh_token()` tells the two apart with `RETURNING old.consumed_at`, and `old`
 * is the row as the *statement's own snapshot* saw it. A caller that blocked on the row
 * lock took its snapshot before the winner committed, so it sees NULL and is labelled
 * `rotated` even though it is precisely the racing tab the grace window exists for. The
 * WHERE clause is a separate matter and *is* re-evaluated against the updated row, which
 * is why the grace window still does its job in that case — only the label is lost.
 *
 * So: for the caller, `rotated` and `graced` are one thing, "here is your successor". For a
 * dashboard, a burst of `graced` is evidence that races are happening; an absence of it is
 * evidence of nothing.
 *
 * `reused` and `rejected` are also kept apart, and that distinction *is* load-bearing. Both
 * end as 401, but only one of them means a session was destroyed on suspicion of theft, and
 * only one of them should ever page anybody.
 */
export type RefreshResult =
  | { readonly outcome: 'rotated' | 'graced'; readonly session: IssuedSession }
  | { readonly outcome: 'reused' | 'rejected' };

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly repository: SessionRepository,
    private readonly accessTokens: AccessTokenService,
    @Inject(SESSION_CONFIG) private readonly config: SessionConfig,
  ) {}

  /** A new sign-in: one session row, the first token of its chain, and an access token. */
  async start(input: StartSessionInput): Promise<IssuedSession> {
    const refreshToken = mintSecret();

    const created = await this.repository.createSession({
      userId: input.userId,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      tokenHash: hashSecret(refreshToken),
      sessionTtlSeconds: this.config.sessionTtlSeconds,
      refreshTtlSeconds: this.config.refreshTokenTtlSeconds,
    });

    const access = this.accessTokens.sign({ userId: input.userId, sessionId: created.sessionId });

    return {
      sessionId: created.sessionId,
      userId: input.userId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: created.refreshTokenExpiresAt,
      sessionExpiresAt: created.sessionExpiresAt,
    };
  }

  /**
   * ⓒ Exchange a refresh token for its successor.
   *
   * The concurrency lives entirely in `SessionRepository.rotate`, which is one statement.
   * What this method contributes is the part that must *not* be clever: the successor's
   * secret is minted before the outcome is known, and thrown away if the rotation failed.
   * Minting it afterwards would mean a second statement, and a second statement is a
   * second chance to interleave.
   *
   * The fan-out is intentional and worth stating plainly, because it looks like a bug in a
   * database dump. Six panels refreshing at once each get a successor of their own — six
   * children of one parent, six live tokens in one session, one spent token. That is
   * correct: each panel keeps a token it can rotate independently, nobody is signed out,
   * and the chain records afterwards that a race happened.
   *
   * The cost is real and is the price of fix ⓒ, not an oversight, so it is written down
   * rather than implied. Inside the grace window a thief replaying a stolen token is
   * indistinguishable from a racing tab and is given a successor of their own — a branch of
   * the chain that then rotates independently of the victim's and is never again presented
   * alongside it, so reuse detection has nothing further to notice. Fifteen seconds of
   * exposure, and only for a thief who replays inside them; a stolen token used at any
   * later moment still ends the session. Narrowing that to zero is not available while
   * tokens are stored hashed: a graced caller cannot be handed the winner's secret, because
   * the database never had it.
   */
  async refresh(presentedRefreshToken: string): Promise<RefreshResult> {
    const presentedHash = hashSecret(presentedRefreshToken);
    const successor = mintSecret();

    const rotation = await this.repository.rotate(
      presentedHash,
      hashSecret(successor),
      this.config.refreshTokenTtlSeconds,
      this.config.refreshGraceSeconds,
    );

    if (rotation.outcome === 'reused') {
      /*
       * The session is already revoked — the database did it inside the same statement
       * that refused the token, so there is no window here in which the stolen token still
       * works. All that is left is to say so somewhere a human will read it. The token
       * itself never appears in the log, only the session it named.
       */
      const sessionId = await this.repository.findSessionIdByTokenHash(presentedHash);
      this.logger.warn(
        `Refresh token reuse detected; session ${sessionId ?? '(unknown)'} revoked. ` +
          'This is a token that was already spent and presented again after the grace window closed.',
      );
      return { outcome: 'reused' };
    }

    if (rotation.outcome === 'rejected') {
      // Unknown, expired, or belonging to a session that was already revoked. Not an
      // incident: this is what an idle tab looks like the morning after. Debug, not warn —
      // a warning per stale tab is a warning nobody reads.
      this.logger.debug('Refresh token rejected: unknown, expired, or already-revoked session');
      return { outcome: 'rejected' };
    }

    if (
      rotation.sessionId === undefined ||
      rotation.userId === undefined ||
      rotation.successorExpiresAt === undefined ||
      rotation.sessionExpiresAt === undefined
    ) {
      // Unreachable through the repository, which already refuses this shape. Kept because
      // the alternative is `!` on four properties, and the house rule against that exists
      // for exactly the case where somebody later changes what the function returns.
      throw new Error(`rotation reported '${rotation.outcome}' without a session to issue against`);
    }

    const access = this.accessTokens.sign({
      userId: rotation.userId,
      sessionId: rotation.sessionId,
    });

    return {
      outcome: rotation.outcome,
      session: {
        sessionId: rotation.sessionId,
        userId: rotation.userId,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: successor,
        refreshTokenExpiresAt: rotation.successorExpiresAt,
        sessionExpiresAt: rotation.sessionExpiresAt,
      },
    };
  }

  /**
   * Sign out of one session.
   *
   * Returns whether anything changed, so a controller can answer honestly rather than
   * reporting success for a session id that belongs to somebody else. It never *says*
   * which of "no such session" and "not yours" applied, because that distinction is an
   * enumeration oracle.
   */
  async signOut(sessionId: string, userId: string): Promise<boolean> {
    return this.repository.revokeSession(sessionId, userId, 'logout');
  }

  /**
   * Sign out everywhere.
   *
   * `reason` is exposed because "you changed your password" and "an administrator revoked
   * this" are different sentences in a support conversation, and the column exists to hold
   * that. `refresh_reuse` is not in the type: only the database writes that one, from
   * inside the statement that detected it.
   */
  async signOutEverywhere(userId: string, reason: RevocationReason = 'logout'): Promise<number> {
    return this.repository.revokeAllSessionsOfUser(userId, reason);
  }

  /**
   * Signature-only verification, no database read. See access-token.ts for why permissions
   * are not in the token, and session.config.ts for what the ten-minute lifetime buys.
   */
  verifyAccessToken(token: string): AccessTokenVerification {
    return this.accessTokens.verify(token);
  }
}
