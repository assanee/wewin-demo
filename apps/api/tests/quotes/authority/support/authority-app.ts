import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../../src/app.module';
import { parseOAuthConfig } from '../../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../../src/config/env';
import { testSessionConfig , testMfaSecretKey } from '../../../support/app';

/**
 * The real application graph, and **only** the real application graph.
 *
 * ⚠️ This file used to name `AuthorityModule` in the imports beside `AppModule.forRoot(…)`, with a
 * paragraph explaining that nothing had wired it yet. That has not been true since the module was
 * added to `AppModule.forRoot`'s import list (`app.module.ts`, beside `QuotesModule`, with the
 * note about that omission having been "the largest finding of the round"). The claim is deleted
 * rather than left as harmless decoration, because it was neither harmless nor decoration: a
 * harness that imports the module itself **cannot fail** when the application stops importing it,
 * and this suite is the one that exercises every authority and write-off route over real HTTP. It
 * would have gone on passing against an assembled application serving 404s — which is precisely
 * the outage the comment was describing as historical.
 *
 * `tests/rbac/route-audit.test.ts` and `tests/rbac/controller-reachability.test.ts` are the
 * dedicated alarms; this file is now simply one more caller that would go red with them.
 *
 * Everything here is the real thing: the same middleware, the same global guard, the same
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
