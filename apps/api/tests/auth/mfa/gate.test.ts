import { describe, expect, it } from 'vitest';

import { enableProblem, redeemLeaves, secondFactorProblem } from '../../../src/auth/mfa/gate';
import { remainingWaysIn } from '../../../src/account/credentials';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ MFA IS A GATE ACROSS EVERY WAY IN — NOT A WAY IN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `credentials.ts` counts *ways in*: a password with somewhere to send a reset, and each
 * linked provider. TOTP is neither. It never signs anybody in on its own — it stands in
 * front of whichever credential did — so adding it to that count would be arithmetic about
 * two different kinds of thing.
 *
 * ⚠️ **But it creates a second lockout, and the existing rule cannot see it.** A person with
 * a password, a verified address and MFA enabled has `remainingWaysIn === 1`. Lose the
 * phone, and they are outside — with a credential that works, a reset link that arrives, and
 * a gate they cannot pass. The rule that protected them says everything is fine.
 *
 * So the gate gets its own invariant, and it is the mirror of the first:
 *
 *   ⭐ **A gate that is up must have a way through.** Enabling MFA requires recovery codes
 *      that exist and are unused. Burning the last one is allowed and is *reported*, because
 *      refusing it would lock somebody out of the account they are at that moment proving
 *      they own.
 *
 * The administrator can always disable it, so nobody is ever *permanently* locked out. That
 * is a support ticket, not a design — and a design that leans on it is one where the honest
 * description of the recovery path is "telephone the office".
 */

const ways = (options: {
  readonly hasPassword?: boolean;
  readonly providers?: readonly string[];
  readonly verifiedEmails?: number;
}) => ({
  hasPassword: options.hasPassword ?? false,
  providers: options.providers ?? [],
  verifiedEmails: options.verifiedEmails ?? 1,
});

describe('⭐ MFA does not change how many ways in there are', () => {
  it('leaves remainingWaysIn alone, because a second factor is not a first one', () => {
    /*
     * Asserted against the untouched function on purpose. The tempting change when adding
     * MFA is to teach `remainingWaysIn` about it — and that would make "you may not unlink
     * your last provider" pass for an account whose only remaining way in is a TOTP app,
     * which cannot sign anybody in at all.
     */
    expect(remainingWaysIn(ways({ hasPassword: true }))).toBe(1);
    expect(remainingWaysIn(ways({ providers: ['google'] }))).toBe(1);
  });
});

describe('⭐ enabling: a gate that is up must have a way through', () => {
  it('refuses when there are no recovery codes at all', () => {
    expect(enableProblem({ unusedRecoveryCodes: 0 })).toBe('no-recovery-path');
  });

  it('allows it once codes exist', () => {
    expect(enableProblem({ unusedRecoveryCodes: 10 })).toBeNull();
  });

  it('⚠️ refuses on one code as well as on none', () => {
    /*
     * A single code is a way through that a typo destroys. The invariant is *a recovery path*
     * rather than *a recovery code*, and one is not a path — it is a coin toss taken by
     * somebody who is already locked out and typing from a piece of paper.
     */
    expect(enableProblem({ unusedRecoveryCodes: 1 })).toBe('no-recovery-path');
    expect(enableProblem({ unusedRecoveryCodes: 2 })).toBeNull();
  });
});

describe('redeeming, and the state it leaves behind', () => {
  it('reports how many are left, so the screen can say so', () => {
    expect(redeemLeaves(10)).toStrictEqual({ remaining: 9, exhausted: false, low: false });
    expect(redeemLeaves(3)).toStrictEqual({ remaining: 2, exhausted: false, low: true });
  });

  it('⭐ allows the last code to be spent, and says the gate now has no way through', () => {
    /*
     * The case where refusing would be the cruel answer. Somebody redeeming their last code
     * is, at that moment, proving they own the account — turning them away to protect them
     * from a future lockout locks them out *now*, for certain, instead of maybe later.
     *
     * So it goes through, and `exhausted` is what the response carries: MFA is still on, the
     * way through is gone, and the next screen they see has to be the one that issues new
     * codes.
     */
    expect(redeemLeaves(1)).toStrictEqual({ remaining: 0, exhausted: true, low: true });
  });

  it('never reports a negative remainder', () => {
    // Defensive: a race that redeemed twice must not render "-1 codes left".
    expect(redeemLeaves(0)).toStrictEqual({ remaining: 0, exhausted: true, low: true });
  });
});

describe('⭐ the second factor, and what may skip it', () => {
  it('demands a second factor when the account has one enabled', () => {
    expect(secondFactorProblem({ mfaEnabled: true })).toBe('second-factor-required');
  });

  it('lets an account through when it has none', () => {
    expect(secondFactorProblem({ mfaEnabled: false })).toBeNull();
  });

  it('⚠️ still demands it when the recovery codes are exhausted', () => {
    /*
     * The failure that would undo everything: treating "no way through the gate" as "the
     * gate is open". An account whose codes are spent still has MFA on, and the way back is
     * an administrator — not a sign-in that quietly skips the factor because the recovery
     * path is empty.
     */
    expect(secondFactorProblem({ mfaEnabled: true, unusedRecoveryCodes: 0 })).toBe(
      'second-factor-required',
    );
  });
});
