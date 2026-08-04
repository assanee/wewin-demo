import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

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
 */
function rootEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../../.env', import.meta.url), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
        })
        .filter(([key]) => key.length > 0),
    );
  } catch {
    // No .env — the Postgres suites skip themselves and say so. Nothing to invent here.
    return {};
  }
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
    env: rootEnv(),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
