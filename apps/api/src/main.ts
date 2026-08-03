import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { createLogger } from './common/logger';
import { EnvValidationError, loadEnv, type Env } from './config/env';

async function bootstrap(env: Env): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    logger: createLogger(env),
  });

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

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      /*
       * Written to stderr rather than thrown: a misconfigured deployment should read its
       * own problem back, not hunt for it inside a stack trace through NestFactory.
       */
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  bootstrap(env).catch((error: unknown) => {
    new Logger('Bootstrap').fatal('Failed to start', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

main();
