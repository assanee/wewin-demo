import { beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import { categories, optionGroups, productVersionOptions, productVersions, products } from '../src/schema/index.js';
import { toDocument } from '../src/compile.js';
import { documentHash } from '../src/hash.js';
import { seedCatalog } from '../src/seed.js';
import { products as coreProducts } from '@wewin/core/fixtures';
import { connect, describeDb } from './support/db.js';

/**
 * The claim this file exists to test: a bigint column comes back as a `bigint`.
 *
 * It is not obvious and it is not free. node-postgres hands int8 to the client as a
 * *string*, because a JS number cannot hold every int8; drizzle's `mode: 'bigint'` is
 * what turns it back. If that mapping were ever lost, nothing would throw — a length in
 * micrometres would become the string "3200000", `"3200000" * 2` would still be 6400000
 * because JS coerces, and the first symptom would be a concatenation somewhere in a
 * price. So this asserts the type and not only the value.
 */
describeDb('bigint columns', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');
  });

  it('round-trips a value larger than Number.MAX_SAFE_INTEGER without losing a digit', async () => {
    // 2^53 + 1: the smallest integer a double cannot represent. If anything in the
    // chain went through a `number`, this comes back as 9007199254740992.
    const beyondDouble = 9_007_199_254_740_993n;
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    await db.delete(categories).where(eq(categories.id, 'bigint-probe'));
    await db.insert(categories).values({
      id: 'bigint-probe',
      labelTh: 'ทดสอบ',
      summaryTh: 'ทดสอบ',
    });

    await db.insert(products).values({
      id: 'bigint-probe',
      slug: 'bigint-probe',
      skuPrefix: 'BIGINTPROBE',
      categoryId: 'bigint-probe',
      nameTh: 'ทดสอบ',
      summaryTh: 'ทดสอบ',
      heroImage: '/products/probe.svg',
      leadTimeMinDays: 1,
      leadTimeMaxDays: 2,
      pricePerSqmMinor: 220_000n,
      minBillableSqUm: beyondDouble,
      elevation: source.elevation,
    });

    const [row] = await db
      .select({ minBillable: products.minBillableSqUm, price: products.pricePerSqmMinor })
      .from(products)
      .where(eq(products.id, 'bigint-probe'));

    expect(typeof row?.minBillable).toBe('bigint');
    expect(typeof row?.price).toBe('bigint');
    expect(row?.minBillable).toBe(beyondDouble);
    // The failure this pins down: 2^53 is what a double rounds it to.
    expect(row?.minBillable).not.toBe(9_007_199_254_740_992n);

    await db.delete(products).where(eq(products.id, 'bigint-probe'));
    await db.delete(categories).where(eq(categories.id, 'bigint-probe'));
  });

  it('hands measurement bounds back as bigint, exactly as the catalogue wrote them', async () => {
    const source = coreProducts.find((product) => product.slug === 'awn-4t') ?? coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const width = source.groups.find(
      (group) => group.kind === 'custom' && group.code === 'width',
    );
    if (!width || width.kind !== 'custom') throw new Error('no width group on the probe product');

    const [row] = await db
      .select({
        minUm: productVersionOptions.minUm,
        maxUm: productVersionOptions.maxUm,
        stepUm: productVersionOptions.stepUm,
        defaultUm: productVersionOptions.defaultUm,
      })
      .from(productVersionOptions)
      .innerJoin(productVersions, eq(productVersions.id, productVersionOptions.productVersionId))
      .innerJoin(optionGroups, eq(optionGroups.id, productVersionOptions.optionGroupId))
      .where(and(eq(productVersions.productId, source.id), eq(optionGroups.code, 'width')))
      .limit(1);

    if (!row) throw new Error(`no seeded width row for ${source.id} — run \`pnpm db:seed\``);

    expect(typeof row.minUm).toBe('bigint');
    expect(typeof row.stepUm).toBe('bigint');
    expect(row.minUm).toBe(width.minUm);
    expect(row.maxUm).toBe(width.maxUm);
    expect(row.stepUm).toBe(width.stepUm);
    expect(row.defaultUm).toBe(width.defaultUm);
    expect(row.stepUm).toBe(5_000n); // 0.5 cm, a whole multiple of the 25 µm lattice
  });

  it('stores the compiled document with its exact numbers as strings', async () => {
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const [row] = await db
      .select({ document: productVersions.document, hash: productVersions.documentHash })
      .from(productVersions)
      .where(eq(productVersions.productId, source.id))
      .limit(1);

    const document = row?.document;
    if (!document) throw new Error(`no seeded version for ${source.id} — run \`pnpm db:seed\``);

    expect(typeof document.minBillableSqUm).toBe('string');
    expect(BigInt(document.minBillableSqUm)).toBe(source.minBillableSqUm);
    // jsonb reorders keys on the way in, so a hash of the round-tripped document has to
    // be computed from the canonical form or it would never match what was stored.
    expect(row?.hash).toBe(documentHash(document));
    expect(row?.hash).toBe(documentHash(toDocument(source)));
  });
});
