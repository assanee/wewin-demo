import { describe, expect, it } from 'vitest';

import {
  PUBLIC_SCOPE,
  describeScope,
  guestScope,
  matchScope,
  scopeHolds,
  systemScope,
  userScope,
  type Scope,
} from '../../src/rbac/scope';

/**
 * The guest scope, and the mechanism that stops anybody forgetting it.
 *
 * Plan section 6: the anonymous visitor has no user, no group and no permission, and is
 * the main funnel. The requirement is not that a guest scope exists — that is one type
 * alias — but that a query written without one does not compile. The `@ts-expect-error`
 * below is the assertion that carries it: `pnpm typecheck` covers `tests/`, so if
 * `ScopeHandlers` ever gains an optional key that call starts compiling, the expectation
 * of an error is unsatisfied, and the typecheck fails. It is a test that fails when the
 * fix is removed, in the only way a compile-time guarantee can be tested.
 */

const GUEST = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e12';

const CLERK = userScope({
  userId: 'u1',
  sessionId: 's1',
  groupIds: ['g1'],
  permissions: new Set(['orders.read'] as const),
});

const SCOPES: readonly Scope[] = [CLERK, guestScope(GUEST), PUBLIC_SCOPE, systemScope('permission sync at boot')];

describe('Scope', () => {
  it('dispatches every variant to its own branch', () => {
    expect(SCOPES.map((scope) => matchScope(scope, {
      user: (user) => `user ${user.userId}`,
      guest: (guest) => `guest ${guest.guestId}`,
      public: () => 'public',
      system: (system) => `system ${system.reason}`,
    }))).toStrictEqual([
      'user u1',
      `guest ${GUEST}`,
      'public',
      'system permission sync at boot',
    ]);
  });

  it('will not compile a scoped operation that forgets the guest', () => {
    const scope: Scope = PUBLIC_SCOPE;

    const attempt = (): string =>
      // @ts-expect-error — `guest` is missing, which is the leak this module exists to
      // prevent: a query builder that silently applied no filter to the funnel.
      matchScope(scope, {
        user: () => 'user',
        public: () => 'public',
        system: () => 'system',
      });

    // Called so the assertion is about a real value and not only about the type: with a
    // handler missing, the switch reaches a branch that is not there.
    expect(attempt()).toBe('public');
  });

  describe('scopeHolds', () => {
    it('answers from the resolved set for a user', () => {
      expect(scopeHolds(CLERK, 'orders.read')).toBe(true);
      expect(scopeHolds(CLERK, 'orders.refund')).toBe(false);
    });

    it('gives a guest nothing — a cart is not a permission', () => {
      expect(scopeHolds(guestScope(GUEST), 'orders.read')).toBe(false);
    });

    it('gives the public nothing', () => {
      expect(scopeHolds(PUBLIC_SCOPE, 'catalog.read')).toBe(false);
    });

    it('gives the process itself everything, because it is the process', () => {
      expect(scopeHolds(systemScope('outbox'), 'orders.refund')).toBe(true);
    });
  });

  it('describes a scope with ids only — never an address or a token', () => {
    expect(SCOPES.map(describeScope)).toStrictEqual([
      'user:u1',
      `guest:${GUEST}`,
      'public',
      'system(permission sync at boot)',
    ]);
  });
});
