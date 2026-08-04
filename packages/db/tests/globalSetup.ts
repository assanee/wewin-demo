import { createDatabase, createPool } from '../src/client.js';
import { seedCatalog } from '../src/seed.js';
import { provisionTestDatabase } from '../src/test-database.js';

import { TEST_DATABASE_NAME, testDatabaseUrlOrSkip } from './test-db.js';

/**
 * A database that did not exist a minute ago, on every run.
 *
 * `tests/support/db.ts` runs the migrations itself and always did; what it could not do is
 * un-create the rows a run leaves behind. Since phase 5a those include submitted orders,
 * which `orders_block_delete()` refuses to delete and which make `seedCatalog` refuse to run
 * ever again on that database — so "the suite left the database in a state the suite cannot
 * start from" became reachable, and reached.
 *
 * Dropping and recreating is the only teardown the schema cannot veto. See
 * `src/test-database.ts` for the whole argument.
 */
export async function setup(): Promise<void> {
  const url = testDatabaseUrlOrSkip();
  if (!url) return; // No .env, no server: the suites skip themselves and say so.

  /*
   * Migrated *and* seeded, so that every file in this package can run on its own.
   *
   * `tests/support/db.ts` applies the migrations too, on its first connection, and keeps
   * doing so — running them through the same client the tests use is half of what
   * `constraints.test.ts` asserts. Drizzle records what it has applied, so the second call is
   * a no-op and the two do not fight.
   *
   * The seed is here because `tests/order.test.ts` needs a *published* catalogue version to
   * cite, and it was getting one only because `seed.test.ts` happens to sort earlier and
   * leaves one behind. That is precisely the order dependence this project keeps banning: the
   * file passed in a full run and failed on its own, which is the direction that hides a real
   * failure rather than showing one.
   */
  await provisionTestDatabase(url, TEST_DATABASE_NAME);

  const pool = createPool(url);
  try {
    await seedCatalog(createDatabase(pool));
  } finally {
    await pool.end();
  }
}
