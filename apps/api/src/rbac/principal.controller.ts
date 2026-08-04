import { Controller, Get } from '@nestjs/common';

import { AllowAnonymous } from './access';
import { CurrentScope } from './current-scope.decorator';
import { PERMISSION_CODES } from './permissions';
import { matchScope, type Scope, type ScopeKind } from './scope';

/**
 * What the caller is, and what the caller may do — the surface a menu is derived from.
 *
 * Plan section 6: permissions are the single source of truth and menus derive from them;
 * hiding a menu item is not authorisation. This endpoint is the *derivation*, and it is
 * worth being clear that it is not a security boundary at all — a client that ignores it
 * and calls a protected endpoint anyway gets the same 403 as a client that never asked.
 * It exists so the dashboard does not have to keep a second copy of the permission model
 * to decide what to render.
 *
 * Anonymous on purpose. A client has to be able to ask "what am I" before it knows
 * whether it is anybody, and the answer for a visitor — a guest with an empty permission
 * set — is exactly what the public site needs to render its own header. Making this route
 * require a session would mean every first page load starts with a 401.
 *
 * It reflects the caller's own scope and nothing else: there is no user id here that the
 * caller did not arrive with.
 */
export interface PrincipalResponse {
  readonly kind: ScopeKind;
  readonly userId: string | null;
  /** The cart this browser owns, if it has one. Null for a signed-in user — their cart is theirs. */
  readonly guestId: string | null;
  readonly groupIds: readonly string[];
  /** Sorted, so a client can compare two responses without sorting them first. */
  readonly permissions: readonly string[];
}

@Controller('me')
export class PrincipalController {
  @Get()
  @AllowAnonymous('a client must be able to ask what it may do before it knows whether it is anybody')
  principal(@CurrentScope() scope: Scope): PrincipalResponse {
    return matchScope<PrincipalResponse>(scope, {
      user: (user) => ({
        kind: 'user',
        userId: user.userId,
        guestId: null,
        groupIds: [...user.groupIds],
        permissions: [...user.permissions].sort(),
      }),
      guest: (guest) => ({
        kind: 'guest',
        userId: null,
        guestId: guest.guestId,
        groupIds: [],
        // Empty, always. A guest has a cart and no permissions, and a menu built from this
        // shows exactly the public site's menu — which is the correct one.
        permissions: [],
      }),
      public: () => ({ kind: 'public', userId: null, guestId: null, groupIds: [], permissions: [] }),
      /*
       * Never produced from an HTTP request (see scope.ts), so this branch exists to keep
       * the match exhaustive rather than to be served. It answers rather than throwing —
       * a 500 on the endpoint a client calls first would be the worse failure — and it
       * answers the same thing `scopeHolds` does: the process holds everything.
       */
      system: () => ({
        kind: 'system',
        userId: null,
        guestId: null,
        groupIds: [],
        permissions: [...PERMISSION_CODES],
      }),
    });
  }
}
