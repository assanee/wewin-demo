import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which database this suite runs against, decided in one place.
 *
 * Imported by `vitest.config.ts` (which puts the URL in every worker's environment) and by
 * `globalSetup.ts` (which creates that database before any worker starts). Both derive it
 * from the same base and the same name, so there is no way to run the tests against a
 * database nobody provisioned — a mistake that presents as "relation does not exist" in a
 * file that has nothing to do with the cause.
 *
 * It is a plain `.ts` under `tests/` rather than a helper in `src/` because a vitest config
 * is loaded before anything is built, so it can only import source, and nothing that ships
 * should know a test database exists.
 */

/**
 * Not `wewin`. `apps/api`'s suites submit orders, and a submitted order cannot be deleted,
 * cannot have its document unfrozen, and blocks `seedCatalog` from ever running again on
 * that database (`order_document_versions_block_truncate`). The suite therefore needs a
 * database it is allowed to destroy, and a developer needs one that the suite will not
 * destroy. Two names is the whole fix.
 */
export const TEST_DATABASE_NAME = 'wewin_api_test';

/**
 * The workspace-root `.env`, parsed by hand — see the note in vitest.config.ts.
 *
 * Located from `process.cwd()` and not from `import.meta.url`, which this package's
 * `tsconfig` cannot accept: `apps/api` emits CommonJS, and a file under `tests/` is
 * typechecked with the rest of it. Vitest runs with the project root as the working
 * directory, and both readers of this function — the config and `globalSetup` — run in that
 * same process.
 */
export function rootEnv(): Record<string, string> {
  try {
    const entries: [string, string][] = [];

    for (const line of readFileSync(resolve(process.cwd(), '../../.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;

      entries.push([
        trimmed.slice(0, eq).trim(),
        trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, ''),
      ]);
    }

    return Object.fromEntries(entries);
  } catch {
    // No .env — the Postgres suites skip themselves and say so. Nothing to invent here.
    return {};
  }
}

/**
 * The connection string the suite should use, or undefined when there is no server.
 *
 * `DATABASE_URL` already exported in the shell wins over the file, matching
 * `loadEnvFileIfPresent`'s rule everywhere else in the repository: an explicit export is a
 * decision, a file is a default.
 */
export function testDatabaseUrlOrSkip(): string | undefined {
  const base = process.env['DATABASE_URL'] ?? rootEnv()['DATABASE_URL'];
  if (!base) return undefined;

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}
