import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { AllowAnonymous } from '../../rbac/access';
import { PASSWORD_MAX_LENGTH } from './password.contract';
import { PasswordResetService, type ResetAccepted } from './password-reset.service';

/**
 * `z.string()` and not `.email()`, for the reason `password.contract.ts` gives about the
 * sign-in body: a format rule answers "that is not a valid address" for an input this
 * endpoint is otherwise required to be silent about.
 */
const requestSchema = z.strictObject({ email: z.string().min(1).max(320) });

const completeSchema = z.strictObject({
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/**
 * The two halves of a forgotten password.
 *
 * Both `@AllowAnonymous`, and both for the definitional reason rather than by omission:
 * somebody who cannot sign in cannot present a session, and that is the whole situation
 * these endpoints exist for.
 */
@Controller('auth/password')
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  /**
   * 202, and the body says nothing.
   *
   * Accepted rather than 200 OK because "we have taken your request" is the honest verb —
   * whether a message was sent depends on facts the caller may not learn. The same body comes
   * back for a real address, an unknown one, an unverified one and a suspended account.
   */
  @Post('reset-request')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @AllowAnonymous(
    'somebody who has forgotten their password has no session by definition — and the ' +
      'response is identical whether or not the address belongs to anybody',
  )
  async request(
    @Req() request: Request,
    @Body(new ZodBodyPipe(requestSchema)) body: { email: string },
  ): Promise<ResetAccepted> {
    return this.resets.request({
      email: body.email,
      address: request.ip ?? request.socket.remoteAddress ?? 'unknown',
    });
  }

  /**
   * 204 — the password is set and there is nothing to return.
   *
   * ⚠️ Deliberately **not** a session. Signing somebody in on the strength of a link that
   * arrived by email would make a mailbox a credential; the person types the new password
   * once more on the sign-in form, which is also the moment they find out it works.
   *
   * Every session the account had is revoked inside the service, so a reset performed
   * because somebody else had the password actually ends their access.
   */
  @Post('reset')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @AllowAnonymous('the credential is the one-shot token in the body, which the guard cannot read')
  async complete(
    @Req() request: Request,
    @Body(new ZodBodyPipe(completeSchema)) body: { token: string; password: string },
  ): Promise<void> {
    await this.resets.complete({
      token: body.token,
      password: body.password,
      address: request.ip ?? request.socket.remoteAddress ?? 'unknown',
    });
  }
}
