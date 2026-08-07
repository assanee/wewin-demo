import { Body, Controller, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AllowAnonymous } from '../../rbac/access';
import { refreshCookie } from '../session/refresh-cookie';
import {
  passwordSignInSchema,
  type PasswordSignInBody,
  type PasswordSignInResponse,
  type SecondFactorRequiredResponse,
} from './password.contract';
import { PasswordSignInService } from './password-sign-in.service';

/**
 * Signing in with an address and a password.
 *
 * Sits beside `auth/oauth/*` rather than inside it, because it is a different kind of proof
 * — no provider, no redirect, no `state` — but it ends in the same place: one session, one
 * `__Host-` refresh cookie, one rotation chain. Two ways in, one session mechanism, which
 * is the only arrangement in which fix ⓒ means anything.
 */
@Controller('auth')
export class PasswordController {
  constructor(private readonly passwords: PasswordSignInService) {}

  /**
   * 200 with an access token, and the refresh token in a cookie the page cannot read.
   *
   * The split is the same one `AuthController.refresh` makes and for the same reason. Unlike
   * the OAuth callback — a redirect the browser follows, where a body would be discarded —
   * this is an XHR from a form, so the access token goes back in the body and the caller can
   * use it immediately. The refresh half never appears there: a token a script can read is a
   * token an injected script can take.
   *
   * **`@AllowAnonymous`, and anonymous is not "open".** The credential is in the body and the
   * guard has no way to read it — the same shape `POST /auth/refresh` documents for its
   * cookie. The reason string says so, so that a reader of the route audit does not have to
   * assume.
   *
   * ⚠️ `no-store` is not optional. The body carries a bearer credential, and a proxy or a
   * browser cache holding it would hand somebody else's session to the next similar request.
   */
  @Post('password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowAnonymous(
    'the credential is the email and password in the body — this is a route that mints a ' +
      'session, so by definition the caller has none for the guard to read',
  )
  async signIn(
    @Req() request: Request,
    @Res() response: Response,
    @Body(new ZodBodyPipe(passwordSignInSchema)) body: PasswordSignInBody,
  ): Promise<void> {
    const outcome = await this.passwords.signIn({
      email: body.email,
      password: body.password,
      /*
       * `request.ip` respects `trust proxy`; the socket address is the fallback for a direct
       * connection. Both feed the throttle, so behind a misconfigured proxy every caller
       * would share one bucket — which fails *closed* (everyone throttled together) rather
       * than open, and is the right way round for a limiter to be wrong.
       */
      address: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      userAgent: request.get('user-agent'),
    });

    /*
     * ⭐ Two outcomes, and only one of them is a session.
     *
     * ⚠️ No `Set-Cookie` on the challenge branch. The refresh token is the durable half of a
     * session and there is no session yet — writing one here would leave a browser holding a
     * credential it could rotate into a live session without ever presenting a second
     * factor, which is the whole feature undone by a convenience.
     */
    if (outcome.kind === 'challenge') {
      response.status(200).json({
        mfaRequired: true,
        challengeToken: outcome.token,
        challengeExpiresAt: outcome.expiresAt.toISOString(),
      } satisfies SecondFactorRequiredResponse);
      return;
    }

    const { session } = outcome;

    response.setHeader(
      'Set-Cookie',
      refreshCookie(session.refreshToken, session.refreshTokenExpiresAt),
    );

    response.status(200).json({
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    } satisfies PasswordSignInResponse);
  }
}
