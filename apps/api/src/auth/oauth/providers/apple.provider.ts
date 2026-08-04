import { verifyIdToken } from '../jwt';
import {
  ProviderError,
  normaliseEmail,
  readString,
  type AuthorizationContext,
  type ProfileContext,
  type ProviderAdapter,
  type ProviderEndpoints,
  type ProviderProfile,
} from './provider.types';

/**
 * Apple — the provider that does the most differently, and the one that sets the cookie
 * policy for all four.
 *
 * Five deviations, in the order they bite:
 *
 *   **The callback is a cross-site `POST`.** Asking for `name` or `email` forces
 *   `response_mode=form_post`, so the customer's browser arrives at our callback by
 *   submitting a form from `appleid.apple.com`. This is the reason the state cookie in
 *   state-cookie.ts is `SameSite=None; Secure`: a `Lax` cookie is not sent on a cross-site
 *   POST, so the binding that closes ⓑ would be silently missing on Apple and present
 *   everywhere else. The failure would look like an Apple-specific bug, and the tempting
 *   fix — relax the binding check — is fix ⓑ deleted.
 *
 *   **`client_secret` is a JWT we sign.** See apple-client-secret.ts.
 *
 *   **The name arrives once, outside the token.** On the first authorisation only, Apple
 *   posts a `user` form field containing JSON with the customer's name. It is not in the
 *   id_token, it is not at any endpoint, and it never comes again — if it is not read out
 *   of that one POST body it is gone. That is why `ProfileContext` carries the raw callback
 *   parameters at all.
 *
 *   **`email_verified` is sometimes the string `"true"`.** Apple has shipped it as both a
 *   boolean and a string; a strict `=== true` silently downgrades half of Apple's customers
 *   to unproven, and a truthiness check would accept the string `"false"`. Both spellings
 *   are handled explicitly below, and nothing else is accepted.
 *
 *   **The address may be a private relay.** `@privaterelay.appleid.com` is a real,
 *   deliverable, Apple-verified address that forwards. It is stored like any other: it is
 *   the address that reaches this customer, and treating it as second-class would mean
 *   refusing to send them their own order confirmations.
 *
 * Not verified against the real provider: there are no Apple credentials in this
 * environment, so the form_post round trip, the `.p8` signature Apple accepts, and whether
 * a `SameSite=None` cookie survives Safari's tracking prevention on that round trip are all
 * assumptions. They are named in the hand-off notes.
 */

export const APPLE_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: 'https://appleid.apple.com/auth/authorize',
  tokenUrl: 'https://appleid.apple.com/auth/token',
  issuer: 'https://appleid.apple.com',
  jwksUrl: 'https://appleid.apple.com/auth/keys',
  userInfoUrl: undefined,
};

export const appleProvider: ProviderAdapter = {
  name: 'apple',
  callbackTransport: 'form_post',
  /* Apple's scopes are bare words, not OIDC names: `openid` is implied and rejected if sent. */
  scope: 'name email',

  authorizationParameters(context: AuthorizationContext): Readonly<Record<string, string>> {
    return {
      nonce: context.nonce,
      /*
       * Required, not chosen. Apple refuses `response_mode=query` when the scope asks for
       * name or email, so the cross-site POST is not something this code could opt out of
       * by preferring a tidier redirect.
       */
      response_mode: 'form_post',
    };
  },

  async profile(context: ProfileContext): Promise<ProviderProfile> {
    const { tokens, provider, nonce, jwks, callbackParams, now } = context;
    if (tokens.idToken === undefined) {
      throw new ProviderError('Apple returned no id_token');
    }
    const { jwksUrl } = provider.endpoints;
    if (jwksUrl === undefined) {
      throw new ProviderError('Apple requires a JWKS URL to verify its id_token');
    }

    const claims = await verifyIdToken(tokens.idToken, {
      algorithm: 'RS256',
      issuer: provider.endpoints.issuer,
      audience: provider.clientId,
      nonce,
      keys: jwks.resolver(jwksUrl),
      now,
    });

    const subject = readString(claims, 'sub');
    if (subject === undefined) {
      throw new ProviderError('Apple id_token has no sub');
    }

    const email = normaliseEmail(claims['email']);

    return {
      subject,
      email,
      emailProven: email !== undefined && appleSaysVerified(claims['email_verified']),
      displayName: nameFromFirstAuthorisation(callbackParams['user']),
    };
  },
};

/** Both spellings Apple has shipped, and nothing else — `"false"` is not truthy here. */
function appleSaysVerified(claim: unknown): boolean {
  return claim === true || claim === 'true';
}

/**
 * The `user` field, present on the first authorisation and never again.
 *
 * Parsed defensively and never allowed to fail the login: a customer whose name Apple
 * declined to send, or sent in a shape this does not expect, still gets an account. The
 * name is a nicety; the sign-in is not.
 */
function nameFromFirstAuthorisation(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const name = (parsed as Record<string, unknown>)['name'];
  if (typeof name !== 'object' || name === null) return undefined;

  const record = name as Record<string, unknown>;
  const parts = [readString(record, 'firstName'), readString(record, 'lastName')].filter(
    (part): part is string => part !== undefined,
  );

  return parts.length > 0 ? parts.join(' ') : undefined;
}
