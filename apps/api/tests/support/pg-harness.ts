import { randomUUID } from 'node:crypto';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { seedCatalog } from '@wewin/db/seed';
import { provisionTestDatabase } from '@wewin/db/test-database';
import { users } from '@wewin/db/schema';

import { PG_POOL } from '../../src/database/database.tokens';
import { TEST_DATABASE_NAME } from '../test-db';
import { bootApp, testEnv, type BootedApp } from './app';

/**
 * The provisioning dance every Postgres-backed suite that asserts an *absolute* history count
 * needs — extracted from `tax-country.pg.test.ts` (Task 3) rather than reinvented by
 * `organisation.pg.test.ts`'s profile-history suite (Task 4). Both suites own a singleton row
 * (`tax_countries`' `TH`, `organisation_profile`'s `id = 1`) that nothing can delete, so a test
 * asserting "this row's history has exactly N entries" is only meaningful against a database
 * nothing earlier in the run has touched.
 *
 * ── Why drop and recreate rather than clean up afterwards ────────────────────────────────
 *
 * `tax_country_changes_append_only` and `organisation_profile_changes_append_only` both refuse
 * to let a history row be edited or deleted, and the rows under test cannot be deleted either
 * (`tax_countries_block_delete`, `organisation_profile_block_delete`). The only teardown that
 * can be trusted is not to have the database — see `provisionTestDatabase`'s own header.
 *
 * ── Why every `harness()` call re-seeds the catalogue too ────────────────────────────────
 *
 * `provisionTestDatabase` alone is not enough when a suite using this runs as part of the
 * *whole* `apps/api` suite rather than filtered on its own: `globalSetup.ts` also runs
 * `seedCatalog` once, and suites elsewhere read that catalogue in their own `beforeAll`. Vitest
 * does not order test files alphabetically, so leaving the catalogue empty after a re-provision
 * would strand every file that happens to run later — confirmed in Task 3 by running the whole
 * `apps/api` suite once without the `seedCatalog` call below: 8 files failed with "no published
 * product with a measurement to order", none of them anything Task 3 touched. Re-seeding after
 * every provision (the same pairing `globalSetup.ts` and `tests/support/reseed.ts` both use)
 * leaves the database exactly as `globalSetup` would have, so a suite built on this harness is
 * safe to run standalone or inside a full run.
 */

export interface PgHarness {
  readonly app: BootedApp;
  readonly actor: { readonly id: string };
  readonly db: Database;
}

export interface PgHarnessHandle {
  /** Drop, recreate, migrate, re-seed, boot a fresh app, and hand back a probe user. */
  readonly harness: () => Promise<PgHarness>;
  /** Register with `afterAll` — closes whatever the most recent `harness()` call opened. */
  readonly closeOpened: () => Promise<void>;
}

/**
 * One provisioning lifecycle. Each caller (each Postgres-backed test file, or a `describe`
 * block inside one that needs its own fresh database) makes its own handle rather than sharing
 * `opened` across two independent lifecycles.
 */
export function createPgHarness(url: string): PgHarnessHandle {
  let opened: { readonly app: BootedApp; readonly pool: Pool } | undefined;

  const closeOpened = async (): Promise<void> => {
    const current = opened;
    opened = undefined;
    if (current === undefined) return;
    await current.app.close();
    await current.pool.end();
  };

  const harness = async (): Promise<PgHarness> => {
    await closeOpened();
    await provisionTestDatabase(url, TEST_DATABASE_NAME);

    const pool = createPool(url);
    const db = createDatabase(pool);
    // Restore the catalogue every provision, not only migrations — see the file header above.
    await seedCatalog(db);

    const app = await bootApp(testEnv({ DATABASE_URL: url }));
    opened = { app, pool };

    const [user] = await db
      .insert(users)
      .values({ displayName: `pg harness probe (${randomUUID().slice(0, 8)})` })
      .returning({ id: users.id });
    if (!user) throw new Error('fixture insert returned nothing');

    /*
     * ⚠️ Pre-warm the app's own pool with a few already-connected, idle clients before handing
     * the app back.
     *
     * Without this, a concurrency test built on this harness never actually races, even with a
     * row lock removed — confirmed in Task 3 by instrumenting two concurrent calls with
     * timestamps. `pg-pool`'s `connect()` hands out an *idle* client almost instantly, but opens
     * a *new* one through a real TCP handshake, and it only takes the fast path once at least
     * one idle client already exists. On a brand-new pool, two `connect()` calls issued "at once"
     * both take the synchronous `newClient()` path and genuinely overlap — but the moment exactly
     * one idle client exists (e.g. after the fixture insert above touches a *different* pool),
     * the next two `connect()` calls stop being symmetric: the first grabs the idle client and
     * can finish its whole transaction in well under a millisecond, while the second is still
     * mid-handshake — so it always reads the *already committed* row instead of the stale one,
     * and a contiguity assertion cannot tell a locked pre-image from an unlocked one. Warming
     * several idle clients up front removes that bias: every `connect()` in a test built on this
     * harness takes the fast, symmetric path, and two transactions overlap on their SQL alone,
     * which is what the lock is actually for.
     */
    const appPool = app.app.get<Pool>(PG_POOL);
    const warm = await Promise.all([appPool.connect(), appPool.connect(), appPool.connect()]);
    warm.forEach((client) => client.release());

    return { app, actor: { id: user.id }, db };
  };

  return { harness, closeOpened };
}
