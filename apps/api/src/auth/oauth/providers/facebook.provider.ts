import { createHmac } from 'node:crypto';

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
 * Facebook — the one that is not OpenID Connect.
 *
 * The web flow issues no id_token at all: the token endpoint returns an access token and
 * the identity comes from a Graph API call. Three consequences, all of them shaping the
 * code below.
 *
 *   **There is nothing to verify cryptographically.** No signature, no `aud`, and — the
 *   one that matters — no `nonce`. The replay protection an id_token's nonce provides has
 *   to come from somewhere else, and here it comes entirely from PKCE and from fix ⓑ's
 *   binding cookie: the code cannot be exchanged without the verifier, and the callback
 *   cannot be completed in a browser that did not start the flow. That is why neither of
 *   those is optional per-provider.
 *
 *   **`appsecret_proof`.** Facebook accepts a Graph call with a bare access token, which
 *   means a leaked token is enough. The proof — HMAC-SHA256 of the token under the app
 *   secret — makes a leaked token useless without the secret as well, and it is off by
 *   default. It is sent here because the alternative is relying on a token never leaking.
 *
 *   **ⓐ `emailProven` is always `false`, and that is the deliberate part.** Facebook does
 *   return an address and does confirm it at signup, but the Graph response carries no
 *   claim *about* the address — nothing distinguishes "confirmed" from "present", so there
 *   is nothing to read and the only honest value is `false`. The cost is real and worth
 *   naming: a customer who already has a verified account and then signs in with Facebook
 *   gets a *separate* account, and has to link them through a flow that asks them to prove
 *   the address. The alternative is granting account access on a string a provider handed
 *   over with no assertion attached, which is plan 6(a) with a different provider's name
 *   on it. `provider_identities.asserted_email` still records what Facebook said, because
 *   "what did they claim, and when" is worth having; it is just never a link key.
 *
 * Not verified against the real provider: there are no Facebook credentials in this
 * environment.
 */

const GRAPH_VERSION = 'v21.0';

export const FACEBOOK_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
  tokenUrl: `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
  issuer: '',
  jwksUrl: undefined,
  userInfoUrl: `https://graph.facebook.com/${GRAPH_VERSION}/me`,
};

export const facebookProvider: ProviderAdapter = {
  name: 'facebook',
  callbackTransport: 'query',
  /* Facebook's own spelling: comma-separated in its documentation, space-separated is accepted and is what RFC 6749 says. */
  scope: 'public_profile email',

  authorizationParameters(_context: AuthorizationContext): Readonly<Record<string, string>> {
    // Nothing beyond the standard five. Facebook has no `nonce` to send, which is the
    // whole point of the note above.
    return {};
  },

  async profile(context: ProfileContext): Promise<ProviderProfile> {
    const { tokens, provider, http } = context;
    const { userInfoUrl } = provider.endpoints;
    if (userInfoUrl === undefined) {
      throw new ProviderError('Facebook requires a Graph endpoint to resolve an identity');
    }
    if (provider.secret.kind !== 'static') {
      throw new ProviderError('Facebook signs its Graph calls with a static app secret');
    }

    const url = new URL(userInfoUrl);
    url.searchParams.set('fields', 'id,name,email');
    url.searchParams.set('access_token', tokens.accessToken);
    url.searchParams.set('appsecret_proof', appSecretProof(tokens.accessToken, provider.secret.value));

    const payload = await http.getJson(url.toString());
    if (typeof payload !== 'object' || payload === null) {
      throw new ProviderError('Facebook Graph returned a non-object');
    }
    const record = payload as Record<string, unknown>;

    const subject = readString(record, 'id');
    if (subject === undefined) {
      throw new ProviderError('Facebook Graph returned no id');
    }

    return {
      subject,
      // Absent for an account that registered with a phone number, which is common enough
      // that treating it as an error would lock those customers out entirely.
      email: normaliseEmail(record['email']),
      emailProven: false,
      displayName: readString(record, 'name'),
    };
  },
};

/**
 * `appsecret_proof`, lower-case hex.
 *
 * Deliberately not `equalsConstantTime`'s business — this value is produced, not compared,
 * and it is sent to Facebook rather than checked here.
 */
function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken, 'utf8').digest('hex');
}
