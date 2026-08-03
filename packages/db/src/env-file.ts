import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Finding the `.env` that names this repository's one Postgres.
 *
 * Not exported from the package: this is tooling — the seed binary, `drizzle.config.ts`
 * and the test harness — and apps/api owns its own copy for its own reasons (it has to
 * report a missing variable as a boot failure, this one has to stay silent). The rule is
 * shared, the handling is not.
 *
 * The walk goes up because there is one docker-compose.yml and it is at the workspace
 * root, so the connection string that names it belongs there too. A `.env` beside this
 * package still wins, which is what lets a developer point migrations at a scratch server
 * without repointing everything else. The walk stops at `pnpm-workspace.yaml` so it can
 * never reach a `.env` belonging to an unrelated checkout above this one.
 *
 * Nothing is defaulted when no file is found, here or in `drizzle.config.ts`, and the
 * reason is the same in both: these entry points truncate and migrate, and a default is
 * how that lands on a server somebody cared about.
 */
export function loadEnvFileIfPresent(directory: string): string | undefined {
  for (let current = resolve(directory); ; current = dirname(current)) {
    const path = resolve(current, '.env');
    if (existsSync(path)) {
      // Fills gaps, never overwrites — so `DATABASE_URL=… pnpm db:migrate` still wins
      // over a file somebody forgot about.
      process.loadEnvFile(path);
      return path;
    }
    if (existsSync(resolve(current, 'pnpm-workspace.yaml')) || dirname(current) === current) {
      return undefined;
    }
  }
}
