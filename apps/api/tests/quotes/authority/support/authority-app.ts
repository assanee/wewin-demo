import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../../src/app.module';
import { parseOAuthConfig } from '../../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../../src/config/env';
/* The file, not the directory: `src/quotes/authority.ts` shadows `authority/index.ts`. */
import { AuthorityModule } from '../../../../src/quotes/authority/authority.module';
import { testSessionConfig , testMfaSecretKey } from '../../../support/app';

/**
 * The real application graph, **plus** `AuthorityModule`, because nothing has wired it yet.
 *
 * `AppModule.forRoot` is not this agent's file, so naming the module here is the same position
 * `RefundsModule` was in for one phase: the suite proves the feature works while
 * `tests/rbac/route-audit.test.ts` remains the alarm for the wiring itself. When somebody adds
 * it to the application's import list, this line becomes redundant — and harmlessly so, since
 * `AuthorityModule` is a static module and Nest deduplicates those by class reference. (A
 * `forRoot()` module would not be safe to name twice; that is the trap `payments-app.ts`
 * records, and it is the reason this module deliberately takes no options.)
 *
 * Everything else is the real thing: the same middleware, the same global guard, the same
 * boot-time route audit. An authority route added without an access policy fails this suite at
 * `listen`, before a single assertion runs.
 */

export interface AuthorityApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * ⚠️ `overrides` exists for one reason and it is worth stating, because it looks like a
 * convenience and is not.
 *
 * `DATABASE_POOL_MAX` defaults to **10**. A suite that fires N concurrent requests at this app
 * therefore has at most *ten* transactions open at once however large N is — the rest are
 * queued waiting for a connection, and a queued request takes its `BEGIN`, and so its
 * `transaction_timestamp()`, only once a slot frees. That queue is a *serialiser*, and it
 * narrows the exact window a concurrency test is trying to open.
 *
 * `authority-limits.pg.test.ts`'s contiguity test measured this the hard way: at forty writers
 * against a pool of ten, the wrong-clock mutation escaped 1 run in 100. Raising the pool to the
 * number of writers makes "forty concurrent writers" mean forty concurrent *transactions*,
 * which is what the test's name has always claimed. See that file for the numbers.
 */
export function authorityEnv(
  databaseUrl: string,
  overrides: Readonly<Record<string, string>> = {},
): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, ...overrides });
}

export async function bootAuthorityApp(env: Env): Promise<AuthorityApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, {
        session: testSessionConfig(),
        mfaSecretKey: testMfaSecretKey(),
        oauth: parseOAuthConfig({}),
      }),
      AuthorityModule,
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
