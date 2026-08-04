import { createHmac, randomBytes } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccessTokenService } from '../../../src/auth/session/access-token';
import { REFRESH_COOKIE_NAME, clearedRefreshCookie, refreshCookie } from '../../../src/auth/session/refresh-cookie';
import { DIGEST_PATTERN, hashSecret, mintSecret } from '../../../src/auth/session/secrets';
import {
  ACCESS_TOKEN_TTL_DEFAULT_SECONDS,
  REFRESH_GRACE_DEFAULT_SECONDS,
  SessionConfigError,
  parseSessionConfig,
  type SessionConfig,
} from '../../../src/auth/session/session.config';
import { SessionModule } from '../../../src/auth/session/session.module';
import { SessionService } from '../../../src/auth/session/session.service';
import { SESSION_CONFIG } from '../../../src/auth/session/session.tokens';
import { ConfigModule } from '../../../src/config/config.module';
import { DatabaseModule } from '../../../src/database/database.module';
import { testEnv } from '../../support/app';

/**
 * Everything in the session module that does not need Postgres.
 *
 * The rotation race is in tests/auth-session-rotation.pg.test.ts, because it cannot be
 * demonstrated anywhere but against a real server — two connections contending for one
 * row is the entire claim.
 *
 * No secret is written down anywhere in this file. Every key and every token is generated
 * at run time from `randomBytes`, which is also the only honest way to test a minimum
 * length: a literal that satisfies it would be a credential in the repository, and the
 * repository is exactly where credentials must not be.
 */

const secret = (): string => randomBytes(32).toString('base64url');

const config = (overrides: Record<string, string> = {}): SessionConfig =>
  parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: secret(), ...overrides });

afterEach(() => {
  vi.useRealTimers();
});

describe('session configuration', () => {
  it('refuses to build without a signing key', () => {
    expect(() => parseSessionConfig({})).toThrow(SessionConfigError);
  });

  it('names every problem at once rather than the first', () => {
    let thrown: unknown;
    try {
      parseSessionConfig({ AUTH_ACCESS_TOKEN_TTL_SECONDS: '0', AUTH_SESSION_TTL_SECONDS: '0' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionConfigError);
    const problems = thrown instanceof SessionConfigError ? thrown.problems : [];
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join('\n')).toContain('AUTH_ACCESS_TOKEN_SECRET');
  });

  it('never repeats the secret back in an error', () => {
    // The likeliest failure of this function is a mistyped key, and the naive version of
    // it prints the value into a crash log. A short one is still key material.
    const tooShort = randomBytes(8).toString('base64url');

    let thrown: unknown;
    try {
      parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: tooShort });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionConfigError);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain(tooShort);
    expect(message).toContain('AUTH_ACCESS_TOKEN_SECRET');
  });

  it('keeps the key inside a KeyObject, so nothing prints it by accident', () => {
    const raw = secret();
    const parsed = parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: raw });

    expect(JSON.stringify(parsed)).not.toContain(raw);
    expect(String(parsed.accessTokenKey)).not.toContain(raw);
    expect(`${parsed.accessTokenKey.type}`).toBe('secret');
  });

  it('defaults to a ten-minute access token and a fifteen-second grace window', () => {
    const parsed = config();

    expect(parsed.accessTokenTtlSeconds).toBe(ACCESS_TOKEN_TTL_DEFAULT_SECONDS);
    expect(parsed.accessTokenTtlSeconds).toBe(600);
    // Plan 6(c): "roughly 15 seconds". If this changes, the paragraph in session.config.ts
    // explaining why it is 40× smaller than the access token lifetime changes with it.
    expect(parsed.refreshGraceSeconds).toBe(REFRESH_GRACE_DEFAULT_SECONDS);
    expect(parsed.refreshGraceSeconds).toBe(15);
  });

  it('rejects lifetimes that do not nest', () => {
    expect(() =>
      parseSessionConfig({
        AUTH_ACCESS_TOKEN_SECRET: secret(),
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '3600',
        AUTH_REFRESH_TOKEN_TTL_SECONDS: '600',
      }),
    ).toThrow(/shorter than AUTH_REFRESH_TOKEN_TTL_SECONDS/);

    expect(() =>
      parseSessionConfig({
        AUTH_ACCESS_TOKEN_SECRET: secret(),
        AUTH_REFRESH_TOKEN_TTL_SECONDS: '86400',
        AUTH_SESSION_TTL_SECONDS: '3600',
      }),
    ).toThrow(/must not exceed AUTH_SESSION_TTL_SECONDS/);
  });

  it('rejects a grace window as long as the token it protects', () => {
    expect(() =>
      parseSessionConfig({
        AUTH_ACCESS_TOKEN_SECRET: secret(),
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '60',
        AUTH_REFRESH_GRACE_SECONDS: '60',
      }),
    ).toThrow(/AUTH_REFRESH_GRACE_SECONDS/);
  });

  it('allows a zero grace window, because a test has to be able to close it', () => {
    expect(config({ AUTH_REFRESH_GRACE_SECONDS: '0' }).refreshGraceSeconds).toBe(0);
  });
});

