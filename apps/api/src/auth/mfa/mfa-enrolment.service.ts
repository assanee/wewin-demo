import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { message } from '../../i18n';
import { verifyPassword } from '../password/password-hash';
import { PASSWORD_CREDENTIAL_STORE, type PasswordCredentialStore } from '../password/password.repository';
import { enableProblem } from './gate';
import { MFA_SECRET_BOX } from './mfa.tokens';
import { MfaRepository } from './mfa.repository';
import { fingerprint, formatRecoveryCode, generateRecoveryCodes } from './recovery-codes';
import { needsPassword, type MfaAction } from './reproof';
import type { SecretBox } from './secret-box';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Turning the second factor on, off, and re-issuing the way through it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⭐ The recovery codes are shown once ─────────────────────────────────────
 *
 * They come back from `confirm` and from `regenerate`, and there is no endpoint that returns
 * them again. Only their SHA-256 fingerprints are stored, so "again" is not a feature that
 * was left out — it is a thing the storage makes impossible, which is the point. A screen
 * that could re-display them would be a screen an attacker on an unlocked machine could open.
 *
 * ── ⭐ The codes come **after** the code is proved ────────────────────────────
 *
 * `begin` mints a secret and nothing else. `confirm` verifies a TOTP code and, in the same
 * transaction that raises the gate, writes and returns the recovery codes.
 *
 * The first version issued them at enrolment and showed them before anything was proved.
 * Moving them buys two things:
 *
 *   ⓵ they arrive at the moment of success rather than as an obstacle in front of it, which
 *     is when somebody is actually reading;
 *   ⓶ **they are only ever revealed to a person who has demonstrably set up an
 *     authenticator** — somebody who starts an enrolment and walks away now gets no recovery
 *     codes at all, where before they left holding ten live ones.
 *
 * ⚠️ It does *not* weaken the gate. `mfa_credentials_guard_confirm` still refuses a
 * confirmation without two unused codes; the insert simply happens first inside the same
 * transaction, where the trigger can see it.
 */
@Injectable()
export class MfaEnrolmentService {
  constructor(
    private readonly repository: MfaRepository,
    @Inject(MFA_SECRET_BOX) private readonly box: SecretBox,
    @Inject(PASSWORD_CREDENTIAL_STORE) private readonly passwords: PasswordCredentialStore,
  ) {}

  /**
   * Mint a secret. The gate stays down, and no recovery code exists yet, until `confirm`.
   *
   * Calling it twice replaces the first attempt — somebody who scanned a code, closed the
   * tab and came back should get a fresh one rather than the one they failed to save.
   */
  async begin(input: {
    readonly userId: string;
    readonly account: string;
  }): Promise<{ readonly otpauthUri: string; readonly secretBase32: string }> {
    await this.refuseIfAlreadyEnabled(input.userId);

    const secret = generateTotpSecret();
    await this.repository.putUnconfirmedSecret(input.userId, this.box.seal(secret));

    /* No recovery codes here. See the class comment — they come with the confirmation. */
    return {
      otpauthUri: otpauthUri({ issuer: 'WEWIN', account: input.account, secret }),
      /* Shown beside the QR, for a phone whose camera will not cooperate. */
      secretBase32: base32Encode(secret),
    };
  }

  /**
   * Raise the gate, on proof that the secret arrived intact.
   *
   * ⚠️ No password. The code is the proof — see `reproof.ts`. Demanding both asks for two
   * proofs to raise a gate that one proof passes every day afterwards.
   */
  async confirm(userId: string, code: string): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const credential = await this.repository.findCredential(userId);

    if (credential === undefined) {
      throw AppError.conflict(message('error.mfa.not_enrolling'));
    }
    if (credential.confirmedAt !== null) {
      throw AppError.conflict(message('error.mfa.already_enabled'));
    }

    const verified = verifyTotp({
      secret: this.box.open(credential.secretSealed),
      code,
      atMs: Date.now(),
      lastAcceptedStep: credential.lastAcceptedStep,
    });

    if (!verified.ok) throw AppError.unauthenticated(message('error.auth.second_factor_rejected'));

    const codes = generateRecoveryCodes();

    /*
     * ⚠️ Checked here as well as by the trigger, and the numbers must agree.
     *
     * `enableProblem` is the same rule `mfa_credentials_guard_confirm` enforces — two unused
     * codes minimum. Asking it against the set about to be written means a generator that
     * ever produced fewer gives a sentence rather than a 500 from the database.
     */
    if (enableProblem({ unusedRecoveryCodes: codes.length }) !== null) {
      throw AppError.conflict(message('error.mfa.no_recovery_path'));
    }

    await this.repository.confirm(userId, verified.step, codes.map(fingerprint));

    /* ⭐ The one and only time these are readable. Nothing stores them but their hashes. */
    return { recoveryCodes: codes.map(formatRecoveryCode) };
  }

  /**
   * Turn it off.
   *
   * ⚠️ Costs the password — `reproof.ts` — because it is the one action here that leaves the
   * account less protected than it found it, and an unlocked machine is otherwise a way to
   * strip a second factor and walk away with only what was already on the screen.
   */
  async disable(userId: string, password: string): Promise<void> {
    await this.reprove(userId, 'disable', password);
    await this.repository.disable(userId);
  }

  /**
   * A fresh set, replacing every unused code.
   *
   * ⚠️ Also costs the password, and that is the surprising one. Nothing is weakened — the
   * account still has MFA and still has ten codes — but the old set dies and the new one is
   * on screen for whoever asked, which is ten permanent entries into an account somebody
   * borrowed for a minute.
   */
  async regenerate(userId: string, password: string): Promise<readonly string[]> {
    await this.reprove(userId, 'regenerate-codes', password);

    const codes = generateRecoveryCodes();
    await this.repository.replaceRecoveryCodes(userId, codes.map(fingerprint));

    return codes.map(formatRecoveryCode);
  }

  /**
   * The password check the costly actions share.
   *
   * ⚠️ **`needsPassword` decides, not the call site.** A method that simply verified the
   * password would put the policy in four places; asking the table means adding a fifth
   * action gets the safe answer by default — see `reproof.ts` on why the unknown case costs.
   */
  private async reprove(userId: string, action: MfaAction, password: string): Promise<void> {
    if (!needsPassword(action)) return;

    const credential = await this.passwords.findByUserId(userId);

    /*
     * An account with no password at all — provider-only — cannot satisfy this, and that is
     * the honest answer rather than a hole: the way to turn MFA off without a password is an
     * administrator, which is a person who can be asked why.
     */
    if (credential?.passwordHash == null) {
      throw AppError.conflict(message('error.mfa.needs_a_password'));
    }

    if (!(await verifyPassword(credential.passwordHash, password))) {
      throw AppError.unauthenticated(message('error.auth.credentials_rejected'));
    }
  }

  /**
   * `begin` is for accounts that have no gate up.
   *
   * Re-enrolling over a *confirmed* credential would replace a working second factor with an
   * unconfirmed one — and since `isRequired` reads `confirmed_at`, the gate would drop for
   * however long the person took to scan the new code. Turning it off is `disable`, which
   * costs a password; this refuses rather than becoming a cheaper way to do the same thing.
   */
  private async refuseIfAlreadyEnabled(userId: string): Promise<void> {
    const credential = await this.repository.findCredential(userId);

    if (credential?.confirmedAt != null) {
      throw AppError.conflict(message('error.mfa.already_enabled'));
    }
  }
}
