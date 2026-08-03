import { eq, sql } from 'drizzle-orm';
import type { OptionGroup, OptionValue, Product } from '@wewin/core';
import { categories as coreCategories, products as coreProducts } from '@wewin/core/fixtures';
import { bahtToMinor } from '@wewin/core/money';
import type { Database } from './client.js';
import { referencedGroupCodes, toDocument } from './compile.js';
import { documentHash } from './hash.js';
import {
  categories,
  optionGroups,
  optionValues,
  productVersionOptionValues,
  productVersionOptions,
  productVersionRules,
  productVersions,
  products,
  seedRuns,
} from './schema/index.js';

/**
 * The 81-product table from `@wewin/core/fixtures`, written into the two layers.
 *
 * It is a seed and not a migration: the table is still the authored source in phase 3a,
 * and the dashboard that will make Postgres the source arrives in phase 4. Until then
 * this is how the two representations are kept honest — anything the schema cannot hold
 * fails here, loudly, against a real server rather than in a review.
 *
 * `@wewin/core/fixtures` has already been through `parseCatalog` at module load, so
 * every product below is valid by core's rules. What this proves is the other
 * direction: that the constraints in `src/schema` accept all 81 and that the compiled
 * documents come back out identical (`tests/seed.test.ts`).
 */

/**
 * One shared definition per group code, taken from the first product that offers it.
 *
 * The catalogue builds all 81 products from ten group factories, so `profile_color`
 * really is one concept with one label — what differs per product is the value subset,
 * the default and the size range, and all three live on the version rows. Asserting
 * the shared parts actually match is `assertGroupsAgree` below; a catalogue where two
 * products disagreed about what `profile_color` means would need a schema change, not
 * a silent last-writer-wins.
 */
interface SharedDelta {
  type: 'none' | 'flat' | 'per_sqm' | 'percent';
  minor: bigint | null;
  bp: number | null;
}

interface SharedValue {
  labelTh: string;
  swatchHex: string | null;
  delta: SharedDelta;
  available: boolean;
}

interface SharedGroup {
  code: string;
  kind: OptionGroup['kind'];
  labelTh: string;
  input: OptionGroup['input'];
  includeInSkuCode: boolean;
  authoredUnit: 'cm' | 'mm' | null;
  helperTh: string | null;
  /** sku groups only: every value any product offers, in first-seen order. */
  values: Map<string, SharedValue>;
}

const sharedDelta = (value: OptionValue): SharedDelta => {
  switch (value.delta.type) {
    case 'none':
      return { type: 'none', minor: null, bp: null };
    case 'flat':
      return { type: 'flat', minor: bahtToMinor(value.delta.amount), bp: null };
    case 'per_sqm':
      return { type: 'per_sqm', minor: bahtToMinor(value.delta.amount), bp: null };
    case 'percent':
      return { type: 'percent', minor: null, bp: Math.round(value.delta.amount * 100) };
  }
};

function collectGroups(catalogue: readonly Product[]): Map<string, SharedGroup> {
  const shared = new Map<string, SharedGroup>();

  for (const product of catalogue) {
    for (const group of product.groups) {
      let entry = shared.get(group.code);

      if (!entry) {
        entry = {
          code: group.code,
          kind: group.kind,
          labelTh: group.labelTh,
          input: group.input,
          includeInSkuCode: group.kind === 'sku' ? group.includeInSkuCode : false,
          authoredUnit: group.kind === 'custom' ? group.unit : null,
          helperTh: group.kind === 'custom' ? (group.helperTh ?? null) : null,
          values: new Map(),
        };
        shared.set(group.code, entry);
      }

      assertGroupsAgree(entry, group);

      if (group.kind === 'sku') {
        for (const value of group.values) {
          if (!entry.values.has(value.code)) {
            entry.values.set(value.code, {
              labelTh: value.labelTh,
              swatchHex: value.swatchHex ?? null,
              delta: sharedDelta(value),
              available: value.available,
            });
          }
        }
      }
    }
  }

  return shared;
}

