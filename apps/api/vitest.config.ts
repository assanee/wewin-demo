import { defineConfig } from 'vitest/config';

import { rootEnv, testDatabaseUrlOrSkip } from './tests/test-db';

/**
 * The connection string lives in the workspace-root `.env`, and it is read here rather
 * than left to Vite's env loading, which populates `import.meta.env` and not
 * `process.env` for names without a `VITE_` prefix.
 *
 * Declaring a config at all is what made this bite. With no config the Postgres-backed
 * suites found their URL and ran; adding one turned 93 of them from passing to *skipped*
 * while the run still reported success. Skipped is not passed, and a runner that says
 * "successful" either way is the failure mode this project keeps meeting — so the
 * lookup is explicit and a missing file is visible rather than silently empty.
 *
 * What it does **not** hand the workers is the URL as written. Every Postgres-backed suite
 * here runs against a database of this suite's own, created empty by `tests/globalSetup.ts`
 * on every run — see `tests/test-db.ts` for why the shared one stopped working the day an
 * order could be submitted. Both `DATABASE_URL` and `TEST_DATABASE_URL` are overwritten,
 * because the test files are split between the two names and a file left reading the
 * developer's own database would be the one that destroyed it.
 */
function suiteEnv(): Record<string, string> {
  const file = rootEnv();
  const url = testDatabaseUrlOrSkip();
  if (url === undefined) return file;

  return { ...file, DATABASE_URL: url, TEST_DATABASE_URL: url };
}

/**
 * Postgres-backed suites share one database, so they cannot run concurrently.
 *
 * Phase 4 found this the hard way: `catalog-fidelity.pg.test.ts` passed on its own and
 * failed after the admin suite, because publishing a seeded product — which is exactly
 * what that suite is meant to prove works — leaves a new published version behind, and a
 * published document is frozen so no `DELETE` can take it back. The suite was reporting
 * green or red depending on the order files happened to run in, which says nothing about
 * the code either way.
 *
 * Two halves to the fix. This file is the first: one fork, one file at a time, so a suite
 * that restores what it changed can actually be relied on to have finished doing it. The
 * second is `tests/globalSetup.ts`, which reseeds before anything starts.
 */
export default defineConfig({
  test: {
    env: suiteEnv(),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    /*
     * The other half of the shared-database problem, and the half `globalSetup` cannot solve.
     *
     * `globalSetup` guarantees every *run* starts from a freshly migrated and seeded database.
     * It says nothing about what one file leaves behind for the next one **inside** a run, and a
     * few tables here hold a permanently-seeded singleton that nothing can delete. This registers
     * one `afterAll` in every file that checks those rows are still seeded — so a suite that
     * changes `organisation_profile.deposit_bp` or `tax_countries.TH` and forgets to restore it
     * fails by name, instead of a file forty places later failing for a reason that is not its
     * own. See `tests/setup/seeded-singletons.ts` for the two runs that motivated it.
     */
    setupFiles: ['tests/setup/seeded-singletons.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
