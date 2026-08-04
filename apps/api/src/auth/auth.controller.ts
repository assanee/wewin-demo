import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { readCookie } from '../common/cookies';
import { AppError } from '../common/errors/app-error';
import { AllowAnonymous, RequireAuthenticated } from '../rbac/access';
import { CurrentScope } from '../rbac/current-scope.decorator';
import { matchScope, type Scope } from '../rbac/scope';
import { clearedRefreshCookie, refreshCookie, REFRESH_COOKIE_NAME } from './session/refresh-cookie';
import { SessionService } from './session/session.service';

/**
 * The two endpoints a session needs after it exists, and nothing else.
 *
 * Signing *in* is `auth/oauth/*`; this is what happens for the next ninety days. Both
 * routes are POST, which is not decoration: each one changes server state (a rotation, a
 * revocation) and a GET that does either is a link a page can be made to follow.
 *
 * The response bodies carry the access token and nothing about the refresh token. The
 * refresh token only ever exists in the `__Host-` cookie — see refresh-cookie.ts for why
 * that prefix is the whole design — and a client that could read it would be a client that
 * could leak it.
 */

export interface RefreshResponse {
  readonly accessToken: string;
  /** ISO 8601. The client refreshes before this, rather than waiting for a 401 to tell it. */
  readonly accessTokenExpiresAt: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

  /**
   * ⓒ Spend the refresh cookie, get its successor and a fresh access token.
   *
   * `@AllowAnonymous` and not `@RequireAuthenticated`, and the distinction is the point of
   * the endpoint: the caller arrives here precisely because their access token has expired,
   * so requiring one would make the refresh path unreachable exactly when it is needed. It
   * is not unauthenticated — the refresh cookie is the credential — it is authenticated by
   * something the guard does not know how to read, which is why the reason string says so
   * rather than leaving a reader to assume this route is open.
   *
   * Every failure is one 401 with one body. `reused` (a replayed token, session destroyed)
   * and `rejected` (unknown, expired, already revoked) are different events with different
   * consequences, and the difference is logged where an operator can act on it — telling a
   * caller which one happened would confirm to a thief that their token was recognised.
   *
   * The parallel-tab case is the whole of fix ⓒ and is invisible here on purpose: six
   * panels refreshing in the same millisecond all land in `rotate_refresh_token`, all get a
   * successor, and none of them is accused of anything. That behaviour lives in one SQL
   * statement, not in this controller, because a controller cannot be atomic.
   */
  @Post('refresh')
  @HttpCode(200)
  @AllowAnonymous('the caller has no access token by definition — the refresh cookie is the credential')
  async refresh(@Req() request: Request, @Res() response: Response): Promise<void> {
    const presented = readCookie(request.headers.cookie, REFRESH_COOKIE_NAME);
    // A missing cookie and a refused one get the same answer, from the same branch: "no
    // cookie" is what a caller with a stolen access token and no refresh token looks like.
    const result = presented === undefined ? undefined : await this.sessions.refresh(presented);

    // Stated as "not a success" rather than "one of the two failures": adding a fifth
    // outcome to `RefreshResult` must fall on this side of the branch, not through it.
    if (result === undefined || (result.outcome !== 'rotated' && result.outcome !== 'graced')) {
      /*
       * The cookie is cleared on the way out. Leaving a token the database has refused in
       * the browser guarantees the next request repeats the refusal — and after a `reused`
       * it guarantees the *victim* keeps presenting a token that says an incident happened.
       *
       * Set before the throw, and it survives: the global filter writes the envelope with
       * `response.status().json()`, which does not discard headers already on the response.
       * That is also why this throws rather than writing its own body — one error envelope
       * for the whole API, built in one place.
       */
      response.setHeader('Set-Cookie', clearedRefreshCookie());
      response.setHeader('Cache-Control', 'no-store');
      throw AppError.unauthenticated('Sign in again.');
    }

    const { session } = result;
    response.setHeader(
      'Set-Cookie',
      refreshCookie(session.refreshToken, session.refreshTokenExpiresAt),
    );
    // A bearer credential must never be stored by a proxy or the browser's page cache.
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    } satisfies RefreshResponse);
  }

  /**
   * Sign out of this session.
   *
   * Scoped to the caller's own session id and user id — both come from the verified access
   * token and neither from the body — so there is no request shape that signs somebody else
   * out. `SessionRepository.revokeSession` carries `user_id` in its WHERE clause for the
   * same reason, one layer down.
   *
   * Answers 204 whether or not a row changed. Reporting "nothing to revoke" would tell a
   * caller holding a stolen token whether the session it names is still alive, and the
   * honest answer to "sign me out" when there is nothing to sign out of is that they are
   * signed out.
   *
   * Access tokens already issued for this session keep verifying until they expire — up to
   * `AUTH_ACCESS_TOKEN_TTL_SECONDS`, ten minutes by default. That is the documented price
   * of signature-only verification (session.config.ts spends a paragraph on the number),
   * and it is why the refresh cookie is cleared here: the long-lived half stops working
   * immediately.
   */
  @Post('logout')
  @HttpCode(204)
  @RequireAuthenticated()
  async logout(@CurrentScope() scope: Scope, @Res() response: Response): Promise<void> {
    await matchScope(scope, {
      user: async (user) => {
        await this.sessions.signOut(user.sessionId, user.userId);
      },
      // Unreachable behind `@RequireAuthenticated`, and answered rather than thrown: a 500
      // on sign-out would leave the cookie in place, which is the one outcome this endpoint
      // exists to prevent.
      guest: async () => undefined,
      public: async () => undefined,
      system: async () => undefined,
    });

    response.setHeader('Set-Cookie', clearedRefreshCookie());
    response.setHeader('Cache-Control', 'no-store');
    response.status(204).send();
  }
}
