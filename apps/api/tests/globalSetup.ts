import { createDatabase, createPool } from '@wewin/db/client';
import { seedCatalog } from '@wewin/db/seed';
import { provisionTestDatabase } from '@wewin/db/test-database';

import { TEST_DATABASE_NAME, testDatabaseUrlOrSkip } from './test-db';

/**
 * Build the database this suite runs against, from nothing, before anything starts.
 *
 * ── What this used to be, and why it stopped working ─────────────────────────────
 *
 * It used to be one call to `seedCatalog` against the developer's own database. The reason
 * was sound and still is: several suites here prove things that can only be proved by
 * changing the catalogue — that the admin publish path reproduces a seeded document byte for
 * byte, that publishing archives its predecessor — and none of those can be undone
 * afterwards, because a published document is frozen on purpose. So the guarantee was put at
 * the front: whatever the last run left behind, this run starts from the seed.
 *
 * Phase 5a broke that, and not by accident. `seedCatalog` truncates the catalogue;
 * `order_document_product_versions` records which published document each contract was priced
 * from; `order_document_versions_block_truncate()` therefore refuses the seed on any database
 * that carries a contract. One submitted order — a thing the order suites exist to
 * create — and every later run of this suite failed in `beforeAll`, turning 116 catalogue
 * tests into *skips* while the run still printed passes.
 *
 * Both rules are right. Pointing them at one database was the mistake. So the reset moved up
 * a level: drop the database, create it, migrate it, seed it. Nothing survives a run, so
 * nothing a run does can poison the next one, and the developer's own database is not
 * involved at all.
 *
 * The side effect is worth having: every single run now proves that `drizzle/` applies to an
 * empty database and that the seed works on the result — the `docker compose down -v` path,
 * exercised continuously rather than checked by hand at the end of a phase.
 */
export async function setup(): Promise<void> {
  const url = testDatabaseUrlOrSkip();
  if (!url) return; // Postgres-backed suites skip themselves; nothing to reset.

  await provisionTestDatabase(url, TEST_DATABASE_NAME);

  const pool = createPool(url);
  try {
    await seedCatalog(createDatabase(pool));
  } finally {
    await pool.end();
  }
}
