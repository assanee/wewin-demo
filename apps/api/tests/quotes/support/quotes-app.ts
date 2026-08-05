import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../src/app.module';
import { parseOAuthConfig } from '../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../src/config/env';
import { OrdersModule } from '../../../src/orders/orders.module';
import { QuotesModule } from '../../../src/quotes/quotes.module';
import { testSessionConfig } from '../../support/app';

/**
 * The real application graph, plus `QuotesModule`.
 *
 * The `plus` is load-bearing today and should stop being so. `AppModule.forRoot` does **not**
 * import `QuotesModule` — that file is outside this round's ownership — so without naming it
 * here every route in `quotes.controller.ts` would be a 404 and this suite would test nothing.
 * That is precisely the failure phase 5b recorded as its largest finding, and the division of
 * labour is deliberate: `tests/rbac/route-audit.test.ts` is the alarm for the wiring, and this
 * is the exercise for the feature. When the module is added to the application, this line
 * becomes redundant (Nest deduplicates by class reference) and should be left as a statement of
 * what the suite requires.
 *
 * Everything else is the real thing — the same middleware, the same global guard, the same
 * boot-time route audit — which means a quote route added without an access policy fails this
 * suite at `listen`, before a single assertion runs.
 */

export interface QuotesApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function quotesEnv(databaseUrl: string): Env {
  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootQuotesApp(env: Env): Promise<QuotesApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, { session: testSessionConfig(), oauth: parseOAuthConfig({}) }),
      OrdersModule,
      QuotesModule,
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
