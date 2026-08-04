import { SetMetadata, type CustomDecorator } from '@nestjs/common';

import { isPermissionCode, type PermissionCode } from './permissions';

/**
 * What a route requires, said out loud on the route.
 *
 * Plan section 6: permissions are the single source of truth and the API enforces on
 * every endpoint. "Every" is the load-bearing word — an endpoint with no declaration is
 * not a public endpoint, it is an endpoint somebody forgot, and the boot-time audit in
 * route-registry.service.ts refuses to start the process on one. That is why
 * `AllowAnonymous` exists and why it demands a reason: the anonymous funnel is real and
 * large, but reaching it must be a sentence somebody wrote, not a decorator nobody added.
 */

export interface PermissionsAccess {
  readonly kind: 'permissions';
  /** All of them, not any of them — see RbacGuard. */
  readonly codes: readonly PermissionCode[];
}

export interface AuthenticatedAccess {
  readonly kind: 'authenticated';
}

/**
 * A caller that can own rows: a signed-in user **or** an identified guest. Never the public.
 *
 * Added in phase 5a, and it exists because the order lifecycle is the first surface where
 * the other three policies all give the wrong answer.
 *
 *   `authenticated` locks the guest out — and plan section 6 is explicit that the
 *     anonymous visitor is the main funnel: a guest configures, is quoted, and submits an
 *     order before there is an account. A quote route behind `RequireAuthenticated` is the
 *     funnel closed.
 *   `anonymous` lets the public in and, worse, *reads* as a public route in the boot
 *     audit. An order route printed as `anonymous — …` is the exact misreading plan 7.4
 *     trap 2 is about: it looks like a decision to publish and is really a decision to let
 *     the handler sort it out.
 *   `permissions` is the staff answer. A customer holds no permission over their own
 *     order and never will — ownership is not a grant, and modelling it as one would mean
 *     a row in `group_permissions` per customer.
 *
 * What this policy asserts is narrow and is worth stating exactly: **there is a principal
 * with a referent to scope rows by** — `users.id` or `guests.id`. It says nothing about
 * *which* rows, and it must not be read as though it did. The row filter is
 * `src/orders/scope`, in the query that loads the order.
 */
export interface PrincipalAccess {
  readonly kind: 'principal';
}

export interface AnonymousAccess {
  readonly kind: 'anonymous';
  readonly reason: string;
}

export type RouteAccess = PermissionsAccess | AuthenticatedAccess | PrincipalAccess | AnonymousAccess;

/** String and not symbol: Nest's `Reflector` and `SetMetadata` both take either, and a string is what shows up in a debugger. */
export const ROUTE_ACCESS_METADATA = 'wewin:rbac:route-access';

/**
 * The principal must hold *every* code listed.
 *
 * All rather than any, because "any of these" is how a route ends up reachable by the
 * weakest permission in a list somebody extended later. A route that genuinely accepts
 * two different permissions is two routes or an explicit check in the handler, where the
 * decision is visible.
 *
 * The tuple type requires at least one code: `@RequirePermissions()` with an empty list
 * would be a route that demands authentication and says it demands permissions, which
 * reads as protected and is not.
 */
export function RequirePermissions(
  ...codes: readonly [PermissionCode, ...PermissionCode[]]
): CustomDecorator {
  return SetMetadata<string, RouteAccess>(ROUTE_ACCESS_METADATA, permissionsAccess(...codes));
}

/**
 * A signed-in person, no particular permission.
 *
 * For the routes that are about the caller themselves — their own profile, their own
 * orders, signing out. The handler still has to filter by `scope.userId`; being signed in
 * is not permission to read somebody else's row, and no guard can know which row a
 * handler is about.
 */
export function RequireAuthenticated(): CustomDecorator {
  return SetMetadata<string, RouteAccess>(ROUTE_ACCESS_METADATA, authenticatedAccess());
}

/**
 * Somebody who can own rows — a signed-in user or an identified guest.
 *
 * Takes no argument on purpose. There is nothing to configure: either the handler filters
 * by the caller's referent or it does not, and if it does not, this is the wrong policy.
 * The handler still has to take `@CurrentScope()` and load through a scoped query; being a
 * principal is not permission to read somebody else's row, and no guard can know which row
 * a handler is about.
 */
export function RequirePrincipal(): CustomDecorator {
  return SetMetadata<string, RouteAccess>(ROUTE_ACCESS_METADATA, principalAccess());
}

/**
 * Deliberately reachable with no principal at all.
 *
 * The `reason` is not documentation for its own sake: it is the difference between a
 * route somebody decided to publish and a route that inherited a decorator during a
 * copy-paste. It is printed by the boot audit, so `pnpm dev` lists every anonymous route
 * and why, which is a review surface nobody has to remember to open.
 */
export function AllowAnonymous(reason: string): CustomDecorator {
  return SetMetadata<string, RouteAccess>(ROUTE_ACCESS_METADATA, anonymousAccess(reason));
}

/**
 * The same three policies as values rather than decorators, for route-declarations.ts.
 *
 * A decorator is a function that writes metadata onto a class member; the table cannot
 * apply one to a handler it does not own, so it states the policy directly. Constructors
 * and not object literals, so the two ways of saying "anonymous" stay one definition.
 */
export function anonymousAccess(reason: string): AnonymousAccess {
  return { kind: 'anonymous', reason };
}

export function authenticatedAccess(): AuthenticatedAccess {
  return { kind: 'authenticated' };
}

export function principalAccess(): PrincipalAccess {
  return { kind: 'principal' };
}

export function permissionsAccess(
  ...codes: readonly [PermissionCode, ...PermissionCode[]]
): PermissionsAccess {
  return { kind: 'permissions', codes };
}

/**
 * Metadata arrives as `unknown` — it is read off a reflection registry that any decorator
 * on any package can write to — so it is validated rather than cast.
 */
export function isRouteAccess(value: unknown): value is RouteAccess {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  const candidate = value as { kind: unknown };

  if (candidate.kind === 'authenticated') return true;
  if (candidate.kind === 'principal') return true;

  if (candidate.kind === 'anonymous') {
    return 'reason' in value && typeof (value as { reason: unknown }).reason === 'string';
  }

  if (candidate.kind === 'permissions') {
    if (!('codes' in value)) return false;
    const { codes } = value as { codes: unknown };
    return (
      Array.isArray(codes) &&
      codes.length > 0 &&
      codes.every((code: unknown) => typeof code === 'string' && isPermissionCode(code))
    );
  }

  return false;
}

/** One line for the boot log and for an audit failure message. */
export function describeAccess(access: RouteAccess): string {
  switch (access.kind) {
    case 'permissions':
      return `requires ${access.codes.join(' + ')}`;
    case 'authenticated':
      return 'requires a signed-in user';
    case 'principal':
      /*
       * The second clause is the one worth printing, and it is a limitation being stated
       * rather than a feature being advertised.
       *
       * `principal` says a caller has a referent. It says nothing about *which rows* that
       * referent reaches — and for the routes that use it, that is where all the authority
       * is: holding `orders.read` turns every order route into a view of every order in the
       * company. None of that can appear in this table, because it is decided in the query
       * (`src/orders/scope`), which is exactly where plan 7.4 trap 2 says ownership has to
       * live. A permissions review that read only the route table would conclude these
       * routes carry no permission at all, which is true of the *route* and false of the
       * feature.
       */
      return (
        'requires a principal that owns rows — a signed-in user or an identified guest; ' +
        'which rows it reaches is decided in the query, not here (orders.read / orders.write widen it)'
      );
    case 'anonymous':
      return `anonymous — ${access.reason}`;
  }
}
