import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

/**
 * Configuration is parsed once, before Nest builds anything.
 *
 * The alternative — reading `process.env` where it is needed — moves the failure from
 * boot to the first request that happens to touch it, which in the case of DATABASE_URL
 * means a healthy-looking service that 500s on its first real query. Everything below
 * either has a default or stops the process.
 */

const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/** Postgres accepts both spellings in URLs and so does `pg`; reject anything else. */
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

const databaseUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return POSTGRES_PROTOCOLS.has(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'must be a postgres:// or postgresql:// connection URL' },
  );

/** `z.coerce.number()` accepts '' and NaN-ish input too readily for a port. */
const port = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .refine((value) => value >= 1 && value <= 65535, { message: 'must be between 1 and 65535' });

const positiveMs = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number of milliseconds')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

const positiveInt = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value > 0, { message: 'must be greater than zero' })
    .default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: port.default(3000),

  /*
   * What is actually running, reported by /health and /meta. Deployments set it to a git
   * sha; package.json's version answers a different question (what the source claims) and
   * cannot be read from `dist` without either a build step or a path guess that breaks
   * under the test runner.
   */
  SERVICE_VERSION: z.string().min(1).default('dev'),

  DATABASE_URL: databaseUrl,
  DATABASE_POOL_MAX: positiveInt(10),
  DATABASE_CONNECT_TIMEOUT_MS: positiveMs(5_000),

  /*
   * A per-statement ceiling set on the connection rather than per query: a request that
   * hangs holds a pool slot, and ten of those are the whole pool. Raise it for a specific
   * statement when one legitimately needs longer, do not raise the default.
   */
  DATABASE_STATEMENT_TIMEOUT_MS: positiveMs(15_000),

  /*
   * One flag for every cookie this process sets: the OAuth binding cookie (`__Host-` +
   * `Secure` + `SameSite=None`), the refresh cookie, and the guest cart cookie. There were
   * two of these and a red-team pass pointed out the obvious consequence — two flags are
   * two profiles, and the one nobody sets is the one production runs on.
   *
   * Defaults to on, and is only turned off explicitly. `false` is for a laptop with no TLS
   * terminator, and `parseOAuthConfig` refuses it outright when the callback origin is not
   * a loopback address, so it cannot be the thing a deployment forgot.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  /*
   * Readiness reports "draining" for this long before the HTTP server stops accepting
   * connections, so a load balancer polling /health/ready has a chance to notice. Zero is
   * right for a laptop and wrong for anything with more than one instance.
   */
  SHUTDOWN_GRACE_MS: z
    .string()
    .regex(/^\d+$/, 'must be a whole number of milliseconds')
    .transform(Number)
    .default(0),

  /** Comma-separated. Empty means same-origin only — no CORS headers are sent at all. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /*
   * Open Exchange Rates' `app_id` — https://openexchangerates.org/api/latest.json.
   * Optional, deliberately: a developer with no OXR account still has to be able to boot
   * this app and run its suite, and exchange-rate ingestion (`apps/api/src/fx`) is a
   * background job that nothing else in the system depends on yet. Absent,
   * `FxRatesService` logs that once at construction and never schedules a fetch; present,
   * it fetches daily — a quota decision explained where the fetch happens, not repeated
   * here.
   */
  OPENEXCHANGERATES_APP_ID: z.string().min(1).optional(),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        'Invalid environment configuration:',
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'Copy .env.example to .env at the workspace root, or export the variables directly.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

/**
 * Parses a plain record rather than reading `process.env` itself, so tests can exercise
 * the failure modes without mutating the process they run in.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return Object.freeze(result.data);
  }

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    // zod says "Invalid input: expected string, received undefined" for a missing var,
    // which reads as a type puzzle rather than "you forgot to set this".
    const message = issue.code === 'invalid_type' && !(name in source) ? 'is required but not set' : issue.message;
    return `${name} ${message}`;
  });

  throw new EnvValidationError(problems);
}

/**
 * Values already present in the environment win: `process.loadEnvFile` fills gaps, it does
 * not overwrite. That is what makes `DATABASE_URL=... pnpm dev` work with a .env on disk.
 *
 * The search walks up rather than reading `./.env` only, because there is one Postgres
 * and one docker-compose.yml for this repository and they live at the root — so the
 * connection string that names them belongs there too. A file beside this app still wins
 * if somebody wants a different database for the API alone; the walk just stops caring
 * where the process happened to be started from, which is the difference between
 * `pnpm --filter @wewin/api test` and `turbo run test` finding the same configuration.
 * The walk ends at the workspace root (`pnpm-workspace.yaml`) so it can never wander into
 * a `.env` belonging to some unrelated checkout above this one.
 */
export function loadEnvFileIfPresent(directory: string = process.cwd()): string | undefined {
  const explicit = process.env['ENV_FILE'];
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path)) return undefined;
    process.loadEnvFile(path);
    return path;
  }

  for (let current = resolve(directory); ; current = dirname(current)) {
    const path = resolve(current, '.env');
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return path;
    }
    if (existsSync(resolve(current, 'pnpm-workspace.yaml')) || dirname(current) === current) {
      return undefined;
    }
  }
}

export function loadEnv(): Env {
  loadEnvFileIfPresent();
  return parseEnv(process.env);
}
