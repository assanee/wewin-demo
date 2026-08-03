import { createDatabase, createPool } from '../client.js';
import { loadEnvFileIfPresent } from '../env-file.js';
import { seedCatalog } from '../seed.js';

/**
 * `pnpm db:seed`.
 *
 * Thin on purpose: everything it does is in `seedCatalog`, where a test can call it.
 * A seed that only exists as a script is a seed nothing can check.
 */

// Searches this package and then the workspace root; the `--env-file-if-exists` flag this
// replaces could only ever name one of the two.
loadEnvFileIfPresent(import.meta.dirname);

const url = process.env['DATABASE_URL'];

if (!url) {
  console.error('DATABASE_URL is not set. `cp .env.example .env` and `pnpm db:up`.');
  process.exit(1);
}

const pool = createPool(url);

try {
  const result = await seedCatalog(createDatabase(pool));
  console.log(
    `seeded ${result.products} products · ${result.categories} categories · ` +
      `${result.optionGroups} option groups · ${result.optionValues} option values · ` +
      `${result.publishedVersions} published versions`,
  );
} finally {
  await pool.end();
}
