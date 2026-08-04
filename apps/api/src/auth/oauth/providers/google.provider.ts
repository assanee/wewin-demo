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
 * Google — the ordinary case, and the one plan 6(a) is written about.
 *
 * The pre-hijacking attack in the plan uses Google by name for a reason: it is the provider
 * whose `email_verified` claim is genuinely trustworthy, which makes it the one a system is
 * most tempted to merge on. "Google says this address is verified, so log them into the
 * account that already has it" is correct only if the *other* account also proved it, and
 * the whole of ⓐ is that distinction. Nothing in this file makes that decision;
 * `identity-link.service.ts` does, and this file's only job is to report honestly whether
 * the claim was there.
 *
 * Two smaller notes:
 *
 *   `iss` is `https://accounts.google.com` and not the `accounts.google.com` some older
 *   documentation shows. Both have been issued historically; this accepts one, and a
 *   mismatch is a rejected login rather than a widened check.
 *
 *   Keys rotate. `jwks.ts` handles the rotation window, and this is the provider that makes
 *   it necessary — Google publishes several RSA keys and retires them on its own schedule.
 */

export const GOOGLE_ENDPOINTS: ProviderEndpoints = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  issuer: 'https://accounts.google.com',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
};

export const googleProvider: ProviderAdapter = {
  name: 'google',
  callbackTransport: 'query',
  scope: 'openid email profile',

  authorizationParameters(context: AuthorizationContext): Readonly<Record<string, string>> {
    return {
      nonce: context.nonce,
      /*
       * No `access_type=offline` and no `prompt=consent`. Both exist to obtain a refresh
       * token for calling Google's APIs later; this flow only needs to know who the person
       * is. Asking for offline access we would never use is a consent screen that says we
       * keep access after the customer closes the tab, which is not true.
       */
    };
  },

  async profile(context: ProfileContext): Promise<ProviderProfile> {
    const { tokens, provider, nonce, jwks, now } = context;
    if (tokens.idToken === undefined) {
      throw new ProviderError('Google returned no id_token');
    }
    const { jwksUrl } = provider.endpoints;
    if (jwksUrl === undefined) {
      throw new ProviderError('Google requires a JWKS URL to verify its id_token');
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
      throw new ProviderError('Google id_token has no sub');
    }

    const email = normaliseEmail(claims['email']);
    /*
     * ⓐ `=== true` and not truthiness. A Google Workspace account whose administrator has
     * not verified the domain returns `email_verified: false`, and a value of `"false"` —
     * a non-empty string — is truthy in JavaScript. The difference between `if (verified)`
     * and this line is the difference between reading a claim and reading a type coercion.
     */
    const verified = claims['email_verified'] === true;

    return {
      subject,
      email,
      emailProven: email !== undefined && verified,
      displayName: readString(claims, 'name'),
    };
  },
};
