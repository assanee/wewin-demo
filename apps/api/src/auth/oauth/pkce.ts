import { equalsConstantTime, randomSecret, sha256Base64Url } from './crypto';

/**
 * PKCE (RFC 7636), S256 only.
 *
 * `plain` is not implemented and `pkce_method` in packages/db is a one-member enum for the
 * same reason: `plain` puts the verifier itself in the authorisation URL, where it lands
 * in browser history, in the provider's access logs and in any Referer header on the way,
 * which undoes the whole mechanism.
 *
 * What PKCE buys here specifically: the authorisation `code` comes back through the
 * browser, so anything that can read the callback URL — an installed extension, a proxy, a
 * log — has the code. Without the verifier that code is worth nothing, because the token
 * endpoint will not exchange it. It is a different guarantee from fix ⓑ, which is about
 * *whose* browser completed the flow, and both are needed: PKCE stops a stolen code being
 * spent, the binding cookie stops a genuine code being spent in the wrong person's browser.
 */

export interface Pkce {
  /** Secret. Lives in the httpOnly cookie and is sent only to the token endpoint. */
  readonly verifier: string;
  /** Public. `SHA256(verifier)`, sent to the provider and stored in `oauth_states`. */
  readonly challenge: string;
}

/**
 * The verifier is 32 random bytes rather than the RFC's maximum of 96 characters. base64url
 * of 32 bytes is 43 characters, which is the RFC's minimum length and exactly the width the
 * `oauth_states_pkce_challenge_shape` CHECK expects of the derived challenge.
 */
export function createPkce(): Pkce {
  const verifier = randomSecret(32);
  return { verifier, challenge: sha256Base64Url(verifier) };
}

/**
 * Does this verifier produce the challenge the row was created with?
 *
 * The provider checks this too — it is the provider's check that makes PKCE work. This one
 * is local and is about a different thing: it proves the cookie presented at the callback
 * belongs to *this* flow's row before we spend the code against the token endpoint, so a
 * mismatch is a rejected login rather than a request that leaves this service.
 */
export function verifierMatches(verifier: string, challenge: string): boolean {
  return equalsConstantTime(sha256Base64Url(verifier), challenge);
}
