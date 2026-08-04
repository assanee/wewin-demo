import {
  createHmac,
  createPublicKey,
  createSecretKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import { equalsConstantTime } from './crypto';

/**
 * Compact JWS verification, for the id_tokens the providers hand back.
 *
 * Written here rather than pulled in, for the same reason the whole of phase 3b is written
 * by hand (plan section 6): the three algorithms below are what LINE, Google and Apple
 * actually use, the surface is one function, and a JWT library is a dependency whose
 * defaults are the security-relevant part. The defaults that matter are all refusals:
 *
 *   `alg: "none"` is not implemented, and neither is "whatever the header says". The
 *   caller states which algorithm it expects for a given provider, and a token arriving
 *   with a different one is rejected before a key is loaded. That single rule is the
 *   entire family of algorithm-confusion attacks — the famous one being an RS256 verifier
 *   handed an HS256 token signed with the public key it was about to verify against, which
 *   is a valid signature by an attacker who only ever had public material.
 *
 *   Nothing is trusted before the signature is checked. `kid` selects a key from a set the
 *   *provider* published; it never selects a URL, an algorithm or a secret.
 *
 *   Every claim check is mandatory. `iss`, `aud`, `exp`, `iat` and `nonce` are arguments
 *   with no defaults, so a provider adapter cannot forget one by omission.
 */

export interface JwtClaims {
  readonly [claim: string]: unknown;
}

/** The subset of JOSE this project meets. LINE signs HS256; Google and Apple sign RS256. */
export type JwsAlgorithm = 'HS256' | 'RS256' | 'ES256';

export interface JwsHeader {
  readonly alg: string;
  readonly kid?: string | undefined;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

/** Resolves the key to verify with, given the header the token arrived under. */
export type KeyResolver = (header: JwsHeader) => Promise<KeyObject> | KeyObject;

export interface VerifyOptions {
  readonly algorithm: JwsAlgorithm;
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly keys: KeyResolver;
  /**
   * Tolerance on `exp`/`iat`, in seconds.
   *
   * Not generosity: two servers whose clocks differ by a second is the normal state of the
   * world, and a zero-skew check turns that into an intermittent login failure that nobody
   * can reproduce. Small enough that an expired token stays expired in any sense that
   * matters.
   */
  readonly clockSkewSeconds?: number;
  readonly now?: Date;
}

const DEFAULT_CLOCK_SKEW_SECONDS = 60;

/** Bounded so a hostile or broken response cannot be turned into a large allocation before parsing. */
const MAX_TOKEN_LENGTH = 8192;

export function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json) as unknown;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JwtError(`id_token ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Verify signature, then claims, then return the payload.
 *
 * The order is the point. Everything a caller reads off the result has been through both.
 */
export async function verifyIdToken(token: string, options: VerifyOptions): Promise<JwtClaims> {
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new JwtError('id_token is implausibly long');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('id_token is not a compact JWS');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new JwtError('id_token is not a compact JWS');
  }

  const rawHeader = asRecord(decodeSegment(encodedHeader), 'header');
  const alg = rawHeader['alg'];
  if (typeof alg !== 'string') {
    throw new JwtError('id_token header has no alg');
  }
  /*
   * Before the key is resolved, deliberately. Resolving a key for an algorithm we do not
   * accept is how a verifier ends up holding an RSA public key and an HS256 token in the
   * same function.
   */
  if (alg !== options.algorithm) {
    throw new JwtError(`id_token is signed with ${alg}, expected ${options.algorithm}`);
  }
  const kid = rawHeader['kid'];
  const header: JwsHeader = {
    alg,
    ...(typeof kid === 'string' ? { kid } : {}),
  };

  const key = await options.keys(header);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  if (!signatureIsValid(options.algorithm, signingInput, encodedSignature, key)) {
    throw new JwtError('id_token signature does not verify');
  }

  const claims = asRecord(decodeSegment(encodedPayload), 'payload');
  assertClaims(claims, options);
  return claims;
}

function signatureIsValid(
  algorithm: JwsAlgorithm,
  signingInput: string,
  encodedSignature: string,
  key: KeyObject,
): boolean {
  const signature = Buffer.from(encodedSignature, 'base64url');
  const data = Buffer.from(signingInput, 'utf8');

  switch (algorithm) {
    case 'HS256': {
      /*
       * Recomputed rather than verified: `crypto.verify` rejects a secret KeyObject
       * outright ("Invalid key object type secret, expected private"), because an HMAC is
       * not a signature scheme with two keys. The comparison is `timingSafeEqual` and not
       * `===`, since an attacker controls the candidate and can retry — and the length
       * guard is first because `timingSafeEqual` throws on a length mismatch, which would
       * turn a malformed token into a 500 instead of a rejection.
       */
      const expected = createHmac('sha256', key).update(data).digest();
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    }
    case 'RS256': {
      // RSASSA-PKCS1-v1_5, which is node's default padding for an RSA key.
      return verifySignature('sha256', data, key, signature);
    }
    case 'ES256': {
      /*
       * JOSE encodes an ECDSA signature as the raw r‖s pair; node defaults to the DER
       * wrapping used by TLS. Without `ieee-p1363` every valid Apple-style ES256 signature
       * fails to verify, which reads as a key problem and is a format problem.
       */
      return verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
  }
}

function assertClaims(claims: JwtClaims, options: VerifyOptions): void {
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const issuer = claims['iss'];
  if (typeof issuer !== 'string' || !equalsConstantTime(issuer, options.issuer)) {
    throw new JwtError('id_token was issued by a different issuer');
  }

  /*
   * `aud` is a string or an array of strings in the spec, and both shapes occur in the
   * wild. Accepting only the string form is a login that works until the provider adds a
   * second audience.
   */
  const audience = claims['aud'];
  const audiences = typeof audience === 'string' ? [audience] : audience;
  if (!Array.isArray(audiences) || !audiences.some((value) => value === options.audience)) {
    throw new JwtError('id_token was not issued for this client');
  }

  const expiry = claims['exp'];
  if (typeof expiry !== 'number' || expiry + skew < nowSeconds) {
    throw new JwtError('id_token has expired');
  }

  const issuedAt = claims['iat'];
  if (typeof issuedAt !== 'number' || issuedAt - skew > nowSeconds) {
    throw new JwtError('id_token was issued in the future');
  }

  /*
   * The nonce is the reason an id_token obtained legitimately for the attacker's own
   * account cannot be injected into somebody else's flow. Missing is a failure, not a skip:
   * "verify it if present" is a check an attacker turns off by omitting the claim.
   */
  const nonce = claims['nonce'];
  if (typeof nonce !== 'string' || !equalsConstantTime(nonce, options.nonce)) {
    throw new JwtError('id_token nonce does not match this authorisation request');
  }

  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new JwtError('id_token has no sub');
  }
}

/**
 * One entry of a provider's published key set.
 *
 * A `type` alias and not an `interface` on purpose: node's `JsonWebKey` carries an index
 * signature, and only a type alias gets the implicit one that makes it assignable. The
 * optional fields are spelled `?: string` and not `?: string | undefined` for the second
 * half of the same fit — under `exactOptionalPropertyTypes` an explicitly-`undefined`
 * property is not assignable to node's declaration, so jwks.ts builds these by conditional
 * spread and an absent field is genuinely absent. The fields are the union of what an RSA
 * and an EC public key need.
 */
export type Jwk = {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
};

/** A JWK from a provider's key set, as a node key. Rejects anything carrying private material. */
export function publicKeyFromJwk(jwk: Jwk): KeyObject {
  if ('d' in jwk) {
    // A key set that contains a private key is a provider that has leaked one; refusing to
    // load it means this service never becomes the thing that used it.
    throw new JwtError('JWKS entry carries private key material');
  }
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** LINE signs its id_token with HS256 over the channel secret; that secret is the key. */
export function hmacKeyFromSecret(secret: string): KeyObject {
  return createSecretKey(Buffer.from(secret, 'utf8'));
}
