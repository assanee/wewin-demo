import { describe, expect, it } from 'vitest';

import { remainingWaysIn, unlinkProblem } from '../../src/account/credentials';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * An account must always keep at least one way back in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The account-settings screen is the only place in the application where somebody can
 * remove their *own* means of authentication, and the failure is silent and total: unlink
 * the one Google account, and there is no password to reset because there never was one.
 * `POST /auth/password/reset` needs `password_credentials` to write into; it will happily
 * create one, but the *link* only reaches a verified address — and the person is now
 * outside, looking at a login page that offers them nothing they hold.
 *
 * Same shape as `users/lockout.ts` and a different subject: that one keeps the *company*
 * able to administer itself, this one keeps a *person* able to sign in.
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

describe('counting the ways in', () => {
  it('counts a password and each linked provider', () => {
    expect(remainingWaysIn(ways({ hasPassword: true, providers: ['google', 'line'] }))).toBe(3);
    expect(remainingWaysIn(ways({ hasPassword: true }))).toBe(1);
    expect(remainingWaysIn(ways({ providers: ['google'] }))).toBe(1);
    expect(remainingWaysIn(ways({}))).toBe(0);
  });

  it('⚠️ does not count a password as usable without a verified address', () => {
    /*
     * A password with no verified address is a credential with no recovery: forget it and
     * the reset link has nowhere to go. It still *signs you in* today, which is why this is
     * a separate question from `hasPassword` — and it is why the unlink guard below asks for
     * ways *in*, not for credentials.
     */
    expect(remainingWaysIn(ways({ hasPassword: true, verifiedEmails: 0 }))).toBe(0);
  });

  it('still counts a provider when there is no verified address', () => {
    // A provider proof does not need our email at all — the provider is the recovery.
    expect(remainingWaysIn(ways({ providers: ['google'], verifiedEmails: 0 }))).toBe(1);
  });
});

describe('⭐ unlinking the last way in is refused', () => {
  it('refuses when the provider being removed is the only one', () => {
    expect(
      unlinkProblem({ provider: 'google', after: ways({ providers: [], verifiedEmails: 1 }) }),
    ).toBe('last-way-in');
  });

  it('allows it when a password remains', () => {
    expect(
      unlinkProblem({
        provider: 'google',
        after: ways({ hasPassword: true, providers: [], verifiedEmails: 1 }),
      }),
    ).toBeNull();
  });

  it('allows it when another provider remains', () => {
    expect(
      unlinkProblem({ provider: 'google', after: ways({ providers: ['line'] }) }),
    ).toBeNull();
  });

  it('refuses when the only password could never be reset', () => {
    /*
     * The case that looks safe and is not: a password exists, so "you still have a
     * password" reads as a complete answer — but with no verified address the reset link
     * has nowhere to go, and the provider being unlinked was the actual recovery.
     */
    expect(
      unlinkProblem({
        provider: 'google',
        after: ways({ hasPassword: true, providers: [], verifiedEmails: 0 }),
      }),
    ).toBe('last-way-in');
  });
});
