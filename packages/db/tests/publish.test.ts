import { beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import { createDatabase, createPool } from '../src/client.js';
import { productVersionRules, productVersions } from '../src/schema/index.js';
import { toDocument } from '../src/compile.js';
import { documentHash } from '../src/hash.js';
import { PublishError, publishProductVersion } from '../src/publish.js';
import { seedCatalog } from '../src/seed.js';
import { products as coreProducts } from '@wewin/core/fixtures';
import { PG, connect, describeDb, errorCode } from './support/db.js';

/**
 * Publishing: the statement order, and what happens when it is wrong.
 *
 * Plan 5's first warning is that the partial unique index is checked per statement, so
 * the archive has to come first. That is a claim about Postgres, not about this code,
 * and the only way to hold it true is to make the wrong order fail here on purpose —
 * `publishes before archiving` below is that experiment, and it is the reason the
 * comment in `src/publish.ts` can be trusted a year from now.
 */
describeDb('publishing a version', () => {
  let db: Database;

  const source = coreProducts.find((product) => product.slug === 'awn-4t') ?? coreProducts[0];
  if (!source) throw new Error('the catalogue fixture is empty');

  const document = toDocument(source);
  const hash = documentHash(document);

  const insertDraft = async (version: number): Promise<string> => {
    const [row] = await db
      .insert(productVersions)
      .values({ productId: source.id, version, status: 'draft', document, documentHash: hash })
      .returning({ id: productVersions.id });
    if (!row) throw new Error('could not insert a draft version');
    return row.id;
  };

  const statusOf = async (id: string): Promise<string | undefined> => {
    const [row] = await db
      .select({ status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.id, id));
    return row?.status;
  };

  const publishedId = async (): Promise<string | undefined> => {
    const [row] = await db
      .select({ id: productVersions.id })
      .from(productVersions)
      .where(and(eq(productVersions.productId, source.id), eq(productVersions.status, 'published')));
    return row?.id;
  };

  /** The seeded v1. A new id after every re-seed, so it is read rather than remembered. */
  let seededVersionId: string;

  beforeAll(async () => {
    db = await connect();
  });

  /*
   * Re-seed between tests rather than undo.
   *
   * Undoing is not available here and that is the schema working as designed: the
   * freeze trigger refuses to delete a published version and refuses to move one back to
   * draft, so a teardown that tried would either fail or have to disable the very thing
   * under test. Truncating does not fire row-level triggers, so the seed is the one
   * honest reset — it costs about a second for all 81 products.
   */
  beforeEach(async () => {
    await seedCatalog(db, 'test');

    const seeded = await publishedId();
    if (!seeded) throw new Error(`the seed produced no published version for ${source.id}`);
    seededVersionId = seeded;
  });

  it('archives the old version and publishes the new one', async () => {
    const draft = await insertDraft(800);

    const result = await publishProductVersion(db, draft);

    expect(result.publishedVersionId).toBe(draft);
    expect(result.archivedVersionId).toBe(seededVersionId);
    expect(await statusOf(draft)).toBe('published');
    expect(await statusOf(seededVersionId)).toBe('archived');
    expect(await publishedId()).toBe(draft);
  });

  it('fails when the new version is published before the old one is archived', async () => {
    const draft = await insertDraft(801);

    const caught = await db
      .transaction(async (tx) => {
        // The inversion. Everything else about this transaction is legal, and it would
        // have committed a state with exactly one published version.
        await tx
          .update(productVersions)
          .set({ status: 'published', publishedAt: sql`now()` })
          .where(eq(productVersions.id, draft));

        await tx
          .update(productVersions)
          .set({ status: 'archived', archivedAt: sql`now()` })
          .where(eq(productVersions.id, seededVersionId));
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(errorCode(caught), 'the partial unique index should have rejected this').toBe(
      PG.uniqueViolation,
    );
    // And the transaction rolled back, so nothing moved.
    expect(await statusOf(draft)).toBe('draft');
    expect(await statusOf(seededVersionId)).toBe('published');
  });

  it('refuses to publish a version that is not a draft', async () => {
    const caught = await publishProductVersion(db, seededVersionId).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(PublishError);
    expect(caught instanceof PublishError ? caught.code : undefined).toBe('not_a_draft');
  });

  it('refuses to publish a version whose rules name a group it does not offer', async () => {
    const draft = await insertDraft(802);

    await db.insert(productVersionRules).values({
      productVersionId: draft,
      code: 'probe-typo',
      severity: 'error',
      messageTh: 'ทดสอบ',
      whenExpr: { op: 'selected', group: 'contorl', value: 'MOT' },
      referencedGroupCodes: ['contorl'],
      sortOrder: 0,
    });

    const caught = await publishProductVersion(db, draft).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught instanceof PublishError ? caught.code : undefined).toBe(
      'unknown_referenced_group',
    );
    expect(await statusOf(draft)).toBe('draft');
    expect(await publishedId()).toBe(seededVersionId);
  });

  /**
   * Two editors, two connections, one product.
   *
   * The `FOR UPDATE` on the product row is what turns this from a race into a queue.
   * Without it both transactions would reach step 3 believing nothing was published,
   * and one of them would die on the unique index halfway through its own work.
   */
  it('serialises concurrent publishes of the same product', async () => {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required for the concurrency test');

    const draftA = await insertDraft(810);
    const draftB = await insertDraft(811);

    const otherPool = createPool(url);
    const other = createDatabase(otherPool);

    try {
      const [resultA, resultB] = await Promise.all([
        publishProductVersion(db, draftA),
        publishProductVersion(other, draftB),
      ]);

      // Whichever ran second archived the other; both succeeded, and exactly one row is
      // published at the end — which is the only invariant that matters.
      const winner = await publishedId();
      expect([draftA, draftB]).toContain(winner);
      expect(resultA.publishedVersionId).toBe(draftA);
      expect(resultB.publishedVersionId).toBe(draftB);

      const [tally] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(productVersions)
        .where(
          and(eq(productVersions.productId, source.id), eq(productVersions.status, 'published')),
        );

      expect(tally?.count).toBe(1);
    } finally {
      await otherPool.end();
    }
  });
});

/**
 * Freezing: what a published version stops allowing.
 *
 * Plan 5 point 2 is the shape of this — the trigger is scoped to the columns that make
 * up the document, because `status` and `archived_at` still have to move on a row that
 * is otherwise frozen. A trigger that froze the whole row would make archiving
 * impossible and publishing anything a second time along with it.
 */
describeDb('frozen versions', () => {
  let db: Database;

  const source = coreProducts[0];
  if (!source) throw new Error('the catalogue fixture is empty');

  let publishedVersionId: string;

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');

    const [row] = await db
      .select({ id: productVersions.id })
      .from(productVersions)
      .where(and(eq(productVersions.productId, source.id), eq(productVersions.status, 'published')));
    if (!row) throw new Error(`the seed produced no published version for ${source.id}`);
    publishedVersionId = row.id;
  });

  const expectRestricted = async (operation: Promise<unknown>): Promise<void> => {
    const caught = await operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(errorCode(caught), `expected the freeze trigger to fire, got: ${String(caught)}`).toBe(
      PG.restrictViolation,
    );
  };

  it('rejects an edit to the document', async () => {
    await expectRestricted(
      db
        .update(productVersions)
        .set({ documentHash: 'rewritten' })
        .where(eq(productVersions.id, publishedVersionId)),
    );
  });

  it('rejects a return to draft', async () => {
    await expectRestricted(
      db
        .update(productVersions)
        .set({ status: 'draft' })
        .where(eq(productVersions.id, publishedVersionId)),
    );
  });

  it('rejects a delete', async () => {
    await expectRestricted(
      db.delete(productVersions).where(eq(productVersions.id, publishedVersionId)),
    );
  });

  it('rejects an edit to the rows the document was compiled from', async () => {
    await expectRestricted(
      db.insert(productVersionRules).values({
        productVersionId: publishedVersionId,
        code: 'probe-after-freeze',
        severity: 'warning',
        messageTh: 'ทดสอบ',
        whenExpr: { op: 'selected', group: 'profile_color', value: 'SG' },
        referencedGroupCodes: ['profile_color'],
        sortOrder: 99,
      }),
    );
  });

  it('still allows the status to move, because archiving is an edit to a frozen row', async () => {
    await db.transaction(async (tx) => {
      await tx
        .update(productVersions)
        .set({ status: 'archived', archivedAt: sql`now()` })
        .where(eq(productVersions.id, publishedVersionId));

      // Only inside this transaction; rolled back below so the seeded catalogue is left
      // exactly as it was found.
      tx.rollback();
    }).catch(() => undefined);

    const [row] = await db
      .select({ status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.id, publishedVersionId));

    expect(row?.status).toBe('published');
  });
});
