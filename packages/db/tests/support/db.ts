import { afterAll, describe } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, createPool, type Database, type Pool } from '../../src/client.js';
import { loadEnvFileIfPresent } from '../../src/env-file.js';

/**
 * The connection every test file in this package shares.
 *
 * `DATABASE_URL` is not defaulted, here or in drizzle.config.ts, for the same reason:
 * these tests truncate the catalogue, and a default is how that lands on a server
 * somebody cared about. A checkout with no `.env` skips the suite loudly rather than
 * inventing a target — `pnpm db:up && cp .env.example .env` at the workspace root is the
 * whole setup, and the file is found from here without any flag on the script.
 */

// Node's own loader, so the package needs no dotenv dependency to run its tests. It
// searches this package first and then the workspace root, because the root is where the
// one docker-compose.yml lives and a checkout that only ran `cp .env.example .env` there
// must not silently skip the entire integration suite.
loadEnvFileIfPresent(new URL('../..', import.meta.url).pathname);

const url = process.env['DATABASE_URL'];

export const describeDb = describe.skipIf(!url);

if (!url) {
  // `process.stderr.write` and not `console.warn`: Vitest intercepts console and pins each
  // line to the test file that wrote it, and this module is imported before any file is
  // running — so the warning was produced and then dropped, which is the exact failure it
  // exists to prevent.
  process.stderr.write(
    '\n[@wewin/db] DATABASE_URL is not set — the integration tests are SKIPPED, not passing.\n' +
      '            `pnpm db:up && cp .env.example .env` at the workspace root.\n\n',
  );
}

let cached: { db: Database; pool: Pool } | undefined;

/**
 * One pool per test file, shared by every suite in it.
 *
 * A file with three `describe`s used to open one pool and close it three times, and the
 * second suite failed with "cannot use a pool after end" — a failure that reads like a
 * connection problem and is really a lifetime problem. The teardown is registered here,
 * once, at import time, so no suite has to remember it and none can do it twice.
 */
export async function connect(): Promise<Database> {
  if (cached) return cached.db;
  if (!url) throw new Error('connect() called without DATABASE_URL');

  const pool = createPool(url);
  const db = createDatabase(pool);

  // Same migrations, same order as `pnpm db:migrate`: a test that ran against a schema
  // built any other way would be testing something that never ships.
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });

  cached = { db, pool };
  return db;
}

/**
 * The same pool, for the tests that need two connections at once.
 *
 * `tests/auth.test.ts` proves that a unique index and not a service method is what makes
 * two simultaneous claims on one email address mutually exclusive, and that requires two
 * transactions open at the same instant — which is two clients, not two awaits on one.
 * It goes through `connect()` so the migrations are applied exactly once either way.
 */
export async function connectPool(): Promise<Pool> {
  await connect();
  if (!cached) throw new Error('connect() returned without opening a pool');
  return cached.pool;
}

afterAll(async () => {
  const open = cached;
  cached = undefined;
  await open?.pool.end();
});

/** Postgres error codes the tests assert on, named so an assertion reads as a sentence. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  /** What the freeze triggers raise, via `USING ERRCODE = 'restrict_violation'`. */
  restrictViolation: '23001',
} as const;

/**
 * The SQLSTATE of a thrown pg error.
 *
 * Two things make this more than a property read. Drizzle wraps driver errors in a
 * `DrizzleQueryError` and puts the original on `cause`, so the code is one level down;
 * and pg's `code` is on no type the driver exports, so it is read defensively rather
 * than cast. A test that compared `undefined` to `undefined` would pass for the wrong
 * reason, which is the failure mode worth spending ten lines on.
 */
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') return code;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}
