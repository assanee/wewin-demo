import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../src/app.module';
import { parseOAuthConfig } from '../../../src/auth/oauth/oauth.config';
import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../../src/config/env';
import { OrdersModule } from '../../../src/orders/orders.module';
import { testSessionConfig } from '../../support/app';

/**
 * The real application graph, plus `OrdersModule`.
 *
 * ⚠️ **`ReviewsModule` is deliberately *not* named here, and the reason is a trap worth
 * keeping written down.** This file used to import `ReviewsModule.forRoot({…})` alongside
 * `AppModule`, on the stated grounds that "Nest deduplicates by class reference, so the day it
 * is imported this stays correct and changes nothing". That is true of a static module class
 * and **false of a dynamic one**: `forRoot()` builds a fresh `DynamicModule` object per call,
 * there is no shared reference to deduplicate by, and Nest registers the controllers twice.
 *
 * The day `AppModule` gained the module, every handler in it had two registrations, the
 * boot-time route audit refused the application with thirteen "shares one handler function"
 * problems, and the suite reported **`18 skipped`** — the failure was in `beforeAll`, so the
 * count of failing *tests* stayed zero. A run that reads as green while the app will not boot.
 *
 * The same mistake, with the same false justification, took a phase to find in the payments
 * round. The bucket override that used to live in those braces is now an environment variable
 * set in `reviewsEnv`, because `AppModule` owns the `forRoot` call.
 *
 * This is the second half of a pair. Phase 5b and phase 5c each shipped a complete module
 * `AppModule` did not import, both times with a green suite exactly like this one, and both
 * times every route was a 404 against the assembled application — a suite that boots its own
 * graph proves the feature works and proves nothing about whether anybody can reach it.
 * `tests/rbac/controller-reachability.test.ts` is now what catches that, so this file no
 * longer has to compensate for it by importing the module itself.
 *
 * Everything else is the real thing: the same middleware, the same global guard, the same
 * boot-time route audit — which means a review route added without an access policy fails
 * this suite at `listen`, before a single assertion runs.
 */

export interface ReviewsApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function reviewsEnv(databaseUrl: string): Env {
  /*
   * A bucket that is neither the media bucket nor the slip bucket, so this suite does not
   * depend on a developer's `.env` — and set here, on `process.env`, rather than handed to
   * `ReviewsModule.forRoot`, because `AppModule` now owns that call and reads it from the
   * environment. Nothing connects at construction, so the graph still boots with no object
   * storage running; every test here except a photograph upload is unaffected.
   */
  process.env['REVIEW_PHOTO_STORAGE_BUCKET'] = 'wewin-review-photos-test';

  return parseEnv({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });
}

export async function bootReviewsApp(env: Env): Promise<ReviewsApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, { session: testSessionConfig(), oauth: parseOAuthConfig({}) }),
      OrdersModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: ['error'] });
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
