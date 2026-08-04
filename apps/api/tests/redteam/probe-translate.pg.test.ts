import { describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { products } from '@wewin/db/schema';

import { translatePostgresError } from '../../src/admin/pg-errors';

/**
 * Does `translatePostgresError` ever see a driver error at all?
 *
 * `withTranslatedErrors` reads `error.code`. Drizzle 0.45 rethrows query failures wrapped
 * in `DrizzleQueryError`, which carries the driver error on `.cause`. If the wrapper has no
 * `code` of its own, every CHECK, UNIQUE and FK in the catalogue reaches the client as a
 * 500 rather than as the 409/422 the map in pg-errors.ts spells out.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

describeWithPg('a constraint violation reaches the caller as something it can act on', () => {
  it('translates through the wrapper drizzle throws, not just a bare driver error', async () => {
    const pool = createPool(url ?? '');
    const db = createDatabase(pool);
    try {
      // A CHECK violation: lead time min > max on an existing seeded row.
      await db
        .update(products)
        .set({ leadTimeMinDays: 999, leadTimeMaxDays: 1 })
        .where(eq(products.id, 'lvr-adj'));
      throw new Error('the CHECK did not fire');
    } catch (error) {
      /*
       * The whole point. Drizzle rethrows as `DrizzleQueryError`, which has no `code` of
       * its own and keeps the driver's on `.cause` — so a translator that reads the top
       * level sees nothing and every constraint in the catalogue arrives as a blank 500.
       * The database was never at risk; the caller was just told nothing.
       */
      expect((error as { code?: unknown }).code).toBeUndefined();

      const translated = translatePostgresError(error);
      expect(translated).toBeDefined();
      expect(translated).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
        details: { constraint: 'products_lead_time_ordered' },
      });
    } finally {
      await pool.end();
    }
  });
});
