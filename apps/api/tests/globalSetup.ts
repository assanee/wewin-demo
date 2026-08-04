import { createDatabase, createPool } from '@wewin/db/client';
import { seedCatalog } from '@wewin/db/seed';

/**
 * Put the catalogue back to its seeded state before the suite starts.
 *
 * Several suites here prove things that can only be proved by changing the catalogue —
 * that the admin publish path reproduces a seeded document byte for byte, that a
 * published version archives its predecessor. None of those can be undone by deleting
 * rows afterwards, because a published document is frozen on purpose.
 *
 * So the guarantee is at the front instead: whatever the last run left behind, this run
 * starts from the seed. Without it the fidelity suite is a coin toss over which files
 * ran first, and a coin toss that lands green is worse than a failure.
 */
export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // Postgres-backed suites skip themselves; nothing to reset.

  const pool = createPool(url);
  try {
    await seedCatalog(createDatabase(pool));
  } finally {
    await pool.end();
  }
}
