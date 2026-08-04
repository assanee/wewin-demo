import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The three primitives every secret in this module is made of.
 *
 * One file rather than three call sites, because the interesting property is that they
 * agree: `randomSecret` produces base64url, `sha256Hex` produces exactly the lower-case
 * hex the `char(64)` CHECK constraints in packages/db insist on, and a raw secret is
 * therefore never a legal value for a `*_hash` column. That is deliberate — see the note
 * on `digest()` in packages/db/src/schema/auth.ts: a service that forgets to hash fails
 * on the write that did it instead of quietly storing a live credential.
 */

/**
 * 256 bits from the OS CSPRNG, base64url with no padding.
 *
 * 32 bytes and not 16: these values are the entire proof in fix ⓑ — the `state` a
 * provider echoes back and the binding secret that only ever lived in a cookie — so the
 * cost of guessing one has to be the cost of guessing a key, not of guessing a session id.
 * base64url because all three of them travel in a URL, a cookie and a form field, and
 * `+`, `/` and `=` each need escaping in at least one of those.
 */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Lower-case hex SHA-256 — the shape `oauth_states.state_hash` and `binding_hash` accept. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** base64url SHA-256, which is what RFC 7636 calls `S256` and what a PKCE challenge is. */
export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * String equality that does not leak how far it got.
 *
 * Used on the PKCE challenge and the OIDC `nonce`, both of which are compared against a
 * value an attacker supplies and can retry. `timingSafeEqual` throws on unequal lengths,
 * so the length check is first and is itself not constant time — the length of a base64url
 * SHA-256 is public, so there is nothing there to learn.
 */
export function equalsConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
