import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { CurrentScope, RequireAuthenticated, type Scope } from '../rbac';
import { AccountService } from './account.service';
import { signedIn } from './signed-in';
import {
  changePasswordSchema,
  type AccountWire,
  type ChangePasswordRequest,
} from './account.contract';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * A person's own account.
 *
 *     GET    /me/account                          addresses, providers, devices, ways in
 *     POST   /me/account/password                 change it, or set the first one
 *     DELETE /me/account/providers/:provider      unlink an OAuth account
 *     DELETE /me/account/sessions/:sessionId      sign one device out
 *     POST   /me/account/sessions/revocation      sign every *other* device out
 *
 * ── ⭐ `@RequireAuthenticated` and no permission, deliberately ───────────────────
 *
 * A permission would imply this surface can be pointed at somebody else's account. It
 * cannot: the user id comes from the verified access token on every route, and no path
 * segment or body field names a user. `/admin/users` is where acting on *other* people
 * lives, and it is behind `users.write` for exactly that reason.
 *
 * ── `no-store` on the read, because it lists devices ────────────────────────────
 *
 * The overview names the user agents somebody signs in from, which is the kind of body that
 * must not sit in a shared cache. Same header, same reason as `/me/preferences`.
 */
@Controller('me/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @contractVersion()
  @RequireAuthenticated()
  async overview(@CurrentScope() scope: Scope): Promise<AccountWire> {
    const { userId, sessionId } = signedIn(scope);
    return this.account.overview(userId, sessionId);
  }

  /*
   * 200, not Nest's default 201 for a POST. Nothing is created — an existing credential is
   * replaced, or a first one is written to a row that already exists — and the body is a
   * report about what the change did to the other devices.
   */
  @Post('password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @contractVersion()
  @RequireAuthenticated()
  async changePassword(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(changePasswordSchema)) body: ChangePasswordRequest,
  ): Promise<{ readonly otherSessionsEnded: number }> {
    const { userId, sessionId } = signedIn(scope);
    return this.account.changePassword(userId, sessionId, body);
  }

  @Delete('providers/:provider')
  @HttpCode(204)
  @contractVersion()
  @RequireAuthenticated()
  async unlink(@CurrentScope() scope: Scope, @Param('provider') provider: string): Promise<void> {
    await this.account.unlinkProvider(signedIn(scope).userId, provider);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @contractVersion()
  @RequireAuthenticated()
  async revokeOne(
    @CurrentScope() scope: Scope,
    @Param('sessionId') targetId: string,
  ): Promise<void> {
    const { userId, sessionId } = signedIn(scope);
    await this.account.revokeSession(userId, sessionId, targetId);
  }

  @Post('sessions/revocation')
  @HttpCode(200)
  @contractVersion()
  @RequireAuthenticated()
  async revokeOthers(@CurrentScope() scope: Scope): Promise<{ readonly revoked: number }> {
    const { userId, sessionId } = signedIn(scope);
    return { revoked: await this.account.revokeOtherSessions(userId, sessionId) };
  }
}

