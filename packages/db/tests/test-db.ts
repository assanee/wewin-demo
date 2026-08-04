import { loadEnvFileIfPresent } from '../src/env-file.js';

/**
 * Which database this package's integration tests run against.
 *
 * The same decision, and the same reasons, as `apps/api/tests/test-db.ts`: these suites
 * truncate the catalogue and — since `tests/order.test.ts` — create orders that the schema
 * deliberately refuses to let anything delete. A suite that cannot clean up after itself must
 * not be pointed at a database anybody keeps anything in.
 *
 * Imported by `vitest.config.ts` and by `tests/globalSetup.ts` so that the name is decided
 * once, and by nothing that ships.
 */

export const TEST_DATABASE_NAME = 'wewin_db_test';

/** The base connection string from the environment or the nearest `.env`, unmodified. */
export function baseDatabaseUrl(): string | undefined {
  loadEnvFileIfPresent(new URL('..', import.meta.url).pathname);
  return process.env['DATABASE_URL'];
}

export function testDatabaseUrlOrSkip(): string | undefined {
  const base = baseDatabaseUrl();
  if (!base) return undefined;

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}
