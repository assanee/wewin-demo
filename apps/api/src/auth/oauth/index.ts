/**
 * What the rest of the app may use.
 *
 * Deliberately small. `OAuthModule` and its options are how the flows are wired in; the
 * session seam is how another module plugs into the end of a sign-in — the routes declare
 * their own access with `src/rbac`'s `@AllowAnonymous`, so there is nothing to re-export
 * for the boot audit. Everything else — the state service, the linking rule, the provider
 * adapters, the cookie attributes — stays inside, because each of them is one half of a
 * check that only means anything with the other half beside it.
 */

export { OAuthModule, type OAuthModuleOptions } from './oauth.module';
export {
  OAUTH_CONFIG,
  OAuthConfigError,
  callbackPath,
  parseOAuthConfig,
  startPath,
  type OAuthConfig,
} from './oauth.config';
export {
  SESSION_ISSUER,
  type IssuedSession,
  type SessionIssueRequest,
  type SessionIssuer,
} from './session-issuer';
export { SessionIssuerAdapter } from './session-issuer.adapter';
export { PROVIDER_NAMES, isProviderName, type ProviderName } from './providers/provider.types';
export type { CompleteResult, OAuthFailureReason, StartResult } from './oauth.service';
export { OAuthService } from './oauth.service';
