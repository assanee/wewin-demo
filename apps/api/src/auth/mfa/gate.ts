/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ MFA IS A GATE ACROSS EVERY WAY IN — NOT A WAY IN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `account/credentials.ts` counts **ways in**: a password with somewhere to send a reset,
 * plus each linked provider. A TOTP app is neither — it never signs anybody in on its own,
 * it stands in front of whichever credential did. Adding it to that count would be
 * arithmetic over two different kinds of thing, and it would make "you may not unlink your
 * last provider" pass for an account whose only remaining way in cannot authenticate anyone.
 *
 * ── ⚠️ The lockout the existing rule cannot see ──────────────────────────────
 *
 * A person with a password, a verified address and MFA on has `remainingWaysIn === 1`. Lose
 * the phone and they are outside: the credential works, the reset link arrives, and the gate
 * does not open. The rule that protects them reports that everything is fine, because from
 * where it stands everything is.
 *
 * So the gate carries its own invariant, and it is the mirror of the first:
 *
 *   ⭐ **A gate that is up must have a way through.**
 *
 * Enabling MFA requires recovery codes that exist and are unused. Spending the last one is
 * *allowed* — see `redeemLeaves` — because refusing it would lock somebody out at the exact
 * moment they are proving they own the account.
 *
 * An administrator can always disable MFA, so nobody is permanently locked out. That is a
 * support ticket rather than a design, and a design that leans on it is one whose honest
 * description of the recovery path is "telephone the office".
 *
 * No database and no I/O in this file: these are the rules, stated where they can be proved.
 */

/**
 * ⚠️ Two, not one.
 *
 * A single code is a way through that one typo destroys, and the invariant is a recovery
 * *path* rather than a recovery *code*. One is not a path — it is a coin toss taken by
 * somebody already locked out, reading from a piece of paper, in a hurry.
 */
export const MINIMUM_RECOVERY_CODES_TO_ENABLE = 2;

/** Below this the screen starts saying so, well before the last one is gone. */
export const LOW_RECOVERY_CODES = 3;

export interface EnableCheck {
  readonly unusedRecoveryCodes: number;
}

/** `null` when MFA may be switched on. */
export function enableProblem(check: EnableCheck): 'no-recovery-path' | null {
  return check.unusedRecoveryCodes < MINIMUM_RECOVERY_CODES_TO_ENABLE ? 'no-recovery-path' : null;
}

export interface RedeemOutcome {
  readonly remaining: number;
  /** MFA is still on and there is no way through it. The next screen must issue new codes. */
  readonly exhausted: boolean;
  readonly low: boolean;
}

/**
 * What spending one code leaves behind.
 *
 * ⭐ Spending the **last** one goes through. Turning that request away to protect somebody
 * from a future lockout locks them out now, for certain, instead of maybe later — and they
 * are at that moment demonstrating that the account is theirs.
 *
 * `exhausted` is what the response carries instead: the gate is up, the way through is gone,
 * and the client's next screen is the one that issues a fresh set.
 */
export function redeemLeaves(unusedBefore: number): RedeemOutcome {
  /* `Math.max` against a race that redeemed twice — "-1 codes left" is not a thing to render. */
  const remaining = Math.max(0, unusedBefore - 1);

  return { remaining, exhausted: remaining === 0, low: remaining < LOW_RECOVERY_CODES };
}

export interface SecondFactorCheck {
  readonly mfaEnabled: boolean;
  /** Present for readability at the call site. It deliberately changes nothing — see below. */
  readonly unusedRecoveryCodes?: number;
}

/**
 * Whether a verified password is enough on its own.
 *
 * ⚠️ `unusedRecoveryCodes` is accepted and ignored, on purpose. The failure it exists to rule
 * out is treating *no way through the gate* as *the gate is open*: an account whose codes are
 * spent still has MFA on, and the route back is an administrator — never a sign-in that
 * quietly skips the factor because recovery ran dry. Taking the field and not reading it is
 * how that stays visible to the next person, with a test naming it.
 */
export function secondFactorProblem(check: SecondFactorCheck): 'second-factor-required' | null {
  return check.mfaEnabled ? 'second-factor-required' : null;
}
