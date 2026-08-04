import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { parseOAuthConfig } from '../../src/auth/oauth/oauth.config';
import { REFRESH_COOKIE_NAME } from '../../src/auth/session/refresh-cookie';
import { SessionService } from '../../src/auth/session/session.service';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { parseEnv } from '../../src/config/env';
import { PG_POOL } from '../../src/database/database.tokens';
import { testSessionConfig } from '../support/app';

/**
 * The application, wired, with somebody actually signed in.
 *
 * Until this round `attachIdentity` had no caller in `src/` at all: the session module minted
 * access tokens, the OAuth module signed people in, the guard resolved a scope, and every
 * HTTP request in the shipping application was `guest` or `public`. Everything worked and
 * nobody was ever authenticated. So the first assertion here is the plainest one in the
 * repository — present a token, get told who you are — and it is the one that would have
 * caught that.
 *
 * This boots the real `AppModule` against a real Postgres, because the pieces being joined
 * are exactly the ones that only exist when they are joined: the middleware, the global
 * guard, the exception filter's envelope, and `rotate_refresh_token()`.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const MARKER = 'auth-endpoints.pg.test';

describeWithPg('the authenticated application', () => {
  let app: INestApplication;
  let baseUrl: string;
  let sessions: SessionService;

  beforeAll(async () => {
    const env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: url ?? '', COOKIE_SECURE: 'false' });

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(env, { session: testSessionConfig(), oauth: parseOAuthConfig({}) }),
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter(env));
    await app.listen(0, '127.0.0.1');

    baseUrl = `http://127.0.0.1:${String((app.getHttpServer().address() as AddressInfo).port)}`;
    sessions = app.get(SessionService);
  }, 60_000);

  afterAll(async () => {
    // `users` cascades to sessions and refresh tokens, so one statement is the whole
    // cleanup. Through the application's own pool, because closing the app closes it.
    await app.get<Pool>(PG_POOL).query('delete from users where display_name = $1', [MARKER]);
    await app.close();
  });

  const newUser = async (): Promise<string> => {
    const { rows } = await app
      .get<Pool>(PG_POOL)
      .query<{ id: string }>('insert into users (display_name) values ($1) returning id', [MARKER]);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('could not create a user');
    return id;
  };

  it('resolves a request carrying a valid access token to that user', async () => {
    const userId = await newUser();
    const issued = await sessions.start({ userId });

    const response = await fetch(`${baseUrl}/me`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'user', userId, permissions: [] });
  });

  it('serves a request with no token, a malformed header or a forged token as public', async () => {
    const issued = await sessions.start({ userId: await newUser() });

    for (const authorization of [
      undefined,
      'Bearer',
      `Basic ${issued.accessToken}`,
      `Bearer ${issued.accessToken} extra`,
      `Bearer ${issued.accessToken.slice(0, -2)}xx`,
    ]) {
      const response = await fetch(`${baseUrl}/me`, {
        headers: authorization === undefined ? {} : { authorization },
      });
      // Anonymous, not 401: `/me` is how a client asks what it is before it knows whether it
      // is anybody, and a broken token must leave the caller less privileged, never more.
      expect(response.status, `authorization: ${String(authorization)}`).toBe(200);
      expect(await response.json()).toMatchObject({ kind: 'public', userId: null });
    }
  });

  describe('POST /auth/refresh', () => {
    it('exchanges the refresh cookie for a new access token and a successor cookie', async () => {
      const userId = await newUser();
      const issued = await sessions.start({ userId });

      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${issued.refreshToken}` },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const body = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string };
      expect(body.accessToken).not.toBe(issued.accessToken);
      expect(Date.parse(body.accessTokenExpiresAt)).toBeGreaterThan(Date.now());

      const [setCookie] = response.headers.getSetCookie();
      expect(setCookie).toContain(`${REFRESH_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      // The successor is a different secret; the response body never carries it.
      expect(setCookie).not.toContain(issued.refreshToken);
      expect(JSON.stringify(body)).not.toContain(issued.refreshToken);

      // And the token it minted actually authenticates.
      const me = await fetch(`${baseUrl}/me`, {
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(await me.json()).toMatchObject({ kind: 'user', userId });
    });

    it('answers 401 with the UNAUTHENTICATED code and clears the cookie', async () => {
      const response = await fetch(`${baseUrl}/auth/refresh`, { method: 'POST' });

      expect(response.status).toBe(401);
      /*
       * The code, not just the status. Before `UNAUTHENTICATED` and `FORBIDDEN` existed,
       * every 401 and 403 in this API serialised as `"code":"BAD_REQUEST"` — the status was
       * right and the field clients are told to branch on was a lie.
       */
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');
    });

    it('gives a parallel burst of refreshes a successor each, and signs nobody out', async () => {
      /*
       * ⓒ over HTTP. This is the dashboard with six panels: they all notice the access token
       * has expired within the same millisecond and they all refresh with the same cookie.
       * Every one gets a 200 — none is accused of reuse — and the session survives.
       */
      const userId = await newUser();
      const issued = await sessions.start({ userId });

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fetch(`${baseUrl}/auth/refresh`, {
            method: 'POST',
            headers: { cookie: `${REFRESH_COOKIE_NAME}=${issued.refreshToken}` },
          }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);

      const tokens = await Promise.all(
        responses.map(async (response) => ((await response.json()) as { accessToken: string }).accessToken),
      );
      // Six distinct access tokens, all of which work: nobody was handed somebody else's.
      expect(new Set(tokens).size).toBe(6);

      const me = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${tokens[0] ?? ''}` } });
      expect(await me.json()).toMatchObject({ kind: 'user', userId });
    });
  });

  describe('POST /auth/logout', () => {
    it('needs a signed-in caller', async () => {
      const response = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('ends the session it was called with, and the refresh cookie stops working', async () => {
      const userId = await newUser();
      const issued = await sessions.start({ userId });

      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.accessToken}` },
      });

      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');

      const refreshed = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${issued.refreshToken}` },
      });
      expect(refreshed.status).toBe(401);
    });

    it('signs out only the session it was called with', async () => {
      const userId = await newUser();
      const phone = await sessions.start({ userId });
      const laptop = await sessions.start({ userId });

      await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${phone.accessToken}` },
      });

      const stillThere = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${laptop.refreshToken}` },
      });
      expect(stillThere.status).toBe(200);
    });
  });
});
