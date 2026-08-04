import { APPLE_ENDPOINTS, appleProvider } from './apple.provider';
import { FACEBOOK_ENDPOINTS, facebookProvider } from './facebook.provider';
import { GOOGLE_ENDPOINTS, googleProvider } from './google.provider';
import { LINE_ENDPOINTS, lineProvider } from './line.provider';
import type { ProviderAdapter, ProviderEndpoints, ProviderName } from './provider.types';

/**
 * The four adapters, and the endpoints each ships with.
 *
 * Two maps rather than one object per provider, because they have different lifetimes: the
 * adapter is code and is fixed at build time, the endpoints are data and a test needs to
 * point them at a server it controls. Keeping the endpoints out of the adapter is what
 * makes the whole flow — authorisation URL, code exchange, id_token signature, JWKS
 * rotation — exercisable end to end against a fake provider, without a single `if
 * (NODE_ENV === 'test')` anywhere in the production path.
 *
 * There is deliberately no way to override an endpoint from the environment. A variable
 * that repoints a provider's token URL is a variable that turns a leaked deploy
 * configuration into a credential exfiltration channel, and the thing it would have bought
 * — testability — is already bought by `OAuthConfig` being a value the caller constructs.
 */

export const PROVIDER_ADAPTERS: ReadonlyMap<ProviderName, ProviderAdapter> = new Map([
  ['line', lineProvider],
  ['google', googleProvider],
  ['facebook', facebookProvider],
  ['apple', appleProvider],
] as const);

export const DEFAULT_ENDPOINTS: ReadonlyMap<ProviderName, ProviderEndpoints> = new Map([
  ['line', LINE_ENDPOINTS],
  ['google', GOOGLE_ENDPOINTS],
  ['facebook', FACEBOOK_ENDPOINTS],
  ['apple', APPLE_ENDPOINTS],
] as const);

export function adapterFor(name: ProviderName): ProviderAdapter {
  const adapter = PROVIDER_ADAPTERS.get(name);
  if (adapter === undefined) {
    // Unreachable while `ProviderName` and the map above agree; thrown rather than
    // non-null-asserted, because a `!` here would make a future fifth provider a runtime
    // `undefined` somewhere further downstream instead of a clear failure at the lookup.
    throw new Error(`no OAuth adapter for provider "${name}"`);
  }
  return adapter;
}

export * from './provider.types';
