import { afterAll } from 'vitest';
import { createDatabase, createPool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { testDatabaseUrlOrSkip } from '../test-db';

/**
 * Every test file puts the seeded singletons back, or says which file did not.
 *
 * ── The failure this exists to name ──────────────────────────────────────────────
 *
 * Postgres-backed suites here share one database, one file at a time (`vitest.config.ts`), and a
 * few tables hold **one permanently-seeded row that nothing can delete**: `organisation_profile`
 * at `id = 1`, `tax_countries` at `TH`. A suite that edits one of those and does not put it back
 * changes the behaviour of every suite that runs after it — and Vitest does not order files
 * alphabetically, so *which* suites those are moves between runs.
 *
 * That was not hypothetical. `organisation.pg.test.ts` wrote `deposit_bp` to 3 000 and 5 000 bp
 * and never restored it, which was harmless while nothing read the column. The moment
 * `OrdersService.submit` did, two consecutive runs of one commit failed differently: 38 failures
 * across `refunds.pg.test.ts` on one ordering ("instalment … is due 739584 but 1479168 is
 * allocated to it") and one in `orders/lifecycle.pg.test.ts` on another. Neither names the file
 * that caused it, and neither is anywhere near it.
 *
 * ── Why a convention was not enough ──────────────────────────────────────────────
 *
 * `tax_countries.TH` survived the same round only by luck. Its suite patches `TH`'s rate in its
 * first two tests, and it is clean at the end purely because the *last* test in the file is a
 * failing-write case (a whitespace-only name refused as a 422) that leaves nothing behind.
 * Reorder that file, or append one passing test, and `TH` becomes the identical bug against a
 * column tasks 10 and 11 just made live in every price on the system.
 *
 * ── What this does ───────────────────────────────────────────────────────────────
 *
 * One query per test file, in an `afterAll` registered by `setupFiles` so it applies to every
 * file without any of them opting in. If a singleton has moved, it is **put back and then
 * reported** — restored so the run's remaining files still test what they are about, reported so
 * the run fails, and Vitest attributes an `afterAll` failure to the file it ran under, which is
 * the file that leaked.
 *
 * A suite that legitimately needs a different value for the whole of its run should restore it in
 * its own `afterAll` (see `deposit-policy.pg.test.ts`), which is the discipline this only
 * enforces rather than replaces.
 */

interface Singleton {
  /** How the failure names it, in the form somebody can grep. */
  readonly what: string;
  readonly select: ReturnType<typeof sql>;
  readonly restore: ReturnType<typeof sql>;
  /** As `packages/db/drizzle` seeds it. Compared as text so numeric types cannot surprise. */
  readonly seeded: string;
}

const SINGLETONS: readonly Singleton[] = [
  {
    /*
     * The `cashflow` approval floor since task 12, and the payment schedule's deposit share.
     * Seeded by `0029_tax_countries.sql:113`.
     */
    what: 'organisation_profile.deposit_bp',
    select: sql`select deposit_bp::text as value from organisation_profile where id = 1`,
    restore: sql`update organisation_profile set deposit_bp = 10000 where id = 1`,
    seeded: '10000',
  },
  {
    /*
     * The default destination's VAT rate — every price on an order that names no country.
     * Seeded by `0029_tax_countries.sql:98`.
     */
    what: "tax_countries.TH.rate_bp",
    select: sql`select rate_bp::text as value from tax_countries where code = 'TH'`,
    restore: sql`update tax_countries set rate_bp = 700 where code = 'TH'`,
    seeded: '700',
  },
];

afterAll(async () => {
  const url = testDatabaseUrlOrSkip();
  /* No server: every Postgres suite skipped itself, so there is nothing to have leaked. */
  if (url === undefined) return;

  const pool = createPool(url);
  const leaked: string[] = [];

  try {
    const db = createDatabase(pool);

    for (const singleton of SINGLETONS) {
      const rows = await db.execute<{ value: string }>(singleton.select);
      const value = rows.rows[0]?.value;

      /*
       * A missing row is not a leak this hook can speak about. A file that drops and recreates
       * the database (`createPgHarness`, `reseedCatalogue`) always leaves it migrated and seeded,
       * so `undefined` here means something else entirely and inventing a `restore` for it would
       * be this hook writing rows nobody asked for.
       */
      if (value === undefined || value === singleton.seeded) continue;

      await db.execute(singleton.restore);
      leaked.push(`${singleton.what} was left at ${value}, expected the seeded ${singleton.seeded}`);
    }
  } catch (error) {
    /*
     * Never mask a real failure with this one. A file that failed by taking the database away
     * from under itself would otherwise report "could not check the singletons" as its cause.
     */
    if (leaked.length === 0) return;
    throw error;
  } finally {
    await pool.end();
  }

  if (leaked.length > 0) {
    throw new Error(
      `this test file changed a seeded singleton and did not put it back:\n  ${leaked.join('\n  ')}\n` +
        'It has been restored so the rest of the run is unaffected. Restore it in the file\'s own ' +
        'afterAll — every Postgres suite here shares one database, and the next file to fail ' +
        'would not have been this one.',
    );
  }
});
