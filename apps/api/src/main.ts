import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { parseMfaKey } from './auth/mfa/secret-box';
import { OAuthConfigError } from './auth/oauth/oauth.config';
import { parseSessionConfig, SessionConfigError, type SessionConfig } from './auth/session/session.config';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { createLogger } from './common/logger';
import { EnvValidationError, loadEnv, type Env } from './config/env';
import { RouteAuditError } from './rbac/route-audit.error';

async function bootstrap(env: Env, session: SessionConfig, mfaSecretKey: string): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(env, { session, mfaSecretKey }),
    { logger: createLogger(env) },
  );

  // `X-Powered-By: Express` names the stack to an attacker on every single response.
  app.disable('x-powered-by');

  // Constructed here rather than provided through the container: its one dependency is the
  // same frozen Env that was just passed into the module graph.
  app.useGlobalFilters(new AllExceptionsFilter(env));

  if (env.CORS_ORIGINS.length > 0) {
    app.enableCors({ origin: [...env.CORS_ORIGINS], credentials: true });
  }

  /*
   * Without this, SIGTERM kills the process outright: no drain, no pool.end(), and every
   * in-flight request is a client-side error. With it, Nest runs the shutdown hooks in
   * order — drain in HealthService, then the socket, then the pool in DatabaseService.
   */
  app.enableShutdownHooks();

  await app.listen(env.PORT, env.HOST);
  new Logger('Bootstrap').log(`Listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
}

/**
 * The access-token signing key, or a reason the process is stopping.
 *
 * `AUTH_ACCESS_TOKEN_SECRET` has no default and never will: a default key is a key in the
 * repository, and a key in the repository forges access tokens for every deployment that
 * forgot to set one. Refusing to boot is the correct response — in production.
 *
 * Outside production, an absent secret is filled with 32 fresh random bytes and a warning.
 * That is not a default: it exists only in this process, cannot be known to anything else,
 * and is gone on restart (which signs everybody out, in development, where that is a
 * feature). The alternative was a fresh checkout where `pnpm dev` fails on a variable no
 * `.env.example` copy can usefully supply, which is how people end up committing one.
 */
function sessionConfigFor(env: Env): SessionConfig {
  if (env.NODE_ENV === 'production' || process.env['AUTH_ACCESS_TOKEN_SECRET'] !== undefined) {
    return parseSessionConfig(process.env);
  }

  new Logger('Bootstrap').warn(
    'AUTH_ACCESS_TOKEN_SECRET is not set; signing access tokens with an ephemeral key. ' +
      'Every restart invalidates them. Production refuses to start without it.',
  );
  return parseSessionConfig({
    ...process.env,
    AUTH_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
  });
}

/**
 * ⚠️ Parsed at boot, and required in production with no fallback.
 *
 * A generated default would be worse than a missing value: every restart would mint a new
 * key, every enrolled account's sealed TOTP secret would fail to open, and the symptom
 * would be "MFA randomly stops working" rather than a start-up refusal naming the setting.
 *
 * Development gets a random one for the same reason `sessionConfigFor` does — a developer
 * who has not enrolled anything loses nothing, and a checked-in placeholder key is a key.
 * `parseMfaKey` runs either way, so a malformed value is caught here rather than inside
 * `createCipheriv` at somebody's first enrolment.
 */
function mfaSecretKeyFor(env: Env): string {
  const configured = process.env['AUTH_MFA_SECRET_KEY'];

  if (configured === undefined || configured === '') {
    if (env.NODE_ENV === 'production') {
      throw new SessionConfigError([
        'AUTH_MFA_SECRET_KEY is required but not set — 32 bytes of random data, base64url',
      ]);
    }
    return randomBytes(32).toString('base64url');
  }

  /* Throws a `TypeError` naming the variable; `main` turns that into stderr and exit 1. */
  parseMfaKey(configured);
  return configured;
}

function main(): void {
  let env: Env;
  let session: SessionConfig;
  let mfaSecretKey: string;
  try {
    env = loadEnv();
    // After loadEnv, because it is what read the .env file into process.env.
    session = sessionConfigFor(env);
    mfaSecretKey = mfaSecretKeyFor(env);
  } catch (error) {
    if (
      error instanceof EnvValidationError ||
      error instanceof SessionConfigError ||
      error instanceof OAuthConfigError ||
      error instanceof TypeError
    ) {
      /*
       * Written to stderr rather than thrown: a misconfigured deployment should read its
       * own problem back, not hunt for it inside a stack trace through NestFactory. All
       * three of these are built from variable names and validator text and never from the
       * values, so a mistyped secret cannot arrive in a crash log.
       */
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  bootstrap(env, session, mfaSecretKey).catch((error: unknown) => {
    if (error instanceof OAuthConfigError) {
      // Parsed inside the module graph, so it surfaces here rather than above.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof RouteAuditError) {
      /*
       * Same treatment as EnvValidationError, and for the same reason: an endpoint whose
       * access nobody stated is a mistake in the source, and the fix is a decorator on a
       * named handler. A stack trace through NestFactory would say where the audit runs,
       * which is not where the problem is.
       */
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    new Logger('Bootstrap').fatal('Failed to start', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

main();
