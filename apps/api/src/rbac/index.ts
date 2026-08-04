/**
 * What the rest of the app imports.
 *
 * Modules should reach for this file and not for the ones behind it: the guard, the audit
 * and the boot sync are wiring, and a feature module that imports `RouteRegistryService`
 * is a feature module doing authorisation by hand.
 *
 * For the authentication module specifically, the entire contract is `attachIdentity` —
 * call it once the session is validated, before the guard runs, and everything else here
 * follows from it.
 */

export {
  AllowAnonymous,
  RequireAuthenticated,
  RequirePermissions,
  RequirePrincipal,
  describeAccess,
  type AnonymousAccess,
  type AuthenticatedAccess,
  type PermissionsAccess,
  type PrincipalAccess,
  type RouteAccess,
} from './access';

export { CurrentScope } from './current-scope.decorator';

export {
  attachIdentity,
  cookieHeaderOf,
  guestCookieName,
  readGuestCookie,
  readIdentity,
  readScope,
  requireScope,
  serialiseGuestCookie,
  type GuestIdentity,
  type RequestIdentity,
  type UserIdentity,
} from './identity';

/**
 * The guest capability, for the two modules that produce or verify one.
 *
 * `mintGuestSecret` and `guestSecretHash` are exported because `POST /orders` is what mints
 * a guest (a guard that wrote a row per crawler was the alternative) and the OAuth start
 * endpoint is what carries one through a sign-in. Both need the same two functions the
 * reader uses, and a second implementation of either would be a second answer to "is this
 * cookie real".
 */
export {
  guestSecretHash,
  guestSecretMatches,
  mintGuestSecret,
  type GuestCookie,
} from './guest-cookie';

export {
  PERMISSIONS,
  PERMISSION_CODES,
  isPermissionCode,
  permissionDescription,
  type PermissionCode,
} from './permissions';

export {
  PUBLIC_SCOPE,
  describeScope,
  guestScope,
  matchScope,
  scopeHolds,
  systemScope,
  userScope,
  type GuestScope,
  type PublicScope,
  type Scope,
  type ScopeHandlers,
  type ScopeKind,
  type SystemScope,
  type UserScope,
} from './scope';

export { GuestRepository } from './guest.repository';
export { PermissionRepository, type EffectivePermissions } from './permission.repository';
export { RBAC_OPTIONS, type RbacOptions } from './rbac.options';
export { PermissionSyncService, type PermissionSyncReport } from './permission-sync.service';
export { PrincipalController, type PrincipalResponse } from './principal.controller';
export { RbacModule, type RbacModuleOptions } from './rbac.module';
export { RouteAuditError } from './route-audit.error';
export { RouteRegistryService, type RouteRecord } from './route-registry.service';
export { APPLICATION_ROUTE_ACCESS, ROUTE_DECLARATIONS, type RouteDeclaration } from './route-declarations';
