import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from '@wewin/db';
import { groupPermissions, groups, userGroups, users } from '@wewin/db/schema';

import { AppModule } from '../../../src/app.module';
import { AccessTokenService } from '../../../src/auth/session/access-token';
import { parseOAuthConfig } from '../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../src/config/env';
import { OrdersModule } from '../../../src/orders/orders.module';
import type { PermissionCode } from '../../../src/rbac';
import { testSessionConfig , testMfaSecretKey } from '../../support/app';

/**
 * The real application graph, plus `OrdersModule`.
 *
 * The `plus` is now redundant and is kept deliberately. `AppModule.forRoot` imports
 * `OrdersModule` itself — it did not for most of this round, which is how a whole feature
 * came to be tested against an application that did not serve it — and Nest deduplicates by
 * class reference, so naming it twice changes nothing. It stays as a statement of what this
 * suite requires: if somebody removes the module from the application, `route-audit.test.ts`
 * and `cross-tenant-routes.pg.test.ts` go red, and *these* suites keep passing, which is
 * exactly the division of labour to want. The route sweep is the alarm; this is the exercise.
 *
 * Everything else is the real thing: the same middleware, the same global guard, the same
 * boot-time route audit — which means an order route added without an access policy fails
 * this suite at `listen`, before a single assertion runs.
 */

export interface LifecycleApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function lifecycleEnv(databaseUrl: string): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootLifecycleApp(env: Env): Promise<LifecycleApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, {
        mfaSecretKey: testMfaSecretKey(),
        session: testSessionConfig(),
        oauth: parseOAuthConfig({}),
      }),
      OrdersModule,
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
 * A user, a group holding exactly these permissions, and a token the running app will accept.
 *
 * Signed by the application's own `AccessTokenService` for the reason the admin suite gives:
 * minting a JWT in the test would prove the test can sign, not that the app can authenticate.
 * An empty permission list is a *customer* — which is most of this suite, and the thing plan
 * 7.4 trap 2 is about.
 */
export async function makeActor(
  db: Database,
  app: LifecycleApp,
  label: string,
  codes: readonly PermissionCode[],
): Promise<Actor> {
  const [user] = await db
    .insert(users)
    .values({ displayName: label })
    .returning({ id: users.id });
  if (!user) throw new Error('fixture insert returned nothing');

  if (codes.length > 0) {
    const code = `orders_probe_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
    const [group] = await db
      .insert(groups)
      .values({ code, nameTh: 'กลุ่มทดสอบออร์เดอร์' })
      .onConflictDoUpdate({ target: groups.code, set: { nameTh: 'กลุ่มทดสอบออร์เดอร์' } })
      .returning({ id: groups.id });
    if (!group) throw new Error('fixture insert returned nothing');

    await db.insert(userGroups).values({ userId: user.id, groupId: group.id }).onConflictDoNothing();
    await db
      .insert(groupPermissions)
      .values(codes.map((permissionCode) => ({ groupId: group.id, permissionCode })))
      .onConflictDoNothing();
  }

  const issued = app.app
    .get(AccessTokenService)
    .sign({ userId: user.id, sessionId: randomUUID() });

  return { userId: user.id, token: issued.token };
}

export interface Json {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** One HTTP client for the whole suite, carrying either a bearer token or a guest cookie. */
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
