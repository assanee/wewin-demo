import { hmacKeyFromSecret, verifyIdToken } from '../jwt';
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
 * LINE Login v2.1 — the provider that decided this build.
 *
 * Plan section 6 is explicit that a turnkey provider was not used because LINE is the
 * deciding factor and its support has to be tried rather than read off a marketing page.
 * Three things about LINE are genuinely unlike the other three, and each is a line of code
 * here rather than a paragraph in a wiki:
 *
 *   **The id_token is HS256, signed with the channel secret.** Not RS256, not a JWKS —
 *   there is no key set to fetch, and the key is the same string used as `client_secret`.
 *   That is unusual enough that a generic OIDC client configured for LINE either fails to
 *   verify or, worse, skips verification because it found no `jwks_uri` in a discovery
 *   document LINE does not publish at the standard path. It is also the reason
 *   `jwt.ts` insists the caller name the algorithm: an HS256 verifier that would accept
 *   RS256, or vice versa, is the classic confusion bug and LINE is the provider that puts
 *   both algorithms in the same codebase.
 *
 *   **The email is optional and gated on channel approval.** LINE returns `email` only if
 *   the channel has been approved for the email permission by LINE, which is a review, not
 *   a setting. `provider_identities.asserted_email` is nullable for exactly this, and the
 *   sign-in path must work with no address at all — which it does, because an account is
 *   identified by `(provider, subject)` and never by an email.
 *
 *   **`sub` is scoped to the channel.** The same person has a different `sub` in a second
 *   LINE channel, so "same user, different app" is not something this system can see, and
 *   nothing here should try.
 *
 * Not verified against the real provider: there are no LINE credentials in this
 * environment. What is encoded here is LINE's documented behaviour, exercised end to end
 * against a fake that implements it.
 */

export const LINE_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: 'https://access.line.me/oauth2/v2.1/authorize',
  tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
  issuer: 'https://access.line.me',
  jwksUrl: undefined,
  userInfoUrl: 'https://api.line.me/v2/profile',
};

export const lineProvider: ProviderAdapter = {
  name: 'line',
  callbackTransport: 'query',
  /*
   * `openid` is what makes LINE return an id_token at all; `profile` is the display name
   * and picture; `email` is the one that does nothing until the channel is approved.
   */
  scope: 'openid profile email',

  authorizationParameters(context: AuthorizationContext): Readonly<Record<string, string>> {
    return {
      nonce: context.nonce,
      /*
       * LINE shows a consent screen only when the scopes change. `prompt=consent` would
       * force it every time; not sending it is what makes a returning customer's sign-in a
       * single tap, which is the reason LINE is the funnel in Thailand at all.
       */
      bot_prompt: 'normal',
    };
  },

  async profile(context: ProfileContext): Promise<ProviderProfile> {
    const { tokens, provider, nonce, now } = context;
    if (tokens.idToken === undefined) {
      throw new ProviderError('LINE returned no id_token; the openid scope was not granted');
    }
    if (provider.secret.kind !== 'static') {
      throw new ProviderError('LINE verifies its id_token with the channel secret');
    }

    // The channel secret, twice: once as `client_secret` at the token endpoint and once as
    // the HMAC key here. Held as a KeyObject so it is never concatenated into a string that
    // could end up in a log line.
    const key = hmacKeyFromSecret(provider.secret.value);

    const claims = await verifyIdToken(tokens.idToken, {
      algorithm: 'HS256',
      issuer: provider.endpoints.issuer,
      audience: provider.clientId,
      nonce,
      keys: () => key,
      now,
    });

    const subject = readString(claims, 'sub');
    if (subject === undefined) {
      throw new ProviderError('LINE id_token has no sub');
    }

    const email = normaliseEmail(claims['email']);

    return {
      subject,
      email,
      /*
       * ⓐ Never proof of control. This is the single most important line in the file.
       *
       * LINE's id_token carries no `email_verified` claim — there is nothing here to read.
       * An earlier version inferred proof from the address merely being *present*, and a
       * red-team pass showed what that buys: a LINE `sub` the attacker controls, asserting
       * the victim's address, lands in branch 2 of identity-link.service.ts and is handed a
       * live session inside the victim's account, plus a permanent LINE identity attached
       * to it. One request, no interaction with the victim, no notification, nothing logged
       * as an incident. That is plan 6(a) reintroduced through a provider adapter.
       *
       * The argument for the old value was that LINE confirms an address before it becomes
       * the account's and only releases it to a reviewed channel. Both halves may well be
       * true. Neither has been observed here — there are no LINE credentials in this
       * environment — and the asymmetry decides it: being wrong in the `false` direction
       * costs a LINE customer one verification email once, and being wrong in the `true`
       * direction costs somebody their account. Facebook already pays the first price
       * (facebook.provider.ts) for the same reason, and the cost is known to be survivable.
       *
       * The address is not discarded. It is recorded on `provider_identities.asserted_email`
       * — what LINE claimed, when it claimed it — which is the column that exists precisely
       * so an assertion can be kept without becoming a link key. Turning this back to `true`
       * needs evidence from a real channel written into this comment, not a plausible
       * reading of a documentation page.
       */
      emailProven: false,
      displayName: readString(claims, 'name'),
    };
  },
};
