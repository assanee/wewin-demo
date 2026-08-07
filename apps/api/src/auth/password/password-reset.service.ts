import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { count, message } from '../../i18n';
import { EMAIL_TRANSPORT } from '../../notifications/notifications.tokens';
import type { EmailTransport } from '../../notifications/channels/transports/email-transport';
import { hashSecret, mintSecret } from '../session/secrets';
import { hashPassword } from './password-hash';
import { assertPasswordAcceptable } from './password.contract';
import {
  PASSWORD_RESET_STORE,
  type PasswordResetStore,
  type ResetTargetRow,
} from './password-reset.repository';
import { RESET_THROTTLE, type SignInThrottle } from './sign-in-throttle.token';

export interface PasswordResetConfig {
  /** `From:` on the message. */
  readonly from: string;
  /** The page that takes `?token=`. `PASSWORD_RESET_URL_BASE`, e.g. `https://…/reset`. */
  readonly resetUrlBase: string;
}

export const PASSWORD_RESET_CONFIG = Symbol('wewin.auth.passwordResetConfig');

/**
 * How long a link lives.
 *
 * ⚠️ This module's own number, not a plan 13 answer. One hour: long enough for a message to
 * clear a slow mail server and for somebody to read it after a meeting, short enough that a
 * forwarded email or a shared laptop stops being a way in by the afternoon.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60_000;

export interface ResetRequest {
  readonly email: string;
  readonly address: string;
}

export interface ResetCompletion {
  readonly token: string;
  readonly password: string;
  readonly address: string;
}

/** Deliberately empty and deliberately identical for every outcome. See `request`. */
export interface ResetAccepted {
  readonly accepted: true;
}

