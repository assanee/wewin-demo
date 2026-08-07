import { z } from 'zod';

import { count, message } from '../../i18n';
import { AppError } from '../../common/errors/app-error';

/**
 * What `POST /auth/password` accepts, and the bounds on a password.
 *
 * ── The bounds are about this process, not about "strength" ──────────────────────
 *
 * There is no composition rule here — no upper case, no digit, no symbol. Those rules push
 * people towards `Password1!`, which is in every list, and NIST dropped them in SP 800-63B
 * for exactly that reason. The two numbers below are load-bearing for different, concrete
 * reasons:
 *
 *   **A minimum**, because argon2 makes guessing expensive per attempt and nothing makes a
 *   four-character password survive an offline attack on a stolen database dump.
 *
 *   **A maximum**, because the hash is computed *before* anything is authenticated. Without
 *   one, a request body of ten megabytes is ten megabytes of argon2 input from an
 *   unauthenticated caller — a denial of service that costs the attacker a `curl`. 1,024 is
 *   far above any passphrase and far below anything that hurts.
 *
 * ⚠️ **The minimum is this module's own number, not a plan 13 answer.** Twelve characters,
 * which is the current NIST guidance for a user-chosen secret. It is measured in *code
 * points*, so a Thai passphrase is not penalised for being three bytes a character — a
 * byte-length rule would demand four times as much of a Thai user as of an English one.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1_024;

/**
 * Counted in code points, not UTF-16 units.
 *
 * `'👍'.length` is 2 and `[...'👍'].length` is 1. The difference decides whether an emoji
 * counts once or twice towards the minimum, and the answer a person would give is once.
 */
export const passwordLength = (password: string): number => [...password].length;

export const passwordSignInSchema = z.strictObject({
  /*
   * `z.string()` and not `z.string().email()`. The address is a *lookup key* here, and a
   * format rule would answer "that is not a valid address" for an input the sign-in path is
   * otherwise required to be silent about — a shape-based enumeration oracle, arriving
   * through the validator rather than through the service. Anything that is not a stored
   * address simply fails to match, at the same cost as a wrong password.
   */
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type PasswordSignInBody = z.infer<typeof passwordSignInSchema>;

export interface PasswordSignInResponse {
  readonly accessToken: string;
  /** ISO 8601, matching `RefreshResponse` — the same client code reads both. */
  readonly accessTokenExpiresAt: string;
}

/**
 * The rule applied when a password is being *set*, which is a different moment from signing
 * in with one.
 *
 * Deliberately not applied on sign-in. An account whose password predates a raised minimum
 * must still be able to get in — refusing it would lock people out of their own accounts to
 * enforce a rule they had no chance to follow, and the honest place to ask them to change it
 * is after they are inside.
 */
export function assertPasswordAcceptable(password: string): void {
  const length = passwordLength(password);

  if (length < PASSWORD_MIN_LENGTH) {
    throw AppError.validationFailed(
      message('error.auth.password_too_short', { minimum: count(PASSWORD_MIN_LENGTH) }),
      { reason: 'password-too-short' },
    );
  }

  if (length > PASSWORD_MAX_LENGTH) {
    throw AppError.validationFailed(
      message('error.auth.password_too_long', { maximum: count(PASSWORD_MAX_LENGTH) }),
      { reason: 'password-too-long' },
    );
  }
}
