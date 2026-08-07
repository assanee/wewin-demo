import { Body, Controller, Delete, Get, Header, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';

import { ZodBodyPipe } from '../../admin/zod-body.pipe';
import { CurrentScope, RequireAuthenticated, type Scope } from '../../rbac';
import { signedIn } from '../../account/signed-in';
import { LOW_RECOVERY_CODES } from './gate';
import { MfaEnrolmentService } from './mfa-enrolment.service';
import { MfaRepository } from './mfa.repository';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A person's own second factor.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     GET    /me/account/mfa               is it on, and how much recovery is left
 *     POST   /me/account/mfa/enrolment     mint a secret and ten codes — the gate stays down
 *     POST   /me/account/mfa               confirm with a code — the gate goes up
 *     DELETE /me/account/mfa               turn it off · costs the password
 *     POST   /me/account/mfa/recovery-codes  a fresh set · costs the password
 *
 * `@RequireAuthenticated` and no permission, for the reason `account.controller.ts` gives:
 * a permission would imply this could point at somebody else's account, and it cannot — the
 * user id comes from a verified token, every time.
 *
 * ⚠️ **The recovery codes come back exactly twice in this file** — from enrolment and from
 * regeneration — and there is no route that returns them again. Only fingerprints are
 * stored, so "show them to me again" is not a feature left out but a thing the storage makes
 * impossible. A screen that could re-display them is a screen somebody on an unlocked laptop
 * could open.
 *
 * ⚠️ `no-store` on every response. Two of them carry the codes themselves.
 */

const confirmSchema = z.strictObject({ code: z.string().trim().min(1).max(16) });
const passwordSchema = z.strictObject({ password: z.string().min(1).max(1024) });

type ConfirmBody = z.infer<typeof confirmSchema>;
type PasswordBody = z.infer<typeof passwordSchema>;

export interface MfaStateWire {
  readonly enabled: boolean;
  /** A secret written and never proved. The gate is **not** up — see the schema. */
  readonly enrolling: boolean;
  readonly recoveryCodesRemaining: number;
  /** Below the threshold, so the screen can say so well before the last one is gone. */
  readonly recoveryCodesLow: boolean;
  readonly confirmedAt: string | null;
}

export interface MfaEnrolmentWire {
  /** For the QR code. */
  readonly otpauthUri: string;
  /** For a phone whose camera will not cooperate. */
  readonly secretBase32: string;
  /** ⚠️ Shown once. Nothing returns these again. */
  readonly recoveryCodes: readonly string[];
}


@Controller('me/account/mfa')
export class MfaAccountController {
  constructor(
    private readonly enrolment: MfaEnrolmentService,
    private readonly repository: MfaRepository,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async state(@CurrentScope() scope: Scope): Promise<MfaStateWire> {
    const state = await this.repository.state(signedIn(scope).userId);

    return {
      enabled: state.enabled,
      enrolling: state.enrolling,
      recoveryCodesRemaining: state.unusedRecoveryCodes,
      recoveryCodesLow: state.enabled && state.unusedRecoveryCodes < LOW_RECOVERY_CODES,
      confirmedAt: state.confirmedAt?.toISOString() ?? null,
    };
  }

  /**
   * ⚠️ No password. Enrolling weakens nothing — the gate stays down until `confirm` — and
   * friction in front of turning a second factor *on* costs more than it buys. See
   * `reproof.ts`.
   */
  @Post('enrolment')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async begin(@CurrentScope() scope: Scope): Promise<MfaEnrolmentWire> {
    const userId = signedIn(scope).userId;

    /*
     * The label an authenticator shows. The user id rather than the email: this is rendered
     * into a QR code that ends up in a screenshot as often as not, and an address there is a
     * personal datum in an image nobody is tracking. `WEWIN` beside it is the issuer, so the
     * entry is still identifiable in a list.
     */
    return this.enrolment.begin({ userId, account: userId.slice(0, 8) });
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async confirm(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(confirmSchema)) body: ConfirmBody,
  ): Promise<{ readonly recoveryCodesRemaining: number }> {
    return this.enrolment.confirm(signedIn(scope).userId, body.code);
  }

  /** ⚠️ Costs the password — this is the one action that leaves the account less protected. */
  @Delete()
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async disable(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(passwordSchema)) body: PasswordBody,
  ): Promise<void> {
    await this.enrolment.disable(signedIn(scope).userId, body.password);
  }

  /**
   * ⚠️ Also costs the password, and that is the surprising one — `reproof.ts` argues it.
   * Nothing is weakened, and the old set dies while the new one is on screen for whoever
   * asked.
   */
  @Post('recovery-codes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireAuthenticated()
  async regenerate(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(passwordSchema)) body: PasswordBody,
  ): Promise<{ readonly recoveryCodes: readonly string[] }> {
    return { recoveryCodes: await this.enrolment.regenerate(signedIn(scope).userId, body.password) };
  }
}
