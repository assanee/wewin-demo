import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../../src/app.module';
import { parseOAuthConfig } from '../../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../../src/config/env';
/* The file, not the directory: `src/quotes/authority.ts` shadows `authority/index.ts`. */
import { AuthorityModule } from '../../../../src/quotes/authority/authority.module';
import { testSessionConfig } from '../../../support/app';

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

export function authorityEnv(databaseUrl: string): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootAuthorityApp(env: Env): Promise<AuthorityApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, { session: testSessionConfig(), oauth: parseOAuthConfig({}) }),
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
