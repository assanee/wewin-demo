import { type Scope } from './scope';

/**
 * The seam between "who signed in" and "what may this request see".
 *
 * Authentication (sessions, OAuth, refresh rotation) is another module's job and it must
 * not have to know how permissions are resolved; authorisation is this module's job and
 * it must not have to know how a session cookie is validated. The whole contract between
 * them is one call: whatever authenticates a request calls `attachIdentity(request, …)`
 * before the guard runs, and the guard turns that identity into a `Scope`.
 *
 * A request with nothing attached is not an error and is not a 500 — it is the public
 * funnel, which is most of the traffic. The guard falls back to the guest cookie and then
 * to `public`, both of which are strictly less privileged than any identity, so a bug in
 * the authentication layer can only ever lose access, never grant it.
 */

export interface UserIdentity {
  readonly kind: 'user';
  readonly userId: string;
  readonly sessionId: string;
}

export interface GuestIdentity {
  readonly kind: 'guest';
  readonly guestId: string;
}

export type RequestIdentity = UserIdentity | GuestIdentity;

/**
 * A symbol and not `request.user`.
 *
 * `request.user` is what Passport writes, what half the middleware on npm writes, and
 * what a `@types/express` module augmentation makes `any`. A module-private symbol cannot
 * be set by accident, cannot collide, and does not exist for anything that did not import
 * this file — which for an authorisation input is the whole point.
 */
const IDENTITY = Symbol('wewin.rbac.identity');
const SCOPE = Symbol('wewin.rbac.scope');

interface RbacCarrier {
  [IDENTITY]?: RequestIdentity;
  [SCOPE]?: Scope;
}

/** Called by whatever authenticated the request, before the guard runs. */
export function attachIdentity(request: object, identity: RequestIdentity): void {
  (request as RbacCarrier)[IDENTITY] = identity;
}

export function readIdentity(request: object): RequestIdentity | undefined {
  return (request as RbacCarrier)[IDENTITY];
}

/** Written by the guard once it has resolved the identity into a scope. */
export function attachScope(request: object, scope: Scope): void {
  (request as RbacCarrier)[SCOPE] = scope;
}

export function readScope(request: object): Scope | undefined {
  return (request as RbacCarrier)[SCOPE];
}

/**
 * The guard runs on every route (there is no route it does not run on — see
 * route-registry.service.ts), so a missing scope means the handler was reached some other
 * way. Throwing beats defaulting to `public`, because a handler that reads a scope is a
 * handler that filters rows by it, and the failure mode of a wrong default there is a
 * leak rather than an error.
 */
export function requireScope(request: object): Scope {
  const scope = readScope(request);
  if (!scope) {
    throw new Error('No scope on this request: RbacGuard did not run. This is a wiring bug, not a permission failure.');
  }
  return scope;
}

/**
 * The guest cookie is read here and minted elsewhere: creating a `guests` row is a write,
 * and a guard that writes on every crawler request is a guard that fills a table with rows
 * nothing will ever claim. The cart module mints the row and sets the cookie on the
 * response that first needed one; this module only recognises what comes back.
 *
 * Its name, its attributes and its shape check all live in guest-cookie.ts, next to the
 * reasoning about `__Host-` and about what claiming does to the capability.
 */
export { guestCookieName, readGuestCookie, serialiseGuestCookie } from './guest-cookie';

interface HeaderCarrier {
  readonly headers: Readonly<Record<string, unknown>>;
}

export function cookieHeaderOf(request: HeaderCarrier): string | undefined {
  const header = request.headers['cookie'];
  return typeof header === 'string' ? header : undefined;
}
