import { createHash, randomBytes } from 'node:crypto';

/**
 * Minting and storing the values that are only ever held by one party.
 *
 * A refresh token is not a password and must not be treated like one. It is 256 bits from
 * the CSPRNG, so there is no search space for a work factor to defend — a KDF here would
 * cost every refresh a few hundred milliseconds to make an already-impossible offline
 * search slightly more impossible. SHA-256 is the right primitive, and
 * `refresh_tokens.token_hash` is `char(64)` with `CHECK ~ '^[0-9a-f]{64}$'` precisely so
 * that a caller who forgets to hash fails on the write that forgot.
 *
 * Passwords are the opposite premise and get argon2id; that lives in the credentials
 * module, not this one.
 */

/**
 * 32 bytes. Base64url-encoded that is 43 characters with no padding, so the token is
 * URL-safe and cookie-safe without escaping, and there is no `=` for a proxy to mangle.
 */
const SECRET_BYTES = 32;

/** The shape `refresh_tokens.token_hash` accepts. Restated here so a test can assert it. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A fresh token secret.
 *
 * `randomBytes` and not `randomUUID`: a v4 UUID carries 122 bits, and while that is
 * plenty today it is a number chosen by a formatting decision rather than by us.
 */
export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * The value that goes in the database.
 *
 * Takes any string rather than only well-formed secrets, deliberately: a presented token
 * that is garbage hashes to a digest that matches no row, which is the same answer as a
 * token that expired. Rejecting malformed input earlier would create a distinguishable
 * fast path — "this one was not even a token" — that an attacker can measure.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
