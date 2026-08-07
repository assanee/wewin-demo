import { SignInThrottle } from '../password/sign-in-throttle';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A COUNTER OF ITS OWN — AND NOT FOR THE OBVIOUS REASON.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SignInThrottle.succeeded()` clears the account bucket, and that is right: somebody who
 * has just proved they know the password should not be locked out by their own earlier
 * typos.
 *
 * ⚠️ Now put a second step behind it. An attacker holding a **stolen password** passes step
 * one *every time*, so every attempt calls `succeeded()`, and every attempt hands back a
 * fresh allowance. Share one counter and the second factor is not throttled at all — while
 * looking thoroughly throttled, because the limiter is right there in the sign-in path with
 * sensible numbers, being reset by the attacker on each pass.
 *
 * Six digits with ±1 step of drift is three live codes out of a million. Unlimited attempts
 * turn that from unreachable into an afternoon's work.
 *
 * ── Not `RESET_THROTTLE`'s argument ──────────────────────────────────────────
 *
 * That counter is separate so five wrong passwords do not spend the reset allowance — a
 * usability failure, where the standard recovery is blocked by the attempts that prove it is
 * needed. This one is separate because sharing makes the limit *disappear*. Same shape,
 * different failure, worth saying apart.
 *
 * ── Keyed on the user id, not the email ──────────────────────────────────────
 *
 * By the time this counter is consulted the password has been accepted and the challenge
 * names a user. Keying on the address they typed would let somebody spread attempts across
 * `Somchai@…` and `somchai@…` — a distinction `findByVerifiedEmail` erases and a `Map` does
 * not.
 */

/**
 * ⚠️ Tighter than the password limit, because the space being guessed is tiny.
 *
 * A password comes from a distribution nobody can enumerate. A TOTP code is 3 live values in
 * 10⁶ at any instant: unreachable at five attempts per window, and reachable at a few
 * thousand. The number *is* the control here in a way it is not for a passphrase.
 */
export const MFA_ACCOUNT_LIMIT_DEFAULT = 5;

/**
 * The address dimension, and it is not decoration.
 *
 * Per-user alone limits an attacker to five guesses *per account* and says nothing about how
 * many accounts they may work through. This is what makes a spray across the staff list run
 * out rather than merely proceed slowly.
 */
export const MFA_ADDRESS_LIMIT_DEFAULT = 30;

export const MFA_WINDOW_MS_DEFAULT = 15 * 60_000;

/**
 * One instance per process — which is what makes the counters mean anything.
 *
 * `SignInThrottle` is reused rather than reimplemented: the sweep-on-write, the two
 * dimensions and the `retryAfterSeconds` arithmetic are all the same problem, and a second
 * copy would be a second place for the expiry logic to drift.
 */
export function makeMfaThrottle(): SignInThrottle {
  return new SignInThrottle({
    perAccount: { limit: MFA_ACCOUNT_LIMIT_DEFAULT, windowMs: MFA_WINDOW_MS_DEFAULT },
    perAddress: { limit: MFA_ADDRESS_LIMIT_DEFAULT, windowMs: MFA_WINDOW_MS_DEFAULT },
  });
}

/** The injection token, apart from the factory — same reason `SIGN_IN_THROTTLE` has one. */
export const MFA_THROTTLE = Symbol('wewin.auth.mfaThrottle');
