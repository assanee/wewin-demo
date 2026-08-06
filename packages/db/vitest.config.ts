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
    /*
     * And one fork, not just one file at a time. `fileParallelism: false` serialises the
     * files; it does not stop the pool holding several processes, and these suites share a
     * server, a set of catalogue rows, and triggers they disable and re-enable around their
     * own cleanup. apps/api settled this the same way in phase 4.
     *
     * ⚠️ This setting was *also* credited with fixing two freeze-point tests that went red
     * under a full `turbo run test` and passed alone. That diagnosis was wrong, and the
     * tests came back red in phase 7 as soon as another file ran before them. The cause was
     * never concurrency: `submit` stamped `submitted_at` from Node's clock while the freeze
     * trigger used Postgres's, and `orders_frozen_after_submitted` compares the two. Passing
     * alone was the cold pool leaving a gap wider than the 25 ms skew. Both helpers now use
     * `now()`, `order.repository.ts` had the identical bug in production, and
     * `lifecycle.pg.test.ts` pins it by winding Node's clock a minute forward.
     *
     * Kept here as a warning: "serialising made it green" is what a timing bug looks like
     * when you slow it down, and it will come back the moment something else gets faster.
     */
    pool: 'forks',
    // Vitest 4 lifted the old `poolOptions.forks.*` to the top level; one worker is the
    // whole point, so the pool cannot hold a second process against the same database.
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
