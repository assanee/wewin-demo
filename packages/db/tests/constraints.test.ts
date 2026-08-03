import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import {
  categories,
  optionGroups,
  optionValues,
  productVersionOptionValues,
  productVersionOptions,
  productVersions,
  products,
} from '../src/schema/index.js';
import { toDocument } from '../src/compile.js';
import { documentHash } from '../src/hash.js';
import { seedCatalog } from '../src/seed.js';
import { products as coreProducts } from '@wewin/core/fixtures';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/**
 * The invariants `parseCatalog` checks in `@wewin/core/schema`, checked here instead.
 *
 * Plan 5 point 3 is the reason these tests exist at all: `productSchema` validates one
 * product against itself and cannot see the other 80, so "duplicate slug", "duplicate
 * id", "duplicate skuPrefix" and "categoryId that does not exist" are checks a zod
 * object schema is structurally unable to perform. In Postgres they are two UNIQUEs, a
 * primary key and a foreign key — and each assertion below names the SQLSTATE, so a
 * constraint that is dropped or renamed fails here rather than passing quietly because
 * some other error happened to be thrown.
 */
describeDb('cross-row catalogue invariants', () => {
  let db: Database;

  const first = coreProducts[0];
  if (!first) throw new Error('the catalogue fixture is empty');

  const template = {
    id: 'constraint-probe',
    slug: 'constraint-probe',
    skuPrefix: 'CONSTRAINTPROBE',
    categoryId: first.categoryId,
    nameTh: 'ทดสอบ',
    summaryTh: 'ทดสอบ',
    heroImage: '/products/probe.svg',
    leadTimeMinDays: 1,
    leadTimeMaxDays: 2,
    pricePerSqmMinor: 220_000n,
    minBillableSqUm: 1_000_000_000_000n,
    elevation: first.elevation,
  };

  const clone = (overrides: Partial<typeof template>) => ({ ...template, ...overrides });

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');
  });

  afterAll(async () => {
    await db.delete(products).where(eq(products.id, 'constraint-probe'));
  });

  const expectViolation = async (
    operation: Promise<unknown>,
    code: (typeof PG)[keyof typeof PG],
  ): Promise<void> => {
    const caught = await operation.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
  };

  it('rejects a duplicate product id', async () => {
    await expectViolation(
      db.insert(products).values(clone({ id: first.id, slug: 'x-probe', skuPrefix: 'XPROBE' })),
      PG.uniqueViolation,
    );
  });

  it('rejects a duplicate slug', async () => {
    await expectViolation(
      db.insert(products).values(clone({ slug: first.slug })),
      PG.uniqueViolation,
    );
  });

  it('rejects a duplicate skuPrefix — two products would emit the same sku_code', async () => {
    await expectViolation(
      db.insert(products).values(clone({ skuPrefix: first.skuPrefix })),
      PG.uniqueViolation,
    );
  });

  it('rejects a categoryId that does not exist', async () => {
    await expectViolation(
      db.insert(products).values(clone({ categoryId: 'no-such-category' })),
      PG.foreignKeyViolation,
    );
  });

  it('rejects a category that still has products', async () => {
    // 23001 and not 23503: the reference is ON DELETE RESTRICT, and Postgres gives
    // RESTRICT its own SQLSTATE. The difference is not cosmetic — RESTRICT fires
    // immediately and cannot be deferred, which is what makes it the right choice for a
    // category somebody is halfway through deleting from the dashboard.
    await expectViolation(
      db.delete(categories).where(eq(categories.id, first.categoryId)),
      PG.restrictViolation,
    );
  });

  it('rejects a price that is not a whole number of baht', async () => {
    await expectViolation(
      db.insert(products).values(clone({ pricePerSqmMinor: 220_050n })),
      PG.checkViolation,
    );
  });

  it('rejects inverted lead times', async () => {
    await expectViolation(
      db.insert(products).values(clone({ leadTimeMinDays: 20, leadTimeMaxDays: 5 })),
      PG.checkViolation,
    );
  });
});

/**
 * The within-row invariants `customGroupSchema` checks, restated as CHECKs.
 *
 * These could have been left to zod — they are all readable from one row. They are here
 * because the dashboard writes rows, not zod objects, and a bound that is off its own
 * step reaches a customer as a size they can see and never select.
 */
