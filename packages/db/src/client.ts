import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index.js';

/**
 * The connection, in one place so apps/api has nothing to decide.
 *
 * node-postgres rather than a driver that parses ahead of the query: every exact
 * column in this schema is `bigint`, and `pg` hands int8 back as a string, which
 * drizzle's `mode: 'bigint'` turns into a `bigint` on the way out. That chain is what
 * `tests/bigint.test.ts` pins — a driver swap that broke it would otherwise show up as
 * prices that are right until they are large.
 */

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(pool: Pool) {
  // No `casing` option: every column names itself in `src/schema`, so there is nothing
  // for a convention to infer and nothing that changes meaning if the default moves.
  return drizzle(pool, { schema });
}

export function createPool(config: PoolConfig | string): Pool {
  return typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config);
}

export { schema };
export type { Pool };
