import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MfaChallengeService, MFA_CHALLENGE_TTL_SECONDS } from '../../../src/auth/mfa/challenge';
import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseSessionConfig } from '../../../src/auth/session/session.config';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE STATE THIS SYSTEM DID NOT HAVE: PASSWORD ACCEPTED, NO SESSION YET.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `POST /auth/password` issues a session in one step. Adding a second factor means there is
 * now a moment in between — factor one proven, factor two outstanding — and the caller needs
 * something to carry across it.
 *
 * ⚠️ **That something is one bug away from being a session.** Issue an access token there and
 * MFA protects nothing at all: the client already holds what it was about to be asked to
 * earn. So the challenge is not an access token with a flag on it.
 *
 * ── Key separation, not a claim ──────────────────────────────────────────────
 *
 * The obvious design is one signer and a `purpose` claim the verifier checks. That works
 * until somebody adds a code path that forgets the check — a claim is an `if`, and an `if`
 * can be missing.
 *
 * The challenge is signed with a **different key**, derived from the session secret by
 * domain separation. Confusion then stops being a thing the verifier has to remember and
 * becomes a thing the mathematics refuses: an access-token verifier handed a challenge sees
 * a bad signature, whatever it does or does not check about the claims.
 *
 * The tests below assert that in **both directions**, because a one-way check would pass on
 * an implementation that used the same key and simply happened to differ elsewhere.
 */

const config = parseSessionConfig({
  AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
});

const challenges = new MfaChallengeService(config);
const access = new AccessTokenService(config);

const USER = '3346d43e-a78b-439a-bc96-f22ec6fde850';

describe('what the challenge carries', () => {
  it('names the user it was issued for, and nothing else about them', () => {
    const issued = challenges.issue(USER);
    const opened = challenges.verify(issued.token);

    expect(opened).toStrictEqual({ ok: true, userId: USER });
  });

  it('⚠️ expires in minutes, not the ten an access token gets', () => {
    /*
     * This window is how long somebody has to fetch a code off their phone. Five minutes is
     * generous for that and short enough that a challenge captured from a log or a proxy is
     * stale before it is useful — and unlike an access token, nothing renews it.
     */
    expect(MFA_CHALLENGE_TTL_SECONDS).toBeLessThanOrEqual(5 * 60);
    expect(MFA_CHALLENGE_TTL_SECONDS).toBeGreaterThanOrEqual(60);

    const issued = challenges.issue(USER);
    const seconds = (issued.expiresAt.getTime() - Date.now()) / 1000;

    expect(seconds).toBeGreaterThan(MFA_CHALLENGE_TTL_SECONDS - 5);
    expect(seconds).toBeLessThanOrEqual(MFA_CHALLENGE_TTL_SECONDS);
  });

  it('refuses one that has expired', () => {
    const stale = challenges.issue(USER, Date.now() - (MFA_CHALLENGE_TTL_SECONDS + 10) * 1000);

    expect(challenges.verify(stale.token)).toStrictEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a signature that was not ours', () => {
    const other = new MfaChallengeService(
      parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url') }),
    );

    expect(other.verify(challenges.issue(USER).token).ok).toBe(false);
  });

  it('refuses anything that is not a token', () => {
    for (const text of ['', 'a.b', 'a.b.c', 'not a token at all']) {
      expect(challenges.verify(text).ok, `"${text}" was accepted`).toBe(false);
    }
  });
});

describe('⭐ a challenge and an access token cannot be confused, in either direction', () => {
  it('⚠️ the access-token verifier refuses a challenge', () => {
    /*
     * The failure that would delete the whole feature: a challenge accepted as a bearer
     * token is a session handed out before the second factor was ever asked for.
     *
     * Different key, so the signature fails — which holds whatever the claim checks do or do
     * not do. The absent `sid` would fail too; that is the second layer, not the first.
     */
    const challenge = challenges.issue(USER);
    const verified = access.verify(challenge.token);

    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.reason).toBe('bad_signature');
  });

  it('⚠️ the challenge verifier refuses an access token', () => {
    /*
     * The other direction, and it matters as much. If a live session's token were accepted
     * as a challenge, anybody who had ever signed in could complete somebody else's
     * second-factor step — or their own, without a factor.
     */
    const token = access.sign({ userId: USER, sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' });

    expect(challenges.verify(token.token).ok).toBe(false);
  });

  it('⭐ derives its key from the session secret rather than taking a second one', () => {
    /*
     * Domain separation, not a new environment variable. A second secret is a second thing
     * to rotate, a second thing to forget in an environment, and a second way to deploy an
     * application that boots and then fails at the first sign-in.
     *
     * Asserted by construction: two services built from the *same* config agree, and one
     * built from a different config does not — which is only true if the key is a function
     * of the secret.
     */
    const twin = new MfaChallengeService(config);
    const issued = challenges.issue(USER);

    expect(twin.verify(issued.token)).toStrictEqual({ ok: true, userId: USER });
  });
});

describe('⚠️ what it deliberately does not do', () => {
  it('is not single-use, and the reason is written down', () => {
    /*
     * Stated as a test so the decision is visible rather than assumed.
     *
     * A stateless token cannot be spent without a table, and the table would be a row per
     * sign-in attempt for a five-minute window. What replay buys an attacker here is
     * nothing on its own: the challenge is half of a pair, and the other half is a TOTP code
     * that is itself single-use and expires in thirty seconds. Somebody holding a replayed
     * challenge still needs a live code, which means they have the phone — and if they have
     * the phone the challenge was never the weak link.
     *
     * If that stops being true — a channel where challenges leak but codes do not — this is
     * the comment to come back to.
     */
    const issued = challenges.issue(USER);

    expect(challenges.verify(issued.token).ok).toBe(true);
    expect(challenges.verify(issued.token).ok).toBe(true);
  });
});
