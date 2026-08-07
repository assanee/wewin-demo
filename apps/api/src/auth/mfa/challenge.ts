import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { SESSION_CONFIG } from '../session/session.tokens';
import type { SessionConfig } from '../session/session.config';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE STATE THIS SYSTEM DID NOT HAVE: PASSWORD ACCEPTED, NO SESSION YET.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `POST /auth/password` mints a session in one step. A second factor puts a moment in
 * between — factor one proven, factor two outstanding — and the caller needs something to
 * carry across it.
 *
 * ⚠️ **That something is one bug away from being a session.** Hand back an access token
 * there and MFA protects nothing: the client already holds the thing it was about to be
 * asked to earn.
 *
 * ── Key separation, not a claim ──────────────────────────────────────────────
 *
 * The obvious design is one signer plus a `purpose` claim the verifier checks. That holds
 * until somebody adds a path that forgets the check, because a claim is an `if` and an `if`
 * can be missing.
 *
 * This is signed with a **different key**, derived from the session secret by domain
 * separation. Confusion stops being something a verifier has to remember and becomes
 * something the mathematics refuses: `AccessTokenService.verify` handed a challenge reports
 * `bad_signature` regardless of what it checks about claims. The absent `sid` would fail it
 * too — that is the second layer, and it is not the one being relied on.
 *
 * Derived rather than configured, so there is no second secret to rotate, to leave out of an
 * environment, or to discover missing at the first sign-in after a deploy.
 *
 * ── Not single-use, deliberately ─────────────────────────────────────────────
 *
 * Spending a stateless token needs a table, and the table would be a row per sign-in attempt
 * for a five-minute window. Replay buys an attacker nothing alone: the challenge is half a
 * pair, and the other half is a TOTP code that is itself single-use and lives thirty
 * seconds. Somebody replaying a challenge still needs a live code — which means they have
 * the phone, and if they have the phone the challenge was never the weak link.
 *
 * If that stops being true — a channel where challenges leak and codes do not — this is the
 * paragraph to come back to.
 */

/** Long enough to unlock a phone and read a code; short enough that a captured one is stale. */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

const HEADER = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8'));

/**
 * The label that makes the key a different key.
 *
 * Versioned, so the day this needs to change there is a way to accept both during a rolling
 * deploy rather than signing everybody out mid-enrolment.
 */
const DOMAIN = 'wewin/mfa-challenge/v1';

export type ChallengeRejection = 'malformed' | 'bad_signature' | 'bad_claims' | 'wrong_issuer' | 'expired';

export type ChallengeVerification =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: ChallengeRejection };

export interface IssuedChallenge {
  readonly token: string;
  readonly expiresAt: Date;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

@Injectable()
export class MfaChallengeService {
  private readonly key: Buffer;

  constructor(@Inject(SESSION_CONFIG) config: SessionConfig) {
    /*
     * HMAC as a KDF over a fixed label. Not `HKDF` because there is one derivation and no
     * salt to manage, and not the raw secret because that is the whole point of the file.
     */
    this.key = createHmac('sha256', config.accessTokenKey.export()).update(DOMAIN).digest();
    this.issuer = config.issuer;
  }

  private readonly issuer: string;

  /** `atMs` is for tests that need a token that has already expired. */
  issue(userId: string, atMs: number = Date.now()): IssuedChallenge {
    const issuedAt = Math.floor(atMs / 1000);
    const expiresAt = issuedAt + MFA_CHALLENGE_TTL_SECONDS;

    /*
     * No `sid`. There is no session — that absence is the honest shape of this moment, and
     * it is also what makes the token fail an access-token verifier's claim check even if
     * the keys were ever unified by mistake.
     */
    const claims = { iss: this.issuer, sub: userId, jti: randomUUID(), iat: issuedAt, exp: expiresAt };
    const body = `${HEADER}.${base64url(Buffer.from(JSON.stringify(claims), 'utf8'))}`;

    return {
      token: `${body}.${base64url(this.mac(body))}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  verify(token: string, atMs: number = Date.now()): ChallengeVerification {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };

    const [header, payload, signature] = parts;
    if (header === undefined || payload === undefined || signature === undefined) {
      return { ok: false, reason: 'malformed' };
    }

    /* Constant-time, and length-checked first because `timingSafeEqual` throws on a mismatch. */
    const expected = this.mac(`${header}.${payload}`);
    const presented = Buffer.from(signature, 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
      return { ok: false, reason: 'bad_claims' };
    }

    const { iss, sub, exp } = claims as Record<string, unknown>;

    if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'bad_claims' };
    if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
      return { ok: false, reason: 'bad_claims' };
    }
    if (iss !== this.issuer) return { ok: false, reason: 'wrong_issuer' };
    if (Math.floor(atMs / 1000) >= exp) return { ok: false, reason: 'expired' };

    return { ok: true, userId: sub };
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(body, 'ascii').digest();
  }
}
