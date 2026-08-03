// Nest's decorators write to the metadata registry this installs. Importing it once here
// is the equivalent of main.ts's first line.
import 'reflect-metadata';

import { loadEnvFileIfPresent } from '../src/config/env';

/*
 * The same .env this app boots from, found the same way (see loadEnvFileIfPresent).
 *
 * Without this the database-backed suites skipped and `turbo run test` still reported
 * success — 97 of 115 tests skipped, including the 91 that are the whole point of phase
 * 3a. Vitest inherits the environment Turbo hands the task, and Turbo's strict env mode
 * passes DATABASE_URL through only when it is already set in the shell; a laptop with a
 * .env on disk and no export got a green run that had proven nothing.
 *
 * Loading it here rather than in a `--env-file` flag on the script keeps one rule for the
 * whole app: `.env` fills gaps, an explicit `DATABASE_URL=… pnpm test` still wins, and a
 * checkout with no file at all still skips loudly instead of inventing a target.
 */
loadEnvFileIfPresent();

/*
 * A skipped suite that says nothing is how the run above stayed green. Vitest prints the
 * skip count, but "99 skipped" next to "21 passed" reads as housekeeping unless something
 * says what was skipped and why.
 *
 * `process.stderr.write` and not `console.warn`: Vitest intercepts console and attributes
 * each line to the test file that produced it, and a setup file runs before there is one —
 * so the warning was written and then dropped. Verified by watching it not appear.
 */
if (!process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL']) {
  process.stderr.write(
    '\n[@wewin/api] DATABASE_URL is not set — the catalogue fidelity suite is SKIPPED, not passing.\n' +
      '             `pnpm db:up && cp .env.example .env && pnpm db:migrate` at the workspace root.\n\n',
  );
}

