import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase, createPool } from './client.js';

/**
 * A throwaway database per test suite, built from nothing on every run.
 *
 * ── The incident this exists to end ──────────────────────────────────────────────
 *
 * `seedCatalog` truncates the catalogue, and phase 5a gave the catalogue a dependent that
 * must never be truncated: `order_document_product_versions` records which published
 * document each contract was priced from. So `order_document_versions_block_truncate()`
 * refuses the seed on any database that carries a contract — which is the correct
 * production rule, and it collided head-on with the test architecture, because
 * `apps/api/tests/globalSetup.ts` seeds before every run and the order suites submit orders.
 *
 * The failure was not a red test. It was 116 catalogue tests turning into *skips* plus two
 * suites failing in `beforeAll`, on a run that still printed a number of passes — the exact
 * "green tick that proves nothing" this repository keeps meeting.
 *
 * Both rules are right. What was wrong was that they were pointed at one database. A suite
 * that seeds from scratch needs a database with no history, and there is no reason for that
 * to be the database a developer keeps their work in.
 *
 * ── Why drop and create rather than clean up afterwards ──────────────────────────
 *
 * Because cleaning up is exactly what the schema forbids. `orders_block_delete()` refuses to
 * delete a submitted order, `order_events` and `notification_attempts` are append-only, and a
 * published document is frozen. Every one of those is deliberate, and together they mean a
 * test that submitted an order has permanently changed the database it ran against. The only
 * teardown that can be trusted is not to have the database.
 *
 * It also buys the property the phase-5a brief asks for directly: what runs in CI is the same
 * path as `docker compose down -v` followed by migrate and seed, on every single run, so
 * "the migrations apply to an empty database" stops being something somebody checks
 * occasionally and becomes something no test run can avoid proving.
 */

/** Where `CREATE DATABASE` is issued from — never the database being replaced. */
const MAINTENANCE_DATABASE = 'postgres';

/**
 * The same base URL, pointed at `name`.
 *
 * Exported separately from the provisioning so that a vitest config — which runs before any
 * build and must not open a socket — can name the database that `globalSetup` will create.
 * Both sides deriving it from one function is what stops the suite connecting to a database
 * nobody provisioned, which presents as "relation does not exist" several files later.
 */
export function testDatabaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Postgres identifiers cannot be parameterised, so the name is constrained instead.
 *
 * These names come from this repository's own configuration and not from a request, which is
 * why a refusal here is a `TypeError` and not a sanitiser: a caller passing something else
 * has a bug, and quietly rewriting their input would hide it.
 */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export interface ProvisionOptions {
  /** Apply `drizzle/` after creating it. On by default; there is no useful empty database. */
  readonly migrate?: boolean;
}

/**
 * Drop `name`, create it, migrate it. Returns the URL the suite should connect to.
 *
 * `WITH (FORCE)` terminates any connection still open on it — a previous run's pool that
 * was not closed would otherwise make this fail with "database is being accessed by other
 * users", which reads like a permissions problem and is really a lifetime one.
 */
export async function provisionTestDatabase(
  baseUrl: string,
  name: string,
  options: ProvisionOptions = {},
): Promise<string> {
  if (!SAFE_NAME.test(name)) {
    throw new TypeError(`test database name is not a plain identifier: ${name}`);
  }

  const target = testDatabaseUrl(baseUrl, name);
  const maintenance = createPool(testDatabaseUrl(baseUrl, MAINTENANCE_DATABASE));

  try {
    await maintenance.query(`drop database if exists ${name} with (force)`);
    await maintenance.query(`create database ${name}`);
  } finally {
    await maintenance.end();
  }

  if (options.migrate === false) return target;

  const pool = createPool(target);
  try {
    // The same folder `pnpm db:migrate` uses. A schema built any other way — `push`, a
    // hand-written DDL fixture — would be a schema that never ships.
    await migrate(createDatabase(pool), {
      migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
    });
  } finally {
    await pool.end();
  }

  return target;
}
