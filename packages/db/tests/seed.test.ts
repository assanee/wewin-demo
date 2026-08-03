import { beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { productSchema } from '@wewin/core/schema';
import { products as coreProducts } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import type { Database } from '../src/client.js';
import { fromDocument } from '../src/compile.js';
import { seedCatalog } from '../src/seed.js';
import { optionValues, productVersions } from '../src/schema/index.js';
import { connect, describeDb } from './support/db.js';

/**
 * The catalogue, in Postgres, priced from Postgres.
 *
 * The round-trip in `compile.test.ts` proves the *shape* survives. This proves the
 * *server* does: jsonb reorders keys, `bigint` arrives as a string before drizzle maps
 * it, and Postgres normalises numbers inside a document. Reading all 81 documents back
 * out and pricing from them is the only way to know none of that changed an answer.
 */
describeDb('seeded catalogue', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');
  });

  it('holds every product the TS table holds', async () => {
    const rows = await db
      .select({ productId: productVersions.productId, document: productVersions.document })
      .from(productVersions)
      .where(eq(productVersions.status, 'published'));

    expect(rows.length).toBe(coreProducts.length);
    expect(new Set(rows.map((row) => row.productId)).size).toBe(coreProducts.length);
  });

  it('materialises each stored document into a product core still accepts', async () => {
    const rows = await db
      .select({ productId: productVersions.productId, document: productVersions.document })
      .from(productVersions)
      .where(eq(productVersions.status, 'published'));

    const byId = new Map(coreProducts.map((product) => [product.id, product]));

    for (const row of rows) {
      const expected = byId.get(row.productId);
      if (!expected) throw new Error(`Postgres has a product the table does not: ${row.productId}`);

      const restored = fromDocument(row.document);
      const parsed = productSchema.safeParse(restored);

      expect(parsed.success, `${row.productId}: ${parsed.error?.message ?? ''}`).toBe(true);
      expect(restored).toStrictEqual(expected);
    }
  });

  it('prices the spec case from the database to the same satang as from the table', async () => {
    // awn-4t at 320 × 160 is ฿7,680 in the plan's own worked example (section 4.2).
    const expected = coreProducts.find((product) => product.slug === 'awn-4t');
    if (!expected) throw new Error('awn-4t is missing from the catalogue');

    const [row] = await db
      .select({ document: productVersions.document })
      .from(productVersions)
      .where(eq(productVersions.productId, expected.id));
    if (!row) throw new Error('awn-4t was not seeded');

    const measures = { width: 3_200_000n, height: 1_600_000n };
    const fromDb = calcPrice(fromDocument(row.document), {}, measures, 1);
    const fromTable = calcPrice(expected, {}, measures, 1);

    expect(fromDb.totalMinor).toBe(fromTable.totalMinor);
    expect(fromDb.totalMinor).toBe(768_000n);
  });

  it('keeps stock on the editable row, where it can still move', async () => {
    const [before] = await db
      .select({ id: optionValues.id, available: optionValues.available })
      .from(optionValues)
      .limit(1);
    if (!before) throw new Error('the seed produced no option values');

    // No republish, no new version: a colour going out of stock is one UPDATE, which is
    // the whole reason `available` is not inside the frozen document.
    await db.update(optionValues).set({ available: false }).where(eq(optionValues.id, before.id));

    const [after] = await db
      .select({ available: optionValues.available })
      .from(optionValues)
      .where(eq(optionValues.id, before.id));

    expect(after?.available).toBe(false);

    await db.update(optionValues).set({ available: true }).where(eq(optionValues.id, before.id));
  });
});