describe('token secrets', () => {
  it('mints 256 bits, url-safe, and never the same twice', () => {
    const minted = Array.from({ length: 64 }, () => mintSecret());

    for (const value of minted) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set(minted).size).toBe(minted.length);
  });

  it('hashes to the shape refresh_tokens.token_hash accepts', () => {
    // `refresh_tokens_token_hash_is_digest` is `CHECK ~ '^[0-9a-f]{64}$'`. The CHECK is what
    // catches a service that forgot to hash; this is what catches a service that hashed
    // into a shape the CHECK would reject, which fails at the write instead of here.
    const digest = hashSecret(mintSecret());

    expect(digest).toMatch(DIGEST_PATTERN);
    expect(digest).toHaveLength(64);
  });

  it('hashes deterministically, and differently for different input', () => {
    const a = mintSecret();
    const b = mintSecret();

    expect(hashSecret(a)).toBe(hashSecret(a));
    expect(hashSecret(a)).not.toBe(hashSecret(b));
    expect(hashSecret(a)).not.toContain(a);
  });
});

describe('access tokens', () => {
  it('round-trips the claims a guard needs', () => {
    const service = new AccessTokenService(config());
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });

    const verified = service.verify(issued.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.claims.sub).toBe('user-1');
    expect(verified.claims.sid).toBe('session-1');
    expect(verified.claims.jti).toBe(issued.jti);
    expect(verified.claims.exp - verified.claims.iat).toBe(ACCESS_TOKEN_TTL_DEFAULT_SECONDS);
  });

  it('carries no permissions — plan section 6 makes those a database read, not a claim', () => {
    const service = new AccessTokenService(config());
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });
    const parts = issued.token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    // A permission baked into a ten-minute token stays granted for ten minutes after it is
    // revoked. If somebody adds one here, this fails and they have to argue for it.
    expect(Object.keys(payload).sort()).toStrictEqual(['exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
  });

  it('refuses a token signed with another key', () => {
    const mine = new AccessTokenService(config());
    const theirs = new AccessTokenService(config());
    const forged = theirs.sign({ userId: 'user-1', sessionId: 'session-1' });

    expect(mine.verify(forged.token)).toStrictEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token whose payload was edited', () => {
    const service = new AccessTokenService(config());
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });
    const [header, payload, signature] = issued.token.split('.');

    const tampered = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    tampered['sub'] = 'somebody-else';
    const rewritten = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url');

    expect(service.verify(`${header ?? ''}.${rewritten}.${signature ?? ''}`)).toStrictEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses `alg: none`, and refuses it before reading a single claim', () => {
    const service = new AccessTokenService(config());
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'wewin-api',
        sub: 'attacker',
        sid: 'whatever',
        jti: 'whatever',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'utf8',
    ).toString('base64url');

    expect(service.verify(`${header}.${payload}.AAAA`)).toStrictEqual({
      ok: false,
      reason: 'unsupported_algorithm',
    });
  });

  it('refuses a token whose issuer is not ours, even with a valid signature', () => {
    // The realistic version of this is staging pointed at production's key during an
    // incident. `iss` is the only field that can tell the two apart.
    const key = secret();
    const staging = new AccessTokenService(
      parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: key, AUTH_TOKEN_ISSUER: 'wewin-api-staging' }),
    );
    const production = new AccessTokenService(
      parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: key, AUTH_TOKEN_ISSUER: 'wewin-api' }),
    );

    const issued = staging.sign({ userId: 'user-1', sessionId: 'session-1' });
    expect(production.verify(issued.token)).toStrictEqual({ ok: false, reason: 'wrong_issuer' });
  });

  it('expires exactly when it says it does', () => {
    const service = new AccessTokenService(config());
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });

    vi.useFakeTimers();

    vi.setSystemTime(new Date(issued.expiresAt.getTime() - 1));
    expect(service.verify(issued.token).ok).toBe(true);

    // Inclusive: a token is dead *at* `exp`, not one millisecond after. No skew allowance —
    // an allowance would silently extend the lifetime the configuration promised.
    vi.setSystemTime(issued.expiresAt);
    expect(service.verify(issued.token)).toStrictEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed input without throwing', () => {
    const service = new AccessTokenService(config());

    for (const input of ['', '.', 'a.b', 'a.b.c.d', 'a..c', '..', 'not-a-token']) {
      const verified = service.verify(input);
      expect(verified.ok).toBe(false);
    }
  });

  it('does not accept base64url that is not really base64url', () => {
    // `Buffer.from(value, 'base64url')` silently discards characters it does not
    // recognise, so a signature of `!!!!` decodes to *something*. Without the re-encode
    // check in decodeBase64url, that something is what gets compared.
    const service = new AccessTokenService(config());
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });
    const [header, payload, signature] = issued.token.split('.');

    const smuggled = `${signature ?? ''}!!!`;
    expect(Buffer.from(smuggled, 'base64url')).toStrictEqual(Buffer.from(signature ?? '', 'base64url'));

    expect(service.verify(`${header ?? ''}.${payload ?? ''}.${smuggled}`)).toStrictEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('is a plain HS256 JWS, so an outside verifier agrees with it', () => {
    // Hand-rolled crypto earns this test: the signature is recomputed here with node's
    // HMAC directly, from the raw key, without touching the service's own code path.
    const key = secret();
    const service = new AccessTokenService(parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: key }));
    const issued = service.sign({ userId: 'user-1', sessionId: 'session-1' });

    const [header, payload, signature] = issued.token.split('.');
    const expected = createHmac('sha256', Buffer.from(key, 'utf8'))
      .update(`${header ?? ''}.${payload ?? ''}`, 'utf8')
      .digest('base64url');

    expect(signature).toBe(expected);
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toStrictEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
  });
});