/**
 * Forgotten passwords.
 *
 * ── ⭐ Why the email is sent directly and not queued ──────────────────────────────
 *
 * The obvious home for an outgoing message here is `notifications` — there is a worker, a
 * retry policy, a dead queue and a template registry. It cannot be used, and the reason is
 * structural rather than a preference:
 *
 *   `notifications.order_id` is **NOT NULL**. Every row in that table belongs to an order,
 *   and a password reset belongs to a person. There is no shape for it.
 *
 *   The row holds a `template_key`, not a body — the worker renders from the order at send
 *   time. A reset link is a *secret*, and there is nowhere in that row to put one.
 *
 * Which is the good outcome, because the alternative would have been worse than
 * inconvenient. `GET /admin/notifications` requires only `orders.read`. An outbox that could
 * carry a reset link would have made `orders.read` sufficient to take over any staff
 * account, and `auth_tokens.token_hash`'s `digestIsHex` CHECK — which exists so the database
 * never holds the secret — would have been undone by a second copy sitting in a queue.
 *
 * The cost is honest and worth stating: **no retry, no dead-letter row.** A transport failure
 * is logged and the caller is told nothing (see below), so an operator finds out from the log
 * and the person finds out by not receiving anything and asking again.
 *
 * ── One answer, whatever happened ────────────────────────────────────────────────
 *
 * `request` resolves the same way for a verified address, an unverified one, an address that
 * belongs to nobody, a suspended account, and a mail server that is refusing connections. A
 * reset form that distinguished any of those would be the account enumerator that
 * `PasswordSignInService` was carefully built not to be — arriving through a different door.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(PASSWORD_RESET_STORE) private readonly store: PasswordResetStore,
    @Inject(EMAIL_TRANSPORT) private readonly mail: EmailTransport,
    @Inject(RESET_THROTTLE) private readonly throttle: SignInThrottle,
    @Inject(PASSWORD_RESET_CONFIG) private readonly config: PasswordResetConfig,
  ) {}

  async request(input: ResetRequest): Promise<ResetAccepted> {
    const email = input.email.trim().toLowerCase();

    /*
     * Throttled, and this one is not about guessing. An unauthenticated endpoint that puts a
     * message in somebody else's inbox as fast as it can be called is a mail cannon, and the
     * victim is a person who did nothing but own an address the attacker knows.
     */
    const refusal = this.throttle.check(email, input.address);
    if (refusal !== undefined) {
      throw new AppError(
        'TOO_MANY_REQUESTS',
        429,
        message('error.auth.too_many_attempts', {
          minutes: count(Math.ceil(refusal.retryAfterSeconds / 60)),
        }),
        { reason: 'too-many-attempts', retryAfterSeconds: refusal.retryAfterSeconds },
      );
    }
    // Counted whether or not an account was found — a counter that only moved for real
    // addresses would itself be an oracle, readable by timing how long the limit takes to hit.
    this.throttle.failed(email, input.address);

    const target = await this.store.findResetTarget(email);
    if (target !== undefined && target.status === 'active') await this.send(target);

    return { accepted: true };
  }

  async complete(input: ResetCompletion): Promise<void> {
    /*
     * ⚠️ Validated **before** the token is consumed. The other order burns the link on a
     * typo: the person is then holding an email whose link no longer works, no new password,
     * and no way forward except to ask for another one.
     */
    assertPasswordAcceptable(input.password);

    const row = await this.store.consumeToken(hashSecret(input.token), new Date());
    if (row === undefined || row.status !== 'active') throw PasswordResetService.rejected();

    await this.store.writePassword(row.userId, await hashPassword(input.password));

    /*
     * ⭐ And every session ends. The reason somebody resets a password is usually that
     * somebody else has it — changing the credential while leaving a ninety-day refresh
     * token alive answers the wrong half of that, invisibly, while the victim believes they
     * have locked the door.
     */
    await this.store.revokeSessions(row.userId);
  }

  private async send(target: ResetTargetRow): Promise<void> {
    const token = mintSecret();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.store.issueToken({ userId: target.userId, tokenHash: hashSecret(token), expiresAt });

    const link = `${this.config.resetUrlBase}?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(RESET_TOKEN_TTL_MS / 60_000);

    try {
      await this.mail.send({
        from: this.config.from,
        to: target.address,
        subject: 'ตั้งรหัสผ่านใหม่สำหรับบัญชี WEWIN',
        body:
          `เรียน ${target.displayName ?? 'ผู้ใช้งาน'}\n\n` +
          `มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชีนี้ กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ ` +
          `ลิงก์นี้ใช้ได้ครั้งเดียวและหมดอายุใน ${String(minutes)} นาที\n\n` +
          `${link}\n\n` +
          'หากท่านไม่ได้เป็นผู้ขอ ไม่ต้องดำเนินการใด ๆ รหัสผ่านเดิมยังใช้งานได้ตามปกติ\n' +
          'เมื่อตั้งรหัสผ่านใหม่แล้ว ระบบจะออกจากระบบทุกอุปกรณ์เพื่อความปลอดภัย\n\n' +
          'WEWIN180',
        messageId: `reset-${hashSecret(token).slice(0, 32)}`,
        headers: { 'X-Wewin-Purpose': 'password-reset' },
      });
    } catch (error) {
      /*
       * Swallowed on purpose. This method's caller answers identically for an address that
       * does not exist, so letting a transport failure become a 500 would say "this address
       * is real and something went wrong for it" — the enumeration oracle arriving through
       * the error path. The token stays issued and unusable, which expires on its own.
       */
      this.logger.error(`could not send a password reset to ${target.userId}: ${String(error)}`);
    }
  }

  /**
   * Unknown, spent, expired, or belonging to an account that may not sign in — one answer.
   *
   * 400 and not 404: a link that was valid an hour ago is not a page that does not exist,
   * and the person holding it needs to be told to ask for another one rather than to wonder
   * whether they mistyped the address.
   */
  private static rejected(): AppError {
    return AppError.badRequest(message('error.auth.reset_token_rejected'), {
      reason: 'reset-token-rejected',
    });
  }
}
