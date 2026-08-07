import { describe, expect, it } from 'vitest';

import {
  MFA_ACCOUNT_LIMIT_DEFAULT,
  MFA_WINDOW_MS_DEFAULT,
  makeMfaThrottle,
} from '../../../src/auth/mfa/mfa-throttle';
import { SignInThrottle } from '../../../src/auth/password/sign-in-throttle';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A CORRECT PASSWORD MUST NOT REFILL THE SECOND FACTOR'S BUDGET.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the reason the second factor gets a counter of its own, and it is not the reason
 * that first comes to mind.
 *
 * `SignInThrottle.succeeded()` clears the account bucket — correctly, because somebody who
 * has just proved they know the password should not be locked out by their own earlier
 * typos. Now add a second step. An attacker holding a **stolen password** passes step one
 * *every single time*, so every attempt calls `succeeded()` and every attempt hands back a
 * fresh allowance.
 *
 * Share one counter and the second factor is not throttled at all. It looks throttled. The
 * limiter is right there in the sign-in path, its numbers are sensible, and it is
 * being reset by the attacker on each pass.
 *
 * Six digits with ±1 step of drift is three live codes out of a million. Unlimited attempts
 * turn that from unreachable into an afternoon.
 *
 * ── Not the same argument as `RESET_THROTTLE` ────────────────────────────────
 *
 * That one is separate so five wrong passwords do not spend the reset allowance — a
 * usability failure, where the standard recovery is blocked by the attempts that prove it is
 * needed. This one is separate because sharing makes the limit *vanish*, which is a
 * different kind of wrong and worth stating apart from it.
 */

const ADDRESS = '203.0.113.7';
const USER = '3346d43e-a78b-439a-bc96-f22ec6fde850';

describe('⭐ the two counters do not share', () => {
  it('⚠️ keeps counting second-factor failures while the password keeps succeeding', () => {
    /*
     * The attack, played out. Every round: the right password (step one succeeds, clearing
     * the sign-in bucket) followed by a wrong code. If the two shared a counter this loop
     * would never end.
     */
    const signIn = new SignInThrottle({
      perAccount: { limit: 5, windowMs: MFA_WINDOW_MS_DEFAULT },
      perAddress: { limit: 30, windowMs: MFA_WINDOW_MS_DEFAULT },
    });
    const mfa = makeMfaThrottle();

    for (let attempt = 0; attempt < MFA_ACCOUNT_LIMIT_DEFAULT; attempt += 1) {
      expect(signIn.check('somchai@wewin.co.th', ADDRESS), 'step one was throttled').toBeUndefined();
      signIn.succeeded('somchai@wewin.co.th', ADDRESS);

      expect(mfa.check(USER, ADDRESS), `attempt ${String(attempt)} of the code was throttled early`).toBeUndefined();
      mfa.failed(USER, ADDRESS);
    }

    /* Step one is still wide open — it has been succeeding all along. */
    expect(signIn.check('somchai@wewin.co.th', ADDRESS)).toBeUndefined();

    /* And step two has run out, which is the whole point. */
    const refused = mfa.check(USER, ADDRESS);
    expect(refused, 'the second factor never ran out of attempts').toBeDefined();
    expect(refused?.scope).toBe('account');
  });

  it('clears the second-factor bucket only when the second factor succeeds', () => {
    const mfa = makeMfaThrottle();

    for (let attempt = 0; attempt < MFA_ACCOUNT_LIMIT_DEFAULT; attempt += 1) mfa.failed(USER, ADDRESS);
    expect(mfa.check(USER, ADDRESS)).toBeDefined();

    mfa.succeeded(USER, ADDRESS);
    expect(mfa.check(USER, ADDRESS), 'a correct code did not clear the bucket').toBeUndefined();
  });

  it('counts per user, so one account under attack does not lock out another', () => {
    const mfa = makeMfaThrottle();
    const other = 'aaaaaaaa-0000-4000-8000-000000000001';

    for (let attempt = 0; attempt < MFA_ACCOUNT_LIMIT_DEFAULT; attempt += 1) mfa.failed(USER, ADDRESS);

    expect(mfa.check(USER, ADDRESS)).toBeDefined();
    expect(mfa.check(other, ADDRESS), 'a second account was locked out by the first').toBeUndefined();
  });
});

describe('the numbers', () => {
  it('⚠️ is tighter than the password limit, because the space is smaller', () => {
    /*
     * A password is drawn from a space nobody can enumerate. A TOTP code is six digits with
     * three live values at any instant — 3 in 10⁶ per guess. That is unreachable at five
     * attempts per window and reachable at a few thousand, so the limit is the control and
     * the arithmetic is why.
     */
    expect(MFA_ACCOUNT_LIMIT_DEFAULT).toBeLessThanOrEqual(5);
    expect(MFA_ACCOUNT_LIMIT_DEFAULT).toBeGreaterThanOrEqual(3);
  });

  it('holds the window long enough that retrying is a decision', () => {
    expect(MFA_WINDOW_MS_DEFAULT).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('⚠️ also counts per address, so one attacker cannot walk a list of accounts', () => {
    /*
     * Per-user alone limits the attacker to five guesses *per account* and says nothing
     * about how many accounts they may work through. The address dimension is what makes a
     * spray across the staff list run out rather than merely go slowly.
     */
    const mfa = makeMfaThrottle();

    for (let account = 0; account < 100; account += 1) {
      mfa.failed(`aaaaaaaa-0000-4000-8000-${String(account).padStart(12, '0')}`, ADDRESS);
    }

    const refused = mfa.check('bbbbbbbb-0000-4000-8000-000000000000', ADDRESS);

    expect(refused, 'a hundred failures from one address bought no restriction').toBeDefined();
    expect(refused?.scope).toBe('address');
  });
});
