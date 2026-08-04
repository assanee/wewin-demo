import { describe, expect, it } from 'vitest';
import { USER_STATUSES, type UserStatus } from '@wewin/db/schema';

import {
  accountUsability,
  matchUserStatus,
  signInDisposition,
} from '../../src/rbac/account-status';

/**
 * The compile-time half of "forgetting to exclude the erased must fail loudly".
 *
 * The runtime half is `closed-account-routes.pg.test.ts`, which drives every guarded route
 * as a closed and an erased principal. This file covers the thing a runtime sweep cannot:
 * the *next* status, added by a migration nobody has written yet. `@ts-expect-error` is the
 * only way a compile-time guarantee can be tested — `pnpm typecheck` covers `tests/`, so if
 * `UserStatusHandlers` ever gains an optional key the call below starts compiling, the
 * expectation of an error is unsatisfied, and the typecheck fails.
 *
 * It is the same mechanism, tested the same way, as `matchScope` in scope.test.ts.
 */

describe('matchUserStatus', () => {
  it('dispatches every status to its own branch', () => {
    expect(
      USER_STATUSES.map((status) =>
        matchUserStatus(status, {
          active: () => 'active',
          suspended: () => 'suspended',
          closed: () => 'closed',
          erased: () => 'erased',
        }),
      ),
    ).toStrictEqual(['active', 'suspended', 'closed', 'erased']);
  });

  it('will not compile a decision that forgets a status', () => {
    const status: UserStatus = 'erased';

    const attempt = (): string =>
      // @ts-expect-error — `erased` is missing. A `switch` with a `default` would have
      // compiled and quietly given the tombstone whatever the default said, which for an
      // authorisation decision is whichever answer happened to be written first.
      matchUserStatus(status, {
        active: () => 'active',
        suspended: () => 'suspended',
        closed: () => 'closed',
      });

    expect(typeof attempt).toBe('function');
  });
});

describe('accountUsability', () => {
  it('admits only an active account', () => {
    expect(USER_STATUSES.filter((status) => accountUsability(status).usable)).toStrictEqual(['active']);
  });

  it('gives each refusal its own sentence', () => {
    /*
     * Not cosmetic. `EffectivePermissions` used to carry `active: boolean` and the guard said
     * one sentence for all of them, so nothing downstream could tell a reinstatable closure
     * from an irreversible erasure — and "sign in again to reopen your account" shown for an
     * erasure sends the person round a loop they can never leave.
     */
    const messages = USER_STATUSES.filter((status) => status !== 'active').map((status) => {
      const usability = accountUsability(status);
      return usability.usable ? '' : usability.message;
    });

    expect(new Set(messages).size).toBe(messages.length);
    expect(messages.every((message) => message.length > 0)).toBe(true);
  });

  it('never names the account or the person in a refusal', () => {
    // The message reaches whoever holds the token, who after a shared browser is not
    // necessarily the account holder, and a login page must not become an oracle.
    for (const status of USER_STATUSES) {
      const usability = accountUsability(status);
      if (usability.usable) continue;
      expect(usability.message).not.toMatch(/@|[0-9a-f]{8}-/);
    }
  });
});

describe('signInDisposition', () => {
  it('reopens a closure, refuses a suspension, and refuses a tombstone', () => {
    expect(USER_STATUSES.map(signInDisposition)).toStrictEqual([
      'proceed',
      // An administrator decided this one. A decision the subject can undo by signing in is
      // not a suspension.
      'refuse',
      // The customer decided this one, and proving control of the account again is the same
      // re-authentication that would have signed them in. Without this branch `closed` is a
      // cross-provider dead end with no operator surface to escape it, which is a lockout
      // wearing the word "reversible".
      'reinstate',
      // Belt, not braces: `users_erasure_is_earned` lets no UPDATE move a row out of
      // `erased`, and after the scrub there is no credential left for branches 1 or 2 to
      // match in the first place.
      'refuse',
    ]);
  });
});
