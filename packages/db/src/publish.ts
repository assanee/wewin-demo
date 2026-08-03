import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  productVersionOptions,
  productVersionRules,
  productVersions,
  products,
  optionGroups,
} from './schema/index.js';

/**
 * Publishing a version — the statement order, written where the next person will find
 * it.
 *
 * Three things have to happen and only one order works:
 *
 *   1. `SELECT ... FOR UPDATE` on the product row.
 *
 *      The lock is taken on `products`, not on any version row, because the thing being
 *      serialised is "which version of this product is published" and a competing
 *      transaction may be inserting a row that does not exist yet — there is nothing to
 *      lock on the other side. Two editors pressing Publish at the same instant queue
 *      here instead of one of them losing at step 3 with a constraint violation and a
 *      half-finished transaction.
 *
 *   2. Archive the version that is published now.
 *
 *   3. Publish the new one.
 *
 *      Steps 2 and 3 cannot be swapped. `product_versions_one_published_per_product` is
 *      a *partial* unique index: it is evaluated at the end of each statement, and a
 *      partial index cannot be declared DEFERRABLE (only unique constraints can, and a
 *      unique constraint cannot carry a WHERE clause). So a transaction that publishes
 *      first and archives second raises 23505 on the first statement even though it
 *      would have committed a perfectly legal state. `tests/publish.test.ts` runs that
 *      inversion and asserts the error, so this comment cannot quietly stop being true.
 *
 * The integrity check before any of it is what `referenced_group_codes` is for: a rule
 * that names a group the version does not offer cannot be evaluated, and evaluating it
 * is `evalExpr`'s throw on a customer's screen. Cheap here, expensive there.
 */

/** Drizzle names the transaction handle nowhere public, so it is read off the callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type PublishErrorCode = 'version_not_found' | 'not_a_draft' | 'unknown_referenced_group';

export class PublishError extends Error {
  // A field and an assignment rather than a parameter property: `erasableSyntaxOnly`
  // is on, so the only TypeScript allowed here is the kind that erases to nothing.
  readonly code: PublishErrorCode;

  constructor(message: string, code: PublishErrorCode) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

export interface PublishResult {
  publishedVersionId: string;
  /** The version this one replaced, if the product had one. */
  archivedVersionId: string | null;
  publishedAt: Date;
}

export async function publishProductVersion(
  db: Database,
  versionId: string,
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({ productId: productVersions.productId })
      .from(productVersions)
      .where(eq(productVersions.id, versionId))
      .limit(1);

    if (!version) {
      throw new PublishError(`no product version ${versionId}`, 'version_not_found');
    }

    // Step 1. Everything after this point is serialised per product.
    await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, version.productId))
      .for('update');

    /*
     * The status is read *after* the lock, not with the product id above.
     * Two editors publishing the same draft would otherwise both see 'draft', and the
     * one that waited would archive the version the winner had just published and then
     * try to publish it back out of 'archived'. Reading under the lock makes the loser
     * fail with `not_a_draft`, which is what actually happened.
     */
    const [locked] = await tx
      .select({ status: productVersions.status })
      .from(productVersions)
      .where(eq(productVersions.id, versionId))
      .limit(1);

    if (locked?.status !== 'draft') {
      throw new PublishError(
        `product version ${versionId} is ${locked?.status ?? 'gone'}, only a draft can be published`,
        'not_a_draft',
      );
    }

    await assertRuleReferencesResolve(tx, versionId);

    // Step 2. Archive first — see the note above; the reverse order raises 23505.
    const archived = await tx
      .update(productVersions)
      .set({ status: 'archived', archivedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(productVersions.productId, version.productId),
          eq(productVersions.status, 'published'),
        ),
      )
      .returning({ id: productVersions.id });

    // Step 3.
    const [published] = await tx
      .update(productVersions)
      .set({ status: 'published', publishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(productVersions.id, versionId))
      .returning({ id: productVersions.id, publishedAt: productVersions.publishedAt });

    // Unreachable while the product lock is held; asserted rather than assumed because
    // the alternative is returning a `publishedAt` of `null` as if it were a timestamp.
    if (!published?.publishedAt) {
      throw new PublishError(`product version ${versionId} vanished mid-publish`, 'version_not_found');
    }

    return {
      publishedVersionId: published.id,
      archivedVersionId: archived[0]?.id ?? null,
      publishedAt: published.publishedAt,
    };
  });
}

/**
 * Every group code any rule of this version names must be a group this version offers.
 *
 * The same check `parseCatalog` runs over the TS table, run over rows instead — which
 * is the only place it can run once the catalogue is edited a field at a time and no
 * single object ever holds the whole product.
 */
async function assertRuleReferencesResolve(tx: Tx, versionId: string): Promise<void> {
  const offered = await tx
    .select({ code: optionGroups.code })
    .from(productVersionOptions)
    .innerJoin(optionGroups, eq(optionGroups.id, productVersionOptions.optionGroupId))
    .where(eq(productVersionOptions.productVersionId, versionId));

  const offeredCodes = new Set(offered.map((row) => row.code));

  const rules = await tx
    .select({ code: productVersionRules.code, referenced: productVersionRules.referencedGroupCodes })
    .from(productVersionRules)
    .where(eq(productVersionRules.productVersionId, versionId));

  const unknown = rules.flatMap((rule) =>
    rule.referenced.filter((code) => !offeredCodes.has(code)).map((code) => `${rule.code} → ${code}`),
  );

  if (unknown.length > 0) {
    throw new PublishError(
      `product version ${versionId} has rules referencing groups it does not offer: ${unknown.join(', ')}`,
      'unknown_referenced_group',
    );
  }
}

/**
 * "This version is the published one", written once.
 *
 * Exported rather than inlined at each call site because it has to match
 * `product_versions_one_published_per_product` exactly: a query that spelled the
 * predicate differently would stop using the partial index and — the expensive half —
 * could disagree with it about what "published" means. apps/api's catalogue read path
 * composes this with its own joins instead of restating it.
 */
export const isPublished = eq(productVersions.status, 'published');

/**
 * The published version of each product, for a read path that needs whole rows.
 */
export function publishedVersions(db: Database, productIds?: readonly string[]) {
  return db
    .select()
    .from(productVersions)
    .where(
      productIds
        ? and(isPublished, inArray(productVersions.productId, [...productIds]))
        : isPublished,
    );
}
