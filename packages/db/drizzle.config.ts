import { defineConfig } from 'drizzle-kit';

import { loadEnvFileIfPresent } from './src/env-file.js';

/**
 * drizzle-kit reads the schema in `src` — the TypeScript, not the build output — so a
 * migration can be generated without building first. What ships is still `dist`; this
 * tool never runs in production.
 *
 * `DATABASE_URL` is deliberately not defaulted. A default is how a `drizzle-kit push`
 * meant for a scratch container lands on something else, and the error from a missing
 * variable is a better outcome than a migration applied to the wrong server.
 */
// drizzle-kit does read a `.env` beside the config, but only that one. This finds the
// workspace-root file too, so `pnpm db:migrate` from a checkout that ran the documented
// `cp .env.example .env` at the root does not fail with "DATABASE_URL is not set".
//
// `process.cwd()` and not `import.meta.dirname`: drizzle-kit bundles this file to
// CommonJS before evaluating it, and `import.meta` is undefined there — which fails as
// "The paths[0] argument must be of type string", a message that names nothing useful.
// pnpm runs the script from this package, and the search walks up from wherever it starts.
loadEnvFileIfPresent(process.cwd());

const url = process.env['DATABASE_URL'];

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. `cp .env.example .env` and `pnpm db:up` for a local server.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