describeDb('measurement grid', () => {
  let db: Database;
  let draftVersionId: string;
  let widthGroupId: string;

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');

    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const [version] = await db
      .insert(productVersions)
      .values({
        productId: source.id,
        version: 900,
        status: 'draft',
        document: toDocument(source),
        documentHash: documentHash(toDocument(source)),
      })
      .returning({ id: productVersions.id });

    const [group] = await db
      .select({ id: optionGroups.id })
      .from(optionGroups)
      .where(eq(optionGroups.code, 'width'));

    if (!version || !group) throw new Error('run `pnpm db:seed` before the constraint tests');

    draftVersionId = version.id;
    widthGroupId = group.id;
  });

  afterAll(async () => {
    await db.delete(productVersions).where(eq(productVersions.id, draftVersionId));
  });

  const insertBounds = (bounds: {
    minUm: bigint;
    maxUm: bigint;
    stepUm: bigint;
    defaultUm: bigint;
  }) =>
    db.insert(productVersionOptions).values({
      productVersionId: draftVersionId,
      optionGroupId: widthGroupId,
      groupKind: 'custom',
      ...bounds,
    });

  const cleanUp = () =>
    db.delete(productVersionOptions).where(eq(productVersionOptions.productVersionId, draftVersionId));

  const expectCheckViolation = async (operation: Promise<unknown>): Promise<void> => {
    const caught = await operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(errorCode(caught), `expected a CHECK violation, got: ${String(caught)}`).toBe(
      PG.checkViolation,
    );
  };

  it('accepts bounds that sit on their own step and on the 25 µm lattice', async () => {
    await insertBounds({
      minUm: 600_000n,
      maxUm: 4_000_000n,
      stepUm: 5_000n,
      defaultUm: 3_200_000n,
    });
    await cleanUp();
  });

  it('rejects a step off the 25 µm lattice', async () => {
    await expectCheckViolation(
      insertBounds({ minUm: 600_000n, maxUm: 4_000_000n, stepUm: 3_000n, defaultUm: 600_000n }),
    );
  });

  it('rejects a max that is not a whole number of steps above the min', async () => {
    await expectCheckViolation(
      insertBounds({ minUm: 600_000n, maxUm: 4_002_500n, stepUm: 5_000n, defaultUm: 600_000n }),
    );
  });

  it('rejects a default outside the range', async () => {
    await expectCheckViolation(
      insertBounds({ minUm: 600_000n, maxUm: 4_000_000n, stepUm: 5_000n, defaultUm: 5_000_000n }),
    );
  });

  it('rejects a measurement group carrying a sku default', async () => {
    await expectCheckViolation(
      db.insert(productVersionOptions).values({
        productVersionId: draftVersionId,
        optionGroupId: widthGroupId,
        groupKind: 'custom',
        defaultValueCode: 'SG',
        minUm: 600_000n,
        maxUm: 4_000_000n,
        stepUm: 5_000n,
        defaultUm: 600_000n,
      }),
    );
  });

  it('rejects a group whose kind disagrees with the group it points at', async () => {
    const caught = await db
      .insert(productVersionOptions)
      .values({
        productVersionId: draftVersionId,
        optionGroupId: widthGroupId,
        // `width` is a custom group; claiming it is a sku group here has to fail in the
        // composite foreign key, not merely in a comment.
        groupKind: 'sku',
        defaultValueCode: 'SG',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(errorCode(caught)).toBe(PG.foreignKeyViolation);
  });
});

describeDb('option values', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
  });

  it('rejects a percent surcharge that also carries an amount of money', async () => {
    const [group] = await db
      .select({ id: optionGroups.id })
      .from(optionGroups)
      .where(eq(optionGroups.code, 'profile_color'));
    if (!group) throw new Error('run `pnpm db:seed` first');

    const caught = await db
      .insert(optionValues)
      .values({
        optionGroupId: group.id,
        groupKind: 'sku',
        code: 'PROBE',
        labelTh: 'ทดสอบ',
        deltaType: 'percent',
        deltaMinor: 100n,
        deltaBp: 800,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(errorCode(caught)).toBe(PG.checkViolation);
  });

  /*
   * `CLR` is a glass colour. Offering it under the profile-colour group is the mistake
   * the paired foreign keys exist to make impossible: one proves the row belongs to
   * this version's group, the other proves the value belongs to that same group, and
   * they share the group id column, so the two cannot disagree.
   */
  it('cannot offer a value that belongs to another group', async () => {
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const groupId = async (code: string): Promise<string> => {
      const [row] = await db
        .select({ id: optionGroups.id })
        .from(optionGroups)
        .where(eq(optionGroups.code, code));
      if (!row) throw new Error(`run \`pnpm db:seed\` first — no option group "${code}"`);
      return row.id;
    };

    const profileColor = await groupId('profile_color');
    const glassColor = await groupId('glass_color');

    const [glassClear] = await db
      .select({ id: optionValues.id })
      .from(optionValues)
      .where(and(eq(optionValues.optionGroupId, glassColor), eq(optionValues.code, 'CLR')));
    if (!glassClear) throw new Error('run `pnpm db:seed` first — no glass colour CLR');

    const document = toDocument(source);
    const [version] = await db
      .insert(productVersions)
      .values({
        productId: source.id,
        version: 901,
        status: 'draft',
        document,
        documentHash: documentHash(document),
      })
      .returning({ id: productVersions.id });
    if (!version) throw new Error('could not create a draft version');

    try {
      const [option] = await db
        .insert(productVersionOptions)
        .values({
          productVersionId: version.id,
          optionGroupId: profileColor,
          groupKind: 'sku',
          defaultValueCode: 'SG',
        })
        .returning({ id: productVersionOptions.id });
      if (!option) throw new Error('could not create a version option');

      const caught = await db
        .insert(productVersionOptionValues)
        .values({
          productVersionOptionId: option.id,
          optionGroupId: profileColor,
          optionValueId: glassClear.id,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(errorCode(caught)).toBe(PG.foreignKeyViolation);
    } finally {
      await db.delete(productVersions).where(eq(productVersions.id, version.id));
    }
  });
});
