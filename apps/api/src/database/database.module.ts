import { Global, Logger, Module } from '@nestjs/common';
import pg, { type Pool } from 'pg';
import { createDatabase } from '@wewin/db/client';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DatabaseService } from './database.service';
import { DRIZZLE, PG_POOL } from './database.tokens';
import { bigintAwareTypes } from './pg-types';

export function createPool(env: Env): Pool {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'wewin-api',
    types: bigintAwareTypes,
  });

  /*
   * An idle client whose connection drops emits 'error' on the pool. With no listener
   * that is an unhandled 'error' event, which takes the process down — a database restart
   * would otherwise kill an API that was about to reconnect perfectly well.
   */
  const logger = new Logger('PgPool');
  pool.on('error', (error) => {
    logger.error(`Idle client error: ${error.message}`, error.stack);
  });

  return pool;
}

/*
 * The pool lives in the app, not in packages/db. db owns the Drizzle *schema* (plan
 * section 1); connection lifetime, pool sizing and shutdown ordering are runtime concerns
 * that belong to the process that has a lifecycle. `createDatabase` is db's own factory
 * rather than a `drizzle(pool, { schema })` call spelled out here, so the schema this app
 * queries through is the one the migrations were generated from — there is no second
 * place to pass a different one.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: createPool,
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: createDatabase,
    },
    DatabaseService,
  ],
  exports: [PG_POOL, DRIZZLE, DatabaseService],
})
export class DatabaseModule {}
