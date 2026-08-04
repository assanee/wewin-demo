import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { parseOAuthConfig } from '../../src/auth/oauth/oauth.config';
import { parseSessionConfig, type SessionConfig } from '../../src/auth/session/session.config';
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

/**
 * A signing key that exists only for the length of this process.
 *
 * Not a fixture value, and deliberately not a constant anywhere: a secret literal in a test
 * file is a secret literal in the repository, and the one thing worse than that is one that
 * happens to be the same string a developer copied into a `.env`.
 */
export function testSessionConfig(overrides: Record<string, string> = {}): SessionConfig {
  return parseSessionConfig({
    AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
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
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(env, {
        session: testSessionConfig(),
        // Explicit and empty. Left out, the OAuth module would parse `process.env`, so a
        // developer with real credentials in their `.env` would run a different graph from
        // CI — and a suite that boots differently on two machines has tested neither.
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
