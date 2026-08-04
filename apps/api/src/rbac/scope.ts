import type { PermissionCode } from './permissions';

/**
 * On whose behalf a request is being served — and therefore what a query may return.
 *
 * Plan section 6 is the reason this is a union and not a nullable user id. An anonymous
 * visitor has no user, no group and no permission, and is the main funnel: the whole
 * quote-cart path happens before anybody signs in. Modelling that visitor as "user id is
 * null" makes every scoped query a place where somebody writes `where user_id = $1` with
 * a null and gets either everything or nothing, silently. So there is a fourth variant
 * with a real referent — `guests.id` in the schema — that a cart row can carry a foreign
 * key to.
 *
 * Four variants, and each one exists because the other three cannot express it:
 *
 *   user    a signed-in person. Carries the permission set already resolved, so a
 *           repository never has to go and ask a second time mid-request.
 *   guest   an anonymous visitor we have an identifier for. Owns rows (a cart), holds no
 *           permissions, and is claimed by `guests.claimed_by_user_id` at sign-in.
 *   public  no principal at all: no session, no guest cookie, nothing to own rows with.
 *           A first-time visitor and every crawler. Distinct from `guest` on purpose —
 *           collapsing them means a nullable `guestId` and the same silent `where` again.
 *   system  the process acting on its own behalf: boot-time sync, workers, migrations.
 *           Never produced from an HTTP request. Carries a `reason` so that a query
 *           running without a human behind it says so in the log.
 *
 * `matchScope` below is what makes forgetting one a type error rather than a leak.
 */

export interface UserScope {
  readonly kind: 'user';
  readonly userId: string;
  /** The session the request authenticated with — one user may have several. */
  readonly sessionId: string;
  readonly groupIds: readonly string[];
  readonly permissions: ReadonlySet<PermissionCode>;
}

export interface GuestScope {
  readonly kind: 'guest';
  /** `guests.id`. A bearer capability for a cart, and nothing else — it grants no permission. */
  readonly guestId: string;
}

export interface PublicScope {
  readonly kind: 'public';
}

export interface SystemScope {
  readonly kind: 'system';
  /** Free text, for logs: 'permission sync at boot', 'notification outbox'. */
  readonly reason: string;
}

export type Scope = UserScope | GuestScope | PublicScope | SystemScope;
export type ScopeKind = Scope['kind'];

/** One value: a public scope carries no information, so there is nothing to allocate. */
export const PUBLIC_SCOPE: PublicScope = Object.freeze({ kind: 'public' });

export function guestScope(guestId: string): GuestScope {
  return { kind: 'guest', guestId };
}

export function systemScope(reason: string): SystemScope {
  return { kind: 'system', reason };
}

export function userScope(fields: {
  readonly userId: string;
  readonly sessionId: string;
  readonly groupIds: readonly string[];
  readonly permissions: ReadonlySet<PermissionCode>;
}): UserScope {
  return { kind: 'user', ...fields };
}

/**
 * Every branch, or it does not compile.
 *
 * This is the mechanism the brief asks for: a scoped query written as `matchScope(scope,
 * {...})` cannot be written without saying what the anonymous visitor sees, because the
 * handler record has no optional keys. A `switch` with a `default` would compile happily
 * while the guest case fell into whatever the default did — which, for a query builder,
 * is usually "no filter at all".
 *
 * tests/rbac/scope.test.ts pins that with a `@ts-expect-error` on a call that omits
 * `guest`: if this record ever gains an optional key, that assertion stops erroring and
 * `pnpm typecheck` fails.
 */
export interface ScopeHandlers<T> {
  readonly user: (scope: UserScope) => T;
  readonly guest: (scope: GuestScope) => T;
  readonly public: (scope: PublicScope) => T;
  readonly system: (scope: SystemScope) => T;
}

export function matchScope<T>(scope: Scope, handlers: ScopeHandlers<T>): T {
  switch (scope.kind) {
    case 'user':
      return handlers.user(scope);
    case 'guest':
      return handlers.guest(scope);
    case 'public':
      return handlers.public(scope);
    case 'system':
      return handlers.system(scope);
  }
}

/**
 * Does this principal hold a permission?
 *
 * `system` holds everything by construction — it is this process, and a background job
 * that had to be granted permissions would need somewhere to store them, which is a user
 * account with a password nobody rotates. Guests and the public hold nothing; there is no
 * "default" grant anywhere, because a permission that everybody has is not a permission.
 */
export function scopeHolds(scope: Scope, code: PermissionCode): boolean {
  return matchScope(scope, {
    user: (user) => user.permissions.has(code),
    guest: () => false,
    public: () => false,
    system: () => true,
  });
}

/**
 * A log line, not a serialisation format.
 *
 * Ids only: no token, no session secret, no email address. A user id in a log is what
 * makes "who did this" answerable; an address in a log is a copy of personal data in a
 * place with a different retention policy from the table it came from.
 */
export function describeScope(scope: Scope): string {
  return matchScope(scope, {
    user: (user) => `user:${user.userId}`,
    guest: (guest) => `guest:${guest.guestId}`,
    public: () => 'public',
    system: (system) => `system(${system.reason})`,
  });
}
