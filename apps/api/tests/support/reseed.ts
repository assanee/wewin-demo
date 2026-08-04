import { createDatabase, createPool } from '@wewin/db/client';
import { seedCatalog } from '@wewin/db/seed';
import { provisionTestDatabase } from '@wewin/db/test-database';

import { TEST_DATABASE_NAME } from '../test-db';

/**
 * Put the catalogue back to its seeded state — including on a database that has since
 * acquired contracts.
 *
 * ── Two rules that are both right and that met head-on ───────────────────────────
 *
 * `seedCatalog` truncates and rewrites the catalogue, because a seed that merged would leave
 * behind whatever a previous run created and this one no longer produces — which is how a
 * withdrawn product goes on being sold. Two suites here (`catalog-fidelity`,
 * `catalog-admin`) call it in `beforeAll` because they prove things that can only be proved
 * by *changing* the catalogue, and a published document is frozen so nothing can be undone
 * afterwards.
 *
 * `order_document_versions_block_truncate()` refuses that truncate on any database carrying a
 * contract, because `TRUNCATE … CASCADE` walks foreign keys, does **not** respect
 * `ON DELETE RESTRICT`, and would silently empty the table recording which catalogue version
 * each pinned document was priced from.
 *
 * Neither is negotiable, and `globalSetup` creating a fresh database per run is not enough:
 * within one run, an order suite submits an order and the catalogue suites then cannot
 * re-seed. Vitest does not order files alphabetically, so which files those are is not even
 * stable.
 *
 * ── What this does instead ───────────────────────────────────────────────────────
 *
 * It follows the trigger's own hint: *"seed a fresh database, or delete the orders first"*.
 * Deleting the orders is what the schema forbids, so it seeds a fresh database — dropping and
 * recreating this suite's own, then migrating and seeding it. The production rule is left
 * exactly as it is, and no test learns to launder evidence to stay green.
 *
 * The cost is that a run's earlier orders disappear at this point. That is safe because every
 * file here creates its own fixtures in its own `beforeAll`, and it is not silent: the reset
 * happens before the caller boots its application, which is why this must be the *first*
 * thing a suite that needs it does.
 */
export async function reseedCatalogue(databaseUrl: string, coreVersion?: string): Promise<void> {
  if (await seeded(databaseUrl, coreVersion)) return;

  await provisionTestDatabase(databaseUrl, TEST_DATABASE_NAME);
  if (!(await seeded(databaseUrl, coreVersion))) {
    throw new Error('reseedCatalogue: the catalogue would not seed even on a fresh database');
  }
}

/** True when the seed ran; false only for the refusal this function exists to answer. */
async function seeded(databaseUrl: string, coreVersion?: string): Promise<boolean> {
  const pool = createPool(databaseUrl);
  try {
    await seedCatalog(createDatabase(pool), coreVersion);
    return true;
  } catch (error) {
    /*
     * `restrict_violation` from the truncate guard, and nothing else. Any other failure is a
     * real one and must not be turned into "drop the database and try again", which would
     * hide a broken migration behind a reset that appears to fix it.
     */
    if (causeCode(error) !== '23001') throw error;
    return false;
  } finally {
    await pool.end();
  }
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
