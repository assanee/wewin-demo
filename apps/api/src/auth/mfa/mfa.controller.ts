import { Body, Controller, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AllowAnonymous } from '../../rbac/access';
import { refreshCookie } from '../session/refresh-cookie';
import { MfaSignInService } from './mfa-sign-in.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Step two.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     POST /auth/mfa     a challenge and a code, in exchange for a session
 *
 * ⚠️ **`@AllowAnonymous`, and anonymous is not "open".** The credential is the challenge
 * token in the body and the guard has no way to read it — the same shape `POST
 * /auth/password` and `POST /auth/refresh` both document. The challenge is signed with a key
 * derived apart from the session secret precisely so it *cannot* be presented as a bearer
 * token, which is why it travels in the body rather than in `Authorization`.
 *
 * ⚠️ `no-store`. The body carries a bearer credential on the way out and a challenge on the
 * way in; a proxy or a browser cache holding either hands somebody else a session.
 */

const completeSchema = z.strictObject({
  challengeToken: z.string().min(1).max(4096),
  /**
   * Six digits, or a twelve-character recovery code — one field, because the person typing
   * has one box in front of them and knows which they are using. The service tells them
   * apart by shape and refuses both the same way.
   */
  code: z.string().trim().min(1).max(64),
});

type CompleteBody = z.infer<typeof completeSchema>;

export interface MfaCompleteResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  /**
   * ⭐ How much of the recovery path is left, on the way in.
   *
   * Zero means the gate is up and there is no way through it — the next screen has to be the
   * one that issues fresh codes. Reporting it here rather than making the client ask is what
   * keeps somebody who just spent their last code from finding out the next time they lose a
   * phone.
   */
  readonly recoveryCodesRemaining: number;
}

@Controller('auth')
export class MfaController {
  constructor(private readonly mfa: MfaSignInService) {}

  @Post('mfa')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowAnonymous(
    'the credential is the challenge token in the body — this route completes a sign-in, so ' +
      'by definition the caller holds no session for the guard to read',
  )
  async complete(
    @Req() request: Request,
    @Res() response: Response,
    @Body(new ZodBodyPipe(completeSchema)) body: CompleteBody,
  ): Promise<void> {
    const { session, recoveryCodesRemaining } = await this.mfa.complete({
      challengeToken: body.challengeToken,
      code: body.code,
      /* Same fallback chain as step one, and it fails closed for the same reason. */
      address: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      userAgent: request.get('user-agent'),
    });

    response.setHeader(
      'Set-Cookie',
      refreshCookie(session.refreshToken, session.refreshTokenExpiresAt),
    );

    response.status(200).json({
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      recoveryCodesRemaining,
    } satisfies MfaCompleteResponse);
  }
}
