import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { SESSION_CONFIG } from './session.tokens';
import type { SessionConfig } from './session.config';

/**
 * The short-lived bearer token, signed here and verified here.
 *
 * It is a compact JWS with HS256, written out by hand rather than pulled from a library.
 * Two reasons, in order of weight. The first is that the verifier below is fifty lines and
 * the failure modes of JWT are almost entirely in the verifier — `alg: none`, algorithm
 * confusion, an unpinned issuer, a signature compared with `===` — so this is the code
 * that has to be read, and reading it is easier than auditing a dependency's options
 * object for the same four mistakes. The second is that adding a dependency means editing
 * apps/api/package.json, which is outside this module's ownership this round.
 *
 * **What the token deliberately does not carry: permissions.** Plan section 6 makes
 * permissions the single source of truth and requires the API to enforce on every
 * endpoint. A permission baked into a ten-minute token is a permission that stays granted
 * for ten minutes after it is taken away, and a role change that a support agent watches
 * not happen. So the token asserts *who* and *which session*, and the permission module
 * answers *may they* against the database on the request. That is a read this module does
 * not get to skip on the guard's behalf.
 */

const HEADER: Readonly<Record<string, string>> = { alg: 'HS256', typ: 'JWT' };

/** Precomputed: the header is constant, so signing does not re-encode it every time. */
const ENCODED_HEADER = base64url(Buffer.from(JSON.stringify(HEADER), 'utf8'));

export interface AccessTokenClaims {
  readonly iss: string;
  /** The user. */
  readonly sub: string;
  /** The session, so a guard can report *which* sign-in a request belongs to. */
  readonly sid: string;
  /** This token, for correlating a request in the log with the token that authorised it. */
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * Why a token was refused, in the caller's vocabulary.
 *
 * A union and not an exception: every one of these ends as the same 401 to the client, and
 * the difference only ever appears in a log line. Making it a return value stops a guard
 * from accidentally distinguishing them in a response — which is how a verifier becomes an
 * oracle telling an attacker whether their forgery got as far as the signature check.
 */
export type AccessTokenRejection =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'bad_claims'
  | 'wrong_issuer'
  | 'expired';

export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: AccessTokenRejection };

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly jti: string;
}

@Injectable()
export class AccessTokenService {
  constructor(@Inject(SESSION_CONFIG) private readonly config: SessionConfig) {}

  sign(subject: { readonly userId: string; readonly sessionId: string }): IssuedAccessToken {
    // Whole seconds, because `exp` and `iat` are seconds in every JWT ever written and a
    // fractional one is the kind of thing another implementation rounds the wrong way.
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.config.accessTokenTtlSeconds;
    const jti = randomUUID();

    const claims: AccessTokenClaims = {
      iss: this.config.issuer,
      sub: subject.userId,
      sid: subject.sessionId,
      jti,
      iat: issuedAt,
      exp: expiresAt,
    };

    const body = `${ENCODED_HEADER}.${base64url(Buffer.from(JSON.stringify(claims), 'utf8'))}`;

    return {
      token: `${body}.${base64url(this.mac(body))}`,
      expiresAt: new Date(expiresAt * 1000),
      jti,
    };
  }

  /**
   * The order of the checks is the security property.
   *
   * Nothing from the payload is read until the signature has been shown to be ours. A
   * verifier that parses claims first and validates later is one refactor away from
   * trusting `sub` on a token it never authenticated, and that refactor looks harmless in
   * a diff.
   */
  verify(token: string): AccessTokenVerification {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      encodedHeader.length === 0 ||
      encodedPayload.length === 0 ||
      encodedSignature.length === 0
    ) {
      return { ok: false, reason: 'malformed' };
    }

    /*
     * The header is compared as a *string* to the one we emit, which is stricter than
     * parsing it and checking `alg`. It admits exactly one header and therefore cannot be
     * talked into `none`, into RS256-with-the-HMAC-key, or into a `crit` parameter this
     * code has never heard of. There is no legitimate second header for a token this
     * service both issues and consumes.
     */
    if (encodedHeader !== ENCODED_HEADER) return { ok: false, reason: 'unsupported_algorithm' };

    const presented = decodeBase64url(encodedSignature);
    if (presented === undefined) return { ok: false, reason: 'malformed' };

    const expected = this.mac(`${encodedHeader}.${encodedPayload}`);
    // `timingSafeEqual` throws on a length mismatch, so the length is compared first. That
    // leaks only the digest length, which is a constant of HS256 and public.
    if (presented.length !== expected.length) return { ok: false, reason: 'bad_signature' };
    if (!timingSafeEqual(presented, expected)) return { ok: false, reason: 'bad_signature' };

    const payload = decodeBase64url(encodedPayload);
    if (payload === undefined) return { ok: false, reason: 'malformed' };

    const claims = readClaims(payload);
    if (claims === undefined) return { ok: false, reason: 'bad_claims' };

    /*
     * Pinned, not read. A token signed by a different deployment that happens to share a
     * key — staging pointed at production's secret during an incident, say — is a token
     * this API must not accept, and `iss` is the only field that can say so.
     */
    if (claims.iss !== this.config.issuer) return { ok: false, reason: 'wrong_issuer' };

    // No clock skew allowance: signer and verifier are the same process, or two processes
    // on the same NTP. An allowance here would extend every token's real lifetime, which
    // is the number ACCESS_TOKEN_TTL_DEFAULT_SECONDS spends a paragraph justifying.
    if (claims.exp * 1000 <= Date.now()) return { ok: false, reason: 'expired' };

    return { ok: true, claims };
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.config.accessTokenKey).update(body, 'utf8').digest();
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * Base64url with the round trip checked.
 *
 * `Buffer.from(value, 'base64url')` never fails — it discards anything it does not
 * recognise — so `'a.b.!!!!'` decodes to something rather than to an error, and a
 * signature check against that something is a comparison of two attacker-influenced
 * values. Re-encoding and comparing is what turns "decoded" into "was actually this".
 */
function decodeBase64url(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

/** Every field checked before any is trusted; an extra field is ignored, a wrong one is fatal. */
function readClaims(payload: Buffer): AccessTokenClaims | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;

  const iss = record['iss'];
  const sub = record['sub'];
  const sid = record['sid'];
  const jti = record['jti'];
  const iat = record['iat'];
  const exp = record['exp'];

  if (typeof iss !== 'string' || iss.length === 0) return undefined;
  if (typeof sub !== 'string' || sub.length === 0) return undefined;
  if (typeof sid !== 'string' || sid.length === 0) return undefined;
  if (typeof jti !== 'string' || jti.length === 0) return undefined;
  // `typeof` first so the values narrow to `number`; `Number.isSafeInteger` is not a type
  // predicate, and reaching for a cast to bridge that is how a lie enters a verifier.
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) return undefined;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return undefined;

  return { iss, sub, sid, jti, iat, exp };
}