describe('wiring', () => {
  it('builds inside a real Nest graph and resolves the pool from DatabaseModule', async () => {
    /*
     * `SessionRepository` injects `PG_POOL` without importing `DatabaseModule`, which works
     * only because that module is `@Global`. A unit test constructing the classes by hand
     * would never notice if it stopped being global; this fails on the spot.
     *
     * `.compile()` does not run lifecycle hooks, so nothing here tries to reach the
     * unreachable database in `testEnv()`.
     */
    const config = parseSessionConfig({ AUTH_ACCESS_TOKEN_SECRET: secret() });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(testEnv()), DatabaseModule, SessionModule.forRoot(config)],
    }).compile();

    try {
      const service = moduleRef.get(SessionService);
      expect(service).toBeInstanceOf(SessionService);
      expect(moduleRef.get(SESSION_CONFIG)).toBe(config);

      // Reaches AccessTokenService through the service, which proves the config arrived at
      // both collaborators rather than only at the one that was asked for.
      const issued = moduleRef.get(AccessTokenService).sign({ userId: 'u', sessionId: 's' });
      expect(service.verifyAccessToken(issued.token).ok).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('the refresh cookie', () => {
  const now = new Date('2026-08-04T00:00:00.000Z');

  it('carries every attribute that makes it a secret', () => {
    const cookie = refreshCookie('a-token', new Date(now.getTime() + 60_000), now);

    expect(cookie.startsWith('__Host-')).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    // `__Host-` is refused by the browser if a Domain is present; that refusal is the
    // defence against a sibling subdomain planting a refresh cookie, so there must be none.
    expect(cookie).not.toContain('Domain');
  });

  it('expires with the token inside it, never after', () => {
    expect(refreshCookie('t', new Date(now.getTime() + 90_000), now)).toContain('Max-Age=90');
    // An already-dead token must not leave a cookie a browser keeps for a negative age.
    expect(refreshCookie('t', new Date(now.getTime() - 90_000), now)).toContain('Max-Age=0');
  });

  it('clears with the same name and path, or it clears nothing', () => {
    const cleared = clearedRefreshCookie();

    expect(cleared).toContain(`${REFRESH_COOKIE_NAME}=;`);
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('Max-Age=0');
  });
});
