import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from '@wewin/db';
import { users } from '@wewin/db/schema';

import { AppModule } from '../../../src/app.module';
import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseOAuthConfig } from '../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../src/config/env';
import { ProfileModule } from '../../../src/profile';
import { testSessionConfig } from '../../support/app';

/**
 * The real application graph, **plus `ProfileModule`** — and the `plus` is load-bearing here.
 *
 * `tests/orders/support/lifecycle-app.ts` uses the same construction and explains the
 * division of labour: the boot-time route audit is the *alarm* that a module is missing from
 * `AppModule.forRoot`, and a suite like this one is the *exercise* that the module works. The
 * two must fail independently, or a wiring mistake shows up as thirty confusing red
 * assertions instead of one route inventory that changed.
 *
 * The difference is that in that file the `plus` is redundant — `OrdersModule` is in
 * `AppModule` — and here it is not: **`ProfileModule` is not wired into the application yet**,
 * for the reason its own header gives (wiring touches `src/app.module.ts` and the strict route
 * inventory in `tests/rbac/route-audit.test.ts`, both of which another round is editing right
 * now). So this line is what makes `GET /me/preferences` reachable at all today, and the day
 * somebody adds the module to `AppModule` nothing here changes, because Nest deduplicates by
 * class reference.
 *
 * Everything else is the real thing: the same middleware, the same global `RbacGuard`, the
 * same boot-time audit — which means a profile route added without an access policy fails
 * this suite at `listen`, before a single assertion runs.
 */

export interface ProfileApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function profileEnv(databaseUrl: string): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootProfileApp(env: Env): Promise<ProfileApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, {
        session: testSessionConfig(),
        oauth: parseOAuthConfig({}),
      }),
      ProfileModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}

export interface Actor {
  readonly userId: string;
  readonly token: string;
}

/**
 * A user with no groups and no permissions — a customer — and a token the running app accepts.
 *
 * Signed by the application's own `AccessTokenService` and not minted here, for the reason the
 * order suite gives: a JWT built in a test proves the test can sign, not that the app can
 * authenticate.
 *
 * No group is created. Every route in this round is `@RequireAuthenticated`, so a permission
 * would only obscure what is being tested — and a customer holding nothing is the principal
 * this feature is actually for.
 */
export async function makeCustomer(
  db: Database,
  app: ProfileApp,
  label: string,
): Promise<Actor> {
  const [user] = await db.insert(users).values({ displayName: label }).returning({ id: users.id });
  if (!user) throw new Error('fixture insert returned nothing');

  const issued = app.app.get(AccessTokenService).sign({ userId: user.id, sessionId: randomUUID() });
  return { userId: user.id, token: issued.token };
}

export interface Json {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** One HTTP client for the suite, carrying either a bearer token or a guest cookie. */
export function client(baseUrl: string) {
  return async function call(
    method: string,
    path: string,
    options: { readonly token?: string; readonly cookie?: string; readonly body?: unknown } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? null : (JSON.parse(text) as unknown),
      headers: response.headers,
    };
  };
}
