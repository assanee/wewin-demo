import type { OAuthHttp } from '../http';
import type { JwksCache } from '../jwks';

/**
 * What a provider has to answer, and nothing else.
 *
 * The four adapters differ more than a list of endpoints would suggest — LINE signs its
 * id_token with a symmetric key, Facebook does not issue one at all, Apple posts the
 * callback back cross-site and hands over the customer's name exactly once — so the shared
 * shape is deliberately narrow: give me the authorisation parameters, and turn a token
 * response into a subject and an email claim I am allowed to reason about.
 *
 * The one field worth reading twice is `emailProven` on `ProviderProfile`. It is not "did
 * the provider send an email"; it is "does this count as proof that the person in front of
 * us can read that mailbox". Fix ⓐ (plan 6(a)) turns on exactly that distinction, and
 * `identity-link.service.ts` is where the consequence lives.
 */

export const PROVIDER_NAMES = ['line', 'google', 'facebook', 'apple'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * How the provider returns the customer to us.
 *
 * `form_post` is Apple's, and it is the reason the state cookie is `SameSite=None` — see
 * state-cookie.ts. Carried on the adapter rather than assumed, so the controller's POST
 * route can refuse a provider that has no business posting.
 */
export type CallbackTransport = 'query' | 'form_post';

export interface ProviderEndpoints {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  /** `iss` in the id_token. Empty for a provider that issues none (Facebook). */
  readonly issuer: string;
  readonly jwksUrl: string | undefined;
  readonly userInfoUrl: string | undefined;
}

/**
 * Apple's `client_secret` is not a secret string — it is an ES256 JWT this service signs
 * per request from a `.p8` key, and it expires. Modelling it as a variant rather than
 * "call a function that usually returns a constant" means a half-configured Apple (a key
 * id but no team id) cannot be represented at all.
 */
export type ProviderSecret =
  | { readonly kind: 'static'; readonly value: string }
  | {
      readonly kind: 'apple-jwt';
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKeyPem: string;
    };

export interface ResolvedProvider {
  readonly name: ProviderName;
  readonly clientId: string;
  readonly secret: ProviderSecret;
  /** Absolute, and byte-for-byte what is registered with the provider — they compare strings. */
  readonly redirectUri: string;
  readonly endpoints: ProviderEndpoints;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly idToken: string | undefined;
}

export interface ProviderProfile {
  /** The provider's `sub`. Opaque, stable, and the only thing that identifies the account there. */
  readonly subject: string;
  /** Lower-cased, or absent — which is normal for LINE and for Apple after the first sign-in. */
  readonly email: string | undefined;
  /**
   * ⓐ May this address be treated as proof of control?
   *
   * `true` lets `identity-link.service.ts` attach to an account that already verified the
   * same address, and — when nobody has — create a fresh account holding it *verified*,
   * which strips it from every unverified claim. `false` records the address on the
   * identity row and nothing else. Getting this wrong in the `true` direction is the
   * account-takeover; getting it wrong in the `false` direction is a customer who has to
   * click a link in an email.
   */
  readonly emailProven: boolean;
  readonly displayName: string | undefined;
}

export interface AuthorizationContext {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly provider: ResolvedProvider;
}

export interface ProfileContext {
  readonly tokens: TokenSet;
  readonly provider: ResolvedProvider;
  readonly nonce: string;
  readonly http: OAuthHttp;
  readonly jwks: JwksCache;
  /**
   * The raw callback parameters.
   *
   * Only Apple needs them, and it needs them for something no other provider does: the
   * customer's name arrives as a JSON blob in a `user` form field on the *first*
   * authorisation and never again.
   */
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly now: Date;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly callbackTransport: CallbackTransport;
  /** Space-separated, provider spelling. */
  readonly scope: string;
  /** Everything beyond the RFC 6749 five that this provider needs on the authorisation URL. */
  authorizationParameters(context: AuthorizationContext): Readonly<Record<string, string>>;
  profile(context: ProfileContext): Promise<ProviderProfile>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Providers disagree about which fields a token response has; this is the part all four share. */
export function parseTokenResponse(payload: unknown): TokenSet {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('token endpoint returned a non-object');
  }
  const record = payload as Record<string, unknown>;

  const accessToken = record['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ProviderError('token endpoint returned no access_token');
  }

  const idToken = record['id_token'];
  return {
    accessToken,
    idToken: typeof idToken === 'string' && idToken.length > 0 ? idToken : undefined,
  };
}

/**
 * Addresses are lower-cased, Unicode-composed, and otherwise left alone.
 *
 * The same rule as `user_emails` in packages/db, and the same reason for the "otherwise":
 * stripping dots or `+tags` is a Gmail-specific convention, and applying it to a corporate
 * mail server merges two people who are genuinely two people.
 *
 * ⓐ **NFC is not cosmetic.** `user_emails_one_verified_owner` is a btree index on the raw
 * text, so it compares bytes — and `å` precomposed (U+00E5) is different bytes from `a` +
 * U+030A while naming one mailbox. Without composing, two accounts can each hold a verified
 * claim on the same address, the index that the whole of fix ⓐ rests on never notices, and
 * a customer signing in with a provider that spells their address the other way silently
 * lands in a second account. `user_emails_address_nfc` (drizzle/0004_auth_hardening.sql) is
 * the other half, so a writer that skips this line is refused rather than believed.
 *
 * Order matters: lower-case first, then compose. Composition never changes case, so the
 * result satisfies both `= lower(address)` and `= normalize(address, nfc)`; doing it the
 * other way round would leave the output at the mercy of a case mapping that decomposes.
 */
export function normaliseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalised = value.trim().toLowerCase().normalize('NFC');
  return normalised.length > 0 && normalised.includes('@') ? normalised : undefined;
}

export function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const found = record[key];
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}