function assertGroupsAgree(entry: SharedGroup, group: OptionGroup): void {
  const mismatch =
    entry.kind !== group.kind ||
    entry.labelTh !== group.labelTh ||
    entry.input !== group.input ||
    (group.kind === 'custom' && entry.authoredUnit !== group.unit);

  if (mismatch) {
    throw new Error(
      `group "${group.code}" is defined differently by two products; the shared option_groups row cannot hold both`,
    );
  }
}

export interface SeedResult {
  categories: number;
  products: number;
  optionGroups: number;
  optionValues: number;
  publishedVersions: number;
}

/**
 * Wipe the catalogue and write it again, in one transaction.
 *
 * Truncate rather than upsert because a seed that merges leaves whatever the last run
 * created and the current run no longer produces — which is how a removed product goes
 * on being sold. `CASCADE` reaches the version tables; nothing outside the catalogue
 * exists yet in phase 3a, and when orders do, this function stops being safe to run and
 * has to grow a guard. That is the point of it living here rather than in a script.
 */
export async function seedCatalog(db: Database, coreVersion = 'workspace'): Promise<SeedResult> {
  const shared = collectGroups(coreProducts);
  // Compiled once and reused: the document is what the version row freezes and what
  // the rule rows are cut from, and compiling it twice invites the two to differ.
  const documents = new Map(coreProducts.map((product) => [product.id, toDocument(product)]));

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`truncate table ${categories}, ${products}, ${optionGroups} restart identity cascade`,
    );

    await tx.insert(categories).values(
      coreCategories.map((category, index) => ({
        id: category.id,
        labelTh: category.labelTh,
        summaryTh: category.summaryTh,
        sortOrder: index,
      })),
    );

    const groupRows = await tx
      .insert(optionGroups)
      .values(
        [...shared.values()].map((group) => ({
          code: group.code,
          kind: group.kind,
          labelTh: group.labelTh,
          input: group.input,
          includeInSkuCode: group.includeInSkuCode,
          authoredUnit: group.authoredUnit,
          helperTh: group.helperTh,
        })),
      )
      .returning({ id: optionGroups.id, code: optionGroups.code });

    const groupIdByCode = new Map(groupRows.map((row) => [row.code, row.id]));

    const valueRowsToInsert = [...shared.values()].flatMap((group) =>
      [...group.values.entries()].map(([code, value], index) => ({
        optionGroupId: groupIdByCode.get(group.code) ?? missing(group.code),
        groupKind: 'sku' as const,
        code,
        labelTh: value.labelTh,
        swatchHex: value.swatchHex,
        deltaType: value.delta.type,
        deltaMinor: value.delta.minor,
        deltaBp: value.delta.bp,
        available: value.available,
        sortOrder: index,
      })),
    );

    const valueRows = valueRowsToInsert.length
      ? await tx
          .insert(optionValues)
          .values(valueRowsToInsert)
          .returning({
            id: optionValues.id,
            optionGroupId: optionValues.optionGroupId,
            code: optionValues.code,
          })
      : [];

    const valueIdByGroupAndCode = new Map(
      valueRows.map((row) => [`${row.optionGroupId}:${row.code}`, row.id]),
    );

    await tx.insert(products).values(
      coreProducts.map((product) => ({
        id: product.id,
        slug: product.slug,
        skuPrefix: product.skuPrefix,
        categoryId: product.categoryId,
        nameTh: product.nameTh,
        summaryTh: product.summaryTh,
        heroImage: product.heroImage,
        leadTimeMinDays: product.leadTimeDays[0],
        leadTimeMaxDays: product.leadTimeDays[1],
        pricePerSqmMinor: bahtToMinor(product.pricePerSqm),
        minBillableSqUm: product.minBillableSqUm,
        elevation: product.elevation,
      })),
    );

    const versionRows = await tx
      .insert(productVersions)
      .values(
        coreProducts.map((product) => {
          const document = documents.get(product.id) ?? missing(product.id);
          return {
            productId: product.id,
            version: 1,
            // Draft, not published — the option and rule rows below cannot be written
            // against a frozen version, which is the freeze trigger doing its job on
            // the seed exactly as it would on the dashboard.
            status: 'draft' as const,
            document,
            documentHash: documentHash(document),
          };
        }),
      )
      .returning({ id: productVersions.id, productId: productVersions.productId });

    const versionIdByProduct = new Map(versionRows.map((row) => [row.productId, row.id]));

    const optionRows = await tx
      .insert(productVersionOptions)
      .values(
        coreProducts.flatMap((product) =>
          product.groups.map((group, index) => ({
            productVersionId: versionIdByProduct.get(product.id) ?? missing(product.id),
            optionGroupId: groupIdByCode.get(group.code) ?? missing(group.code),
            groupKind: group.kind,
            sortOrder: index,
            defaultValueCode: group.kind === 'sku' ? group.defaultValue : null,
            minUm: group.kind === 'custom' ? group.minUm : null,
            maxUm: group.kind === 'custom' ? group.maxUm : null,
            stepUm: group.kind === 'custom' ? group.stepUm : null,
            defaultUm: group.kind === 'custom' ? group.defaultUm : null,
          })),
        ),
      )
      .returning({
        id: productVersionOptions.id,
        productVersionId: productVersionOptions.productVersionId,
        optionGroupId: productVersionOptions.optionGroupId,
      });

    const versionOptionId = new Map(
      optionRows.map((row) => [`${row.productVersionId}:${row.optionGroupId}`, row.id]),
    );

    const offeredValues = coreProducts.flatMap((product) =>
      product.groups.flatMap((group) => {
        if (group.kind !== 'sku') return [];

        const versionId = versionIdByProduct.get(product.id) ?? missing(product.id);
        const groupId = groupIdByCode.get(group.code) ?? missing(group.code);

        return group.values.map((value, index) => ({
          productVersionOptionId:
            versionOptionId.get(`${versionId}:${groupId}`) ?? missing(group.code),
          optionGroupId: groupId,
          optionValueId: valueIdByGroupAndCode.get(`${groupId}:${value.code}`) ?? missing(value.code),
          sortOrder: index,
        }));
      }),
    );

    if (offeredValues.length > 0) {
      await tx.insert(productVersionOptionValues).values(offeredValues);
    }

    const ruleRows = coreProducts.flatMap((product) => {
      const document = documents.get(product.id) ?? missing(product.id);

      return product.rules.map((rule, index) => ({
        productVersionId: versionIdByProduct.get(product.id) ?? missing(product.id),
        code: rule.id,
        severity: rule.severity,
        messageTh: rule.messageTh,
        whenExpr: document.rules[index]?.when ?? missing(rule.id),
        referencedGroupCodes: referencedGroupCodes(rule.when),
        sortOrder: index,
      }));
    });

    if (ruleRows.length > 0) {
      await tx.insert(productVersionRules).values(ruleRows);
    }

    /*
     * Publish last, in one statement.
     *
     * The archive step of `publishProductVersion` has nothing to archive on a fresh
     * catalogue, and every product has exactly one draft, so a single UPDATE leaves one
     * published row per product and the partial unique index is satisfied at the end of
     * that statement. The ordering rule still applies to every publish after this one.
     */
    await tx
      .update(productVersions)
      .set({ status: 'published', publishedAt: sql`now()` })
      .where(eq(productVersions.status, 'draft'));

    await tx.insert(seedRuns).values({ coreVersion, productCount: coreProducts.length });

    return {
      categories: coreCategories.length,
      products: coreProducts.length,
      optionGroups: groupRows.length,
      optionValues: valueRows.length,
      publishedVersions: versionRows.length,
    };
  });
}

/**
 * A lookup that should not have missed.
 *
 * `?? missing(...)` instead of `!`: house rule forbids the assertion operator, and this
 * says which key was absent, which the operator never could.
 */
function missing(key: string): never {
  throw new Error(`seed: no row for "${key}" — the insert above did not return what it inserted`);
}
