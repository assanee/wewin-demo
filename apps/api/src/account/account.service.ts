import { Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import { hashPassword, verifyPassword } from '../auth/password/password-hash';
import { assertPasswordAcceptable } from '../auth/password/password.contract';
import { AccountRepository } from './account.repository';
import { remainingWaysIn, unlinkProblem } from './credentials';
import type { AccountWire } from './account.contract';

/**
 * What a signed-in person may do to their own account.
 *
 * Everything here is scoped to the caller by construction: the user id comes from the
 * verified access token and never from a path or a body, so there is no request shape that
 * reaches somebody else's settings. That is why the routes are `@RequireAuthenticated` and
 * carry no permission — a permission would imply this surface can be pointed at a *different*
 * account, and it cannot.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(private readonly repository: AccountRepository) {}

  async overview(userId: string, sessionId: string): Promise<AccountWire> {
    const account = await this.repository.overview(userId, sessionId);
    if (account === undefined) throw AppError.notFound('ไม่พบบัญชีนี้');

    return {
      ...account,
      waysIn: remainingWaysIn({
        hasPassword: account.hasPassword,
        providers: account.providers.map((provider) => provider.provider),
        verifiedEmails: account.emails.length,
      }),
    };
  }

  /**
   * Change, or set for the first time.
   *
   * ⚠️ **Which of the two it is comes from the database, not from the request.** A client
   * that omitted `currentPassword` would otherwise be choosing the easier branch for itself
   * — "I do not have one, so do not ask me" — which is precisely the claim an attacker at an
   * unlocked laptop would make.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    input: { readonly currentPassword?: string | undefined; readonly newPassword: string },
  ): Promise<{ readonly otherSessionsEnded: number }> {
    assertPasswordAcceptable(input.newPassword);

    const existing = await this.repository.passwordHashOf(userId);
    if (existing !== undefined) {
      const correct =
        input.currentPassword !== undefined &&
        (await verifyPassword(existing, input.currentPassword));

      if (!correct) {
        throw AppError.unauthenticated('รหัสผ่านปัจจุบันไม่ถูกต้อง', {
          reason: 'current-password-rejected',
        });
      }
    }

    await this.repository.writePassword(userId, await hashPassword(input.newPassword));

    /*
     * ⭐ Every *other* session ends, and this one survives.
     *
     * The reason somebody changes a password is often that they think somebody else has it.
     * Leaving the other ninety-day sessions alive answers the wrong half of that. Keeping
     * *this* one is the difference from a reset: the person is here, authenticated, and
     * signing them out of the tab they are typing in would be a punishment for good
     * housekeeping.
     */
    const otherSessionsEnded = await this.repository.revokeOthersAfterPasswordChange(
      userId,
      sessionId,
    );
    this.logger.log(`${userId} changed their password; ${String(otherSessionsEnded)} other session(s) ended`);

    return { otherSessionsEnded };
  }

  /**
   * Unlink an OAuth account.
   *
   * ⭐ Refused when it would be the last way in. The failure it prevents is silent and
   * total — see `credentials.ts` — and the check runs against what the account *would* look
   * like afterwards rather than what it looks like now.
   */
  async unlinkProvider(userId: string, provider: string): Promise<void> {
    const linked = await this.repository.listProviders(userId);
    if (!linked.some((row) => row.provider === provider)) {
      throw AppError.notFound('ไม่พบการเชื่อมต่อกับผู้ให้บริการนี้');
    }

    const problem = unlinkProblem({
      provider,
      after: {
        hasPassword: await this.repository.hasPassword(userId),
        providers: linked.filter((row) => row.provider !== provider).map((row) => row.provider),
        verifiedEmails: await this.repository.verifiedEmailCount(userId),
      },
    });

    if (problem !== null) {
      throw AppError.conflict(
        'ตัดการเชื่อมต่อนี้ไม่ได้ เพราะจะไม่เหลือวิธีเข้าสู่ระบบเลย — ตั้งรหัสผ่านก่อน แล้วจึงตัดได้',
        { reason: 'last-way-in' },
      );
    }

    const removed = await this.repository.unlinkProvider(userId, provider);
    this.logger.log(`${userId} unlinked ${provider} (${String(removed)} row(s))`);
  }

  async revokeSession(userId: string, sessionId: string, targetId: string): Promise<void> {
    if (targetId === sessionId) {
      /*
       * Refused rather than allowed, because the screen has a sign-out button three
       * centimetres away that does this *and* clears the refresh cookie. Ending the current
       * session from here would leave the browser holding a cookie the server has refused,
       * which presents as "signed in until you reload".
       */
      throw AppError.conflict('ออกจากอุปกรณ์นี้ด้วยปุ่มออกจากระบบแทน', {
        reason: 'current-session',
      });
    }

    const revoked = await this.repository.revokeSession(userId, targetId);
    if (revoked === 0) throw AppError.notFound('ไม่พบเซสชันนี้');
  }

  async revokeOtherSessions(userId: string, sessionId: string): Promise<number> {
    return this.repository.revokeOtherSessions(userId, sessionId);
  }
}
