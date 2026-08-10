import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { seedCatalog } from '@wewin/db/seed';
import { provisionTestDatabase } from '@wewin/db/test-database';
import { users } from '@wewin/db/schema';

import { PG_POOL } from '../../src/database/database.tokens';
import { TaxCountryRepository } from '../../src/organisation/tax-country.repository';
import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { bootApp, testEnv, type BootedApp } from '../support/app';
import { TEST_DATABASE_NAME } from '../test-db';

/**
 * `TaxCountryService` and `TaxCountryRepository` against a real Postgres.
 *
 * The property this file exists to prove lives *between* the tax-country write and the
 * history write: the service says both happen in one transaction with a locked pre-image,
 * and the only way to catch a version that quietly split them — or dropped the lock — is to
 * write real rows through real concurrent connections and count what landed. A mock has no
 * trigger to fail, no second statement to lose and no second connection to race against.
 *
 * ── Why `harness()` provisions a fresh database on every call ────────────────────────────
 *
 * `organisation.pg.test.ts` boots one app in `beforeAll` and shares it across every test in
 * the file, because each test there creates its *own* fresh bank account — there is no
 * singleton row to collide over. This file cannot do that: `TH` is the one row migration
 * 0029 seeds, `tax_countries_block_delete` refuses to let anything delete it, and
 * `tax_country_changes_append_only` refuses to let anything delete or edit a history row
 * either. Every test below asserts an *absolute* count of TH's history (0, 1, 2 rows), and
 * that assertion is only meaningful against a database nothing earlier in the run has
 * touched.
 *
 * So `harness()` re-provisions `TEST_DATABASE_NAME` — drop, create, migrate, same as
 * `globalSetup.ts` does once for the whole run — before booting a fresh app on top of it.
 * That also gives Step 6's concurrency test genuine concurrency for free: the `service` it
 * returns is backed by that call's own connection pool (`DATABASE_POOL_MAX` defaults to 10),
 * so two `Promise.all`-ed `patch` calls run on two separate pooled connections rather than
 * sharing one that would serialise them and prove nothing.
 *
 * ⚠️ `provisionTestDatabase` alone is not enough when this file runs as part of the *whole*
 * suite rather than filtered on its own: `globalSetup.ts` also runs `seedCatalog` once, and
 * suites elsewhere (`reviews.pg.test.ts`, `authority.pg.test.ts`, `refunds.pg.test.ts`, …) read
 * that catalogue in their own `beforeAll`. Vitest does not order test files alphabetically and
 * this file's five re-provisions run mid-suite, so leaving the catalogue empty after any of
 * them would strand every file that happens to run later — confirmed by running the whole
 * `apps/api` suite once without the `seedCatalog` call below: 8 files failed with "no
 * published product with a measurement to order", none of them anything this task touched.
 * Re-seeding after every provision (the same pairing `globalSetup.ts` and
 * `tests/support/reseed.ts` both use) leaves the database exactly as `globalSetup` would have,
 * so this file is safe to run standalone (`vitest run tax-country`) or inside a full run.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

interface Harness {
  readonly service: TaxCountryService;
  readonly repository: TaxCountryRepository;
  readonly actor: { readonly id: string };
  readonly db: Database;
}

describeWithPg('the tax-country module against Postgres', () => {
  let opened: { readonly app: BootedApp; readonly pool: Pool } | undefined;

  const closeOpened = async (): Promise<void> => {
    const current = opened;
    opened = undefined;
    if (current === undefined) return;
    await current.app.close();
    await current.pool.end();
  };

  /**
   * Return shape is fixed on purpose: `{ service, repository, actor, db }`. Task 5 reuses this
   * function rather than writing a second one, so nothing about its signature is incidental —
   * `actor.id` (not `actor.userId`) is what every call site below passes as the acting user.
   */
  const harness = async (): Promise<Harness> => {
    await closeOpened();
    await provisionTestDatabase(url ?? '', TEST_DATABASE_NAME);

    const pool = createPool(url ?? '');
    const db = createDatabase(pool);
    // Restore the catalogue every provision, not only migrations — see the file header above.
    await seedCatalog(db);

    const app = await bootApp(testEnv({ DATABASE_URL: url ?? '' }));
    opened = { app, pool };

    const [user] = await db
      .insert(users)
      .values({ displayName: `tax country probe (${randomUUID().slice(0, 8)})` })
      .returning({ id: users.id });
    if (!user) throw new Error('fixture insert returned nothing');

    /*
     * ⚠️ Pre-warm the app's own pool with a few already-connected, idle clients before handing
     * the service back.
     *
     * Without this, Step 6's concurrency test never actually raced, even with the row lock
     * removed — confirmed by instrumenting both `patch()` calls with timestamps. `pg-pool`'s
     * `connect()` hands out an *idle* client almost instantly, but opens a *new* one through a
     * real TCP handshake, and it only takes the fast path once at least one idle client already
     * exists. On a brand-new pool, two `connect()` calls issued "at once" both take the
     * synchronous `newClient()` path and genuinely overlap — but the moment exactly one idle
     * client exists (e.g. after the fixture insert above touches a *different* pool, or after
     * any earlier query on this one), the next two `connect()` calls stop being symmetric: the
     * first grabs the idle client and can finish its whole transaction in well under a
     * millisecond, while the second is still mid-handshake — so it always reads the *already
     * committed* row instead of the stale one, and a contiguity assertion cannot tell a locked
     * pre-image from an unlocked one. Warming several idle clients up front removes that bias:
     * every `connect()` in the test below takes the fast, symmetric path, and the two
     * transactions overlap on their SQL alone, which is what the lock is actually for.
     */
    const appPool = app.app.get<Pool>(PG_POOL);
    const warm = await Promise.all([appPool.connect(), appPool.connect(), appPool.connect()]);
    warm.forEach((client) => client.release());

    return {
      service: app.app.get(TaxCountryService),
      repository: app.app.get(TaxCountryRepository),
      actor: { id: user.id },
      db,
    };
  };

  afterAll(closeOpened);

  describe('tax country writes', () => {
    it('records a change with the previous values in `before`', async () => {
      const { service, actor } = await harness();

      await service.patch('TH', { rateBp: 800 }, actor.id);
      const [entry] = await service.changes('TH');

      expect(entry?.before).toMatchObject({ rateBp: 700, treatment: 'standard' });
      expect(entry?.after).toMatchObject({ rateBp: 800, treatment: 'standard' });
    });

    it('keeps history contiguous under concurrent patches', async () => {
      const { service, actor } = await harness();

      /* Both at once. Without the row lock in lockCountry, both read 700 and the chain breaks:
         entry[1].before would be 700 rather than entry[0].after. P1's final review found this
         exact defect on a lens that had already passed. */
      await Promise.all([
        service.patch('TH', { rateBp: 800 }, actor.id),
        service.patch('TH', { rateBp: 900 }, actor.id),
      ]);

      /* `changes()` orders by `changedAt` ASC — oldest first — so do NOT reverse it. Entry 1's
         `before` must equal entry 0's `after`; on a reversed array that comparison is backwards
         and passes for the wrong reason. */
      const entries = await service.changes('TH');
      expect(entries).toHaveLength(2);
      expect((entries[1]?.before as { rateBp: number }).rateBp).toBe(
        (entries[0]?.after as { rateBp: number }).rateBp,
      );
    });

    it('writes no history row when the write fails', async () => {
      const { service, actor } = await harness();

      await expect(service.patch('TH', { rateBp: 20_000 }, actor.id)).rejects.toThrow();
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creates a country and records the creation with a null `before`', async () => {
      const { service, actor } = await harness();

      await service.create(
        { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
        actor.id,
      );
      const [entry] = await service.changes('SG');

      expect(entry?.before).toBeNull();
      expect(entry?.after).toMatchObject({ code: 'SG', rateBp: 900, pricesIncludeTax: true });
    });

    it('withdraws a country by flag, and the row survives', async () => {
      const { service, actor } = await harness();

      const withdrawn = await service.setAvailability('TH', false, actor.id);

      expect(withdrawn.isActive).toBe(false);
      expect(await service.list(false)).toHaveLength(1);
      expect(await service.list(true)).toHaveLength(0);
    });
  });

  /*
   * ── Constraint translation: fix round 1 ──────────────────────────────────────────────────
   *
   * The finding: a body that validates cleanly against Task 2's zod schemas can still trip a
   * database CHECK or the primary key, and without `pg-errors.ts` each of those reached the
   * caller as a raw `DrizzleQueryError` — a 500 for something a client did on purpose. Every
   * test below asserts the *translated* `AppError` — its `code` and `details`, never the raw
   * SQLSTATE — and that the write's own transaction rolled back with no history row, which is
   * as much the contract as the status code.
   */
  describe('constraint translation, not a raw 500', () => {
    it('patch on a code that does not exist is a 404, not a 500 — the one path to error.tax_country.missing', async () => {
      const { service, actor } = await harness();

      await expect(service.patch('ZZ', { rateBp: 800 }, actor.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
        serverMessage: { key: 'error.tax_country.missing' },
      });
      expect(await service.changes('ZZ')).toHaveLength(0);
    });

    it('patching treatment on a nonzero-rate country is a 409 naming the constraint, not a 500', async () => {
      const { service, actor } = await harness();

      // TH seeds at rate_bp 700 — zero-rating it without clearing the rate is exactly the
      // reviewer's probe, and exactly the mistake a real admin will make.
      await expect(service.patch('TH', { treatment: 'zero_rated' }, actor.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { constraint: 'tax_countries_rate_matches_treatment' },
        serverMessage: { key: 'error.tax_country.rate_treatment_conflict' },
      });
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creating a country with a code already in use is a 409 naming the primary key, not a 500', async () => {
      const { service, actor } = await harness();

      await expect(
        service.create(
          { code: 'TH', nameTh: 'ไทย (ซ้ำ)', rateBp: 0, treatment: 'standard', pricesIncludeTax: true },
          actor.id,
        ),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { constraint: 'tax_countries_pkey' },
        serverMessage: { key: 'error.tax_country.code_taken' },
      });
      expect(await service.changes('TH')).toHaveLength(0);
    });

    it('creating a country with a whitespace-only name is a 422 naming the constraint, not a 500', async () => {
      const { service, actor } = await harness();

      // zod's `nameTh: z.string().min(1)` counts the raw string — three spaces has length 3
      // and passes it — while the database's `length(btrim(name_th)) > 0` does not.
      await expect(
        service.create(
          { code: 'ZZ', nameTh: '   ', rateBp: 0, treatment: 'standard', pricesIncludeTax: true },
          actor.id,
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
        details: { constraint: 'tax_countries_name_says_something' },
        serverMessage: { key: 'error.tax_country.name_blank' },
      });
      expect(await service.changes('ZZ')).toHaveLength(0);
    });
  });
});
