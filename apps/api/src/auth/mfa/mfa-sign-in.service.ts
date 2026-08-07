import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { count, message } from '../../i18n/message';
import { SESSION_STARTER, type SessionStarter } from '../password/session-starter';
import type { SignInThrottle } from '../password/sign-in-throttle';
import type { IssuedSession } from '../session/session.service';
import { MfaChallengeService } from './challenge';
import { redeemLeaves } from './gate';
import { MFA_THROTTLE } from './mfa-throttle';
import { MfaRepository } from './mfa.repository';
import { fingerprint, normaliseRecoveryCode } from './recovery-codes';
import { MFA_SECRET_BOX } from './mfa.tokens';
import type { SecretBox } from './secret-box';
import { verifyTotp } from './totp';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Step two: a code, or a recovery code, in exchange for a session.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⚠️ One refusal for every way this can fail ───────────────────────────────
 *
 * A challenge that has expired, a challenge that was never ours, an account whose MFA was
 * disabled in the meantime, a wrong TOTP code, a wrong recovery code, a code already spent —
 * all of them come back as the same message.
 *
 * The same reasoning `password-sign-in.service.ts` gives for its single refusal, one layer
 * further in: distinguishing them turns this endpoint into an oracle. "Your challenge has
 * expired" tells an attacker their captured token was genuine; "no second factor is enabled"
 * tells them which accounts to attack directly instead.
 *
 * ── ⭐ The throttle is consulted before anything is verified ─────────────────
 *
 * And it is `MFA_THROTTLE`, not the sign-in one. `mfa-throttle.ts` argues the case: an
 * attacker with a stolen password passes step one every time, so step one's counter is
 * cleared by `succeeded()` on every attempt and would hand back a fresh allowance for every
 * guess. Sharing makes the limit disappear while looking present.
 */
@Injectable()
export class MfaSignInService {
  constructor(
    private readonly repository: MfaRepository,
    private readonly challenges: MfaChallengeService,
    @Inject(MFA_SECRET_BOX) private readonly box: SecretBox,
    @Inject(MFA_THROTTLE) private readonly throttle: SignInThrottle,
    @Inject(SESSION_STARTER) private readonly sessions: SessionStarter,
  ) {}

  /**
   * Complete the challenge.
   *
   * Returns the session and how much of the recovery path is left, because a person who has
   * just spent their last code needs the next screen to be the one that issues more — see
   * `redeemLeaves`.
   */
  async complete(request: {
    readonly challengeToken: string;
    readonly code: string;
    readonly address: string;
    readonly userAgent: string | undefined;
  }): Promise<{ readonly session: IssuedSession; readonly recoveryCodesRemaining: number }> {
    const opened = this.challenges.verify(request.challengeToken);
    if (!opened.ok) throw MfaSignInService.rejected();

    const userId = opened.userId;

    /*
     * ⚠️ Before the credential is even read, let alone the code checked. A limiter consulted
     * after the work is a limiter that still lets the work happen — and here the work
     * includes an AES open and an HMAC per drift step.
     */
    const refusal = this.throttle.check(userId, request.address);
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

    const credential = await this.repository.findCredential(userId);

    /*
     * No credential, or one that was never confirmed. Both mean the gate is not up — and a
     * challenge was issued, so something changed between the two steps (an administrator
     * disabled it, or the person did from another device). Refused rather than waved
     * through: a sign-in that quietly skips a factor it just asked for is the failure the
     * whole feature exists to prevent, and the person can simply sign in again.
     */
    if (credential === undefined || credential.confirmedAt === null) throw MfaSignInService.rejected();

    const accepted = await this.accept(credential, request.code);
    if (accepted === null) {
      this.throttle.failed(userId, request.address);
      throw MfaSignInService.rejected();
    }

    this.throttle.succeeded(userId, request.address);

    const session = await this.sessions.start({
      userId,
      userAgent: request.userAgent ?? null,
      ip: request.address,
    });

    return { session, recoveryCodesRemaining: accepted.recoveryCodesRemaining };
  }

  /**
   * A TOTP code or a recovery code, told apart by shape and then tried.
   *
   * ⚠️ Both are attempted for anything six digits long — a recovery code is twelve
   * characters, so the shapes do not overlap, and trying the cheap one first keeps the
   * common path to one HMAC per drift step.
   */
  private async accept(
    credential: { readonly userId: string; readonly secretSealed: string; readonly lastAcceptedStep: number | null },
    code: string,
  ): Promise<{ readonly recoveryCodesRemaining: number } | null> {
    const typed = code.trim();

    if (/^[\d\s]{6,8}$/u.test(typed)) {
      const totp = verifyTotp({
        secret: this.box.open(credential.secretSealed),
        code: typed,
        atMs: Date.now(),
        lastAcceptedStep: credential.lastAcceptedStep,
      });

      if (!totp.ok) return null;

      /*
       * ⭐ The compare-and-set is what makes the code single-use across concurrent requests.
       * Two attempts with the same code both pass `verifyTotp` — the row is what breaks the
       * tie, and a `false` here means somebody else spent it first.
       */
      if (!(await this.repository.advanceStep(credential.userId, totp.step))) return null;

      return {
        recoveryCodesRemaining: await this.repository.countUnusedRecoveryCodes(credential.userId),
      };
    }

    /* Anything else is treated as a recovery code, and fails as one. */
    const normalised = normaliseRecoveryCode(typed);
    if (normalised === '') return null;

    if (!(await this.repository.redeemRecoveryCode(credential.userId, fingerprint(normalised)))) {
      return null;
    }

    /*
     * `redeemLeaves` off the count *after* spending, so `exhausted` is what the caller sees.
     * Spending the last one is allowed — refusing it locks somebody out now, for certain, at
     * the moment they are proving the account is theirs.
     */
    return {
      recoveryCodesRemaining: redeemLeaves(
        (await this.repository.countUnusedRecoveryCodes(credential.userId)) + 1,
      ).remaining,
    };
  }

  /** One refusal, for every way this can fail. See the class comment. */
  private static rejected(): AppError {
    return AppError.unauthenticated(message('error.auth.second_factor_rejected'));
  }
}
