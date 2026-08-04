import { defineConfig } from 'vitest/config';

import { testDatabaseUrlOrSkip } from './tests/test-db.js';

/**
 * Point every worker at this suite's own database, never at the one in `.env`.
 *
 * These files truncate the catalogue and create orders that the schema deliberately refuses
 * to let anything delete, so the database they run against has to be one whose whole
 * lifetime is a single run — `tests/globalSetup.ts` creates it. See `tests/test-db.ts`.
 */
function suiteEnv(): Record<string, string> {
  const url = testDatabaseUrlOrSkip();
  return url === undefined ? {} : { DATABASE_URL: url };
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: suiteEnv(),
    globalSetup: ['tests/globalSetup.ts'],
    // The integration tests share one server and one set of catalogue rows. Running
    // files in parallel would have one file's truncate land in the middle of another
    // file's assertions, which reads as a flake rather than as the collision it is.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
