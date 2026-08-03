import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { parseEnv, type Env } from '../../src/config/env';

/** Unroutable on purpose: connects fast enough to fail, never fast enough to succeed. */
export const UNREACHABLE_DATABASE_URL = 'postgres://wewin:wewin@127.0.0.1:1/wewin';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    DATABASE_CONNECT_TIMEOUT_MS: '150',
    ...overrides,
  });
}

export interface BootedApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Boots the real graph — same modules, same middleware, same global filter as main.ts —
 * on an ephemeral port. Anything stubbed here is a difference between what is tested and
 * what ships, so nothing is.
 */
export async function bootApp(env: Env = testEnv()): Promise<BootedApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();

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
