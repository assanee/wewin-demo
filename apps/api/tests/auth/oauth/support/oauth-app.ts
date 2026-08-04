import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AllExceptionsFilter } from '../../../../src/common/errors/all-exceptions.filter';
import { ConfigModule } from '../../../../src/config/config.module';
import { parseEnv } from '../../../../src/config/env';
import { DatabaseModule } from '../../../../src/database/database.module';
import { OAuthModule } from '../../../../src/auth/oauth/oauth.module';
import type { OAuthConfig } from '../../../../src/auth/oauth/oauth.config';
import type {
  IssuedSession,
  SessionIssueRequest,
  SessionIssuer,
} from '../../../../src/auth/oauth/session-issuer';
import type { ProviderName, ResolvedProvider } from '../../../../src/auth/oauth/providers/provider.types';
import type { FakeProvider } from './fake-provider';

/**
 * The real graph, with two substitutions and no third.
 *
 * The provider endpoints point at a fake this process controls, and the session issuer is a
 * recorder instead of the module that will own refresh rotation. Everything else — the
 * controller, the state service with its single-statement consume, the linking rule, the
 * JWT verifier, the HTTP client, Postgres — is what ships. Anything else stubbed here would
 * be a difference between what is tested and what runs.
 *
 * `AppModule` is not used because it does not import `OAuthModule` yet: this module and the
 * two beside it are being written in the same round, and wiring them together is the last
 * step rather than this one's to take.
 */

/**
 * Records what the OAuth flow asked for, and hands back a cookie it invented.
 *
 * Not a session: minting one means minting a refresh token, and rotation (fix ⓒ) belongs to
 * exactly one module. What this asserts is the seam — that a sign-in ends by asking for a
 * session for a specific user id, and that a *failed* sign-in never asks at all.
 */
export class RecordingSessionIssuer implements SessionIssuer {
  readonly issued: SessionIssueRequest[] = [];

  async issueForUser(request: SessionIssueRequest): Promise<IssuedSession> {
    this.issued.push(request);
    return { cookies: [`wewin_session=issued-for-${request.userId}; Path=/; HttpOnly`] };
  }

  get lastUserId(): string | undefined {
    return this.issued.at(-1)?.userId;
  }

  reset(): void {
    this.issued.length = 0;
  }
}

export interface BootedOAuthApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly sessions: RecordingSessionIssuer;
  readonly close: () => Promise<void>;
}

export interface BootOptions {
  readonly databaseUrl: string;
  readonly provider: FakeProvider;
  readonly cookieSecure?: boolean;
  readonly stateTtlSeconds?: number;
  readonly webBaseUrl?: string;
  /** Known before the app binds, because the redirect URI has to name it. */
  readonly port: number;
}

export const WEB_BASE_URL = 'https://shop.example';

/**
 * Configuration built as a value rather than parsed from the environment.
 *
 * This is what `OAuthConfig` being plain data buys: the endpoints point at the fake, and
 * `src/` contains no `NODE_ENV === 'test'` branch anywhere to make that possible.
 */
export function configFor(options: BootOptions): OAuthConfig {
  const { provider } = options;
  const name: ProviderName = provider.mode;

  const resolved: ResolvedProvider = {
    name,
    clientId: provider.clientId,
    secret:
      name === 'apple'
        ? {
            kind: 'apple-jwt',
            teamId: 'TEAMID1234',
            keyId: 'KEYID56789',
            privateKeyPem: provider.applePrivateKeyPem,
          }
        : { kind: 'static', value: provider.clientSecret },
    redirectUri: `http://127.0.0.1:${String(options.port)}/auth/oauth/${name}/callback`,
    endpoints: provider.endpoints(),
  };

  return {
    webBaseUrl: options.webBaseUrl ?? WEB_BASE_URL,
    failurePath: '/login',
    cookieSecure: options.cookieSecure ?? false,
    stateTtlSeconds: options.stateTtlSeconds ?? 600,
    providers: new Map([[name, resolved]]),
  };
}

/**
 * A port nobody is using, released immediately.
 *
 * The redirect URI is part of the configuration *and* is compared byte for byte by the
 * provider at the token endpoint, so it has to be known before the app binds — which rules
 * out `listen(0)` and reading the port afterwards. The gap between closing this socket and
 * Nest opening one is a race in principle; on a loopback interface in a test process it has
 * never lost, and losing it is a bind error rather than a silent pass.
 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function bootOAuthApp(options: BootOptions): Promise<BootedOAuthApp> {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: options.databaseUrl,
    DATABASE_CONNECT_TIMEOUT_MS: '5000',
  });

  const sessions = new RecordingSessionIssuer();

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot(env),
      DatabaseModule,
      OAuthModule.forRoot({
        config: configFor(options),
        sessionIssuer: sessions,
        httpTimeoutMs: 4_000,
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  app.enableShutdownHooks();
  await app.listen(options.port, '127.0.0.1');

  return {
    app,
    baseUrl: `http://127.0.0.1:${String(options.port)}`,
    sessions,
    close: async () => {
      await app.close();
    },
  };
}
