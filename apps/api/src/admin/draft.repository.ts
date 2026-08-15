import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, asc, desc, eq, inArray, sql } from '@wewin/db/sql';
import type { CatalogDocumentV1, DocRuleExpr } from '@wewin/db/document';
import { referencedGroupCodes, toDocRule } from '@wewin/db/compile';
import {
  optionGroups,
  optionValues,
  productImages,
  productVersionOptionValues,
  productVersionOptions,
  productVersionRules,
  productVersions,
  products,
} from '@wewin/db/schema';
import { decodeRuleExpr } from '@wewin/contract/catalog';
import {
  decodeLengthUm,
  decodeMinBillableSqUm,
  decodePricePerSqmMinor,
  decodeStoredPriceDelta,
  type CreateOptionGroupRequestWire,
  type CreateOptionValueRequestWire,
  type DraftOptionWire,
  type DraftRuleWire,
  type ProductFieldsPatchWire,
  type ProductFieldsWire,
  type UpdateOptionGroupRequestWire,
  type UpdateOptionValueRequestWire,
} from '@wewin/contract/admin';
import { decodeElevation } from '@wewin/contract/catalog';

import { AppError } from '../common/errors/app-error';
import { code, message } from '../i18n';
import { DRIZZLE } from '../database/database.tokens';
import {
  compileDraft,
  type CompiledDraft,
  type DraftOptionRow,
  type DraftOptionValueRow,
  type DraftProductRow,
  type DraftRows,
  type DraftRuleRow,
} from './draft-document';
import { withTranslatedErrors } from './pg-errors';

/**
 * Every statement the admin surface runs, and nothing about when it runs.
 *
 * The split from `catalog-admin.service.ts` is on purpose and it is not layering for its
 * own sake: **every method here takes a transaction handle it did not open.** That is what
 * makes the ordering rules readable in one place — the product lock, the recompile, the
 * publish — instead of being distributed across a dozen methods each with its own opinion
 * about whether it is atomic.
 *
 * Drizzle names the transaction type nowhere public, so it is read off the callback
 * exactly as `packages/db/src/publish.ts` does.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface VersionRow {
  readonly id: string;
  readonly version: number;
  readonly status: 'draft' | 'published' | 'archived';
  readonly documentHash: string;
  readonly document: CatalogDocumentV1;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
}

@Injectable()
export class DraftRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** The one door into a transaction, so a caller cannot forget to open one. */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /* ---------------------------------------------------------------- *
   * Locking and lookups
   * ---------------------------------------------------------------- */

  /**
   * Serialise everything about one product's versions.
   *
   * The same lock `publishProductVersion` takes, on the same row, for the same reason: the
   * thing being serialised is "which version of this product is which", and a competing
   * transaction may be *inserting* the row that would otherwise be the thing to lock. Two
   * editors opening a draft at the same instant queue here instead of both succeeding and
   * leaving the product with two.
   *
   * Returns `false` when there is no such product, so a caller can answer 404 without a
   * second query.
   */
  async lockProduct(tx: Tx, productId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .for('update');
    return rows.length > 0;
  }

  async findVersion(
    tx: Tx,
    productId: string,
    status: 'draft' | 'published',
  ): Promise<VersionRow | undefined> {
    const [row] = await tx
      .select({
        id: productVersions.id,
        version: productVersions.version,
        status: productVersions.status,
        documentHash: productVersions.documentHash,
        document: productVersions.document,
        updatedAt: productVersions.updatedAt,
        publishedAt: productVersions.publishedAt,
      })
      .from(productVersions)
      .where(and(eq(productVersions.productId, productId), eq(productVersions.status, status)))
      .limit(1);

    return row;
  }

  /**
   * One version, by its own id, whatever status it is in.
   *
   * `findVersion` above asks "which version of this product is the draft/the published
   * one", which is the right question for every caller but one: after `publish` returns,
   * the version worth reporting is *the one this call froze*, named by the id the publish
   * returned. Asking by status instead would answer with whatever is published at the
   * moment of the read, which after a colleague's later publish is a different row — and a
   * response that carried one version's id beside another version's hash.
   */
  async findVersionById(tx: Tx, versionId: string): Promise<VersionRow | undefined> {
    const [row] = await tx
      .select({
        id: productVersions.id,
        version: productVersions.version,
        status: productVersions.status,
        documentHash: productVersions.documentHash,
        document: productVersions.document,
        updatedAt: productVersions.updatedAt,
        publishedAt: productVersions.publishedAt,
      })
      .from(productVersions)
      .where(eq(productVersions.id, versionId))
      .limit(1);

    return row;
  }

  /**
   * One past the highest number this product has ever used.
   *
   * `max(version) + 1` and not `count(*) + 1`: a discarded draft leaves a gap, and counting
   * would reissue a number `product_versions_product_version_key` has already seen. Version
   * numbers are what a person says out loud about a product, so they only ever go up.
   */
  async nextVersionNumber(tx: Tx, productId: string): Promise<number> {
    const [row] = await tx
      .select({ version: productVersions.version })
      .from(productVersions)
      .where(eq(productVersions.productId, productId))
      .orderBy(desc(productVersions.version))
      .limit(1);

    return (row?.version ?? 0) + 1;
  }

  async productExists(tx: Tx, productId: string): Promise<boolean> {
    const [row] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1);
    return row !== undefined;
  }

  /* ---------------------------------------------------------------- *
   * Reading a draft
   * ---------------------------------------------------------------- */

  async loadRows(tx: Tx, productId: string, versionId: string): Promise<DraftRows> {
    const product = await this.loadProductRow(tx, productId);
    const [options, rules, images] = await Promise.all([
      this.loadOptionRows(tx, versionId),
      this.loadRuleRows(tx, versionId),
      /*
       * ⭐ 0052. Keyed by product and not by version, because `product_images` hangs off the
       * editable row like every other product field — the version freezes a copy at publish.
       */
      this.loadImages(tx, productId),
    ]);
    return { product, options, rules, images };
  }

  /**
   * Every named product's gallery at once, keyed by product.
   *
   * The admin list renders 81 products and asks each one whether its pictures differ from
   * what is published. `loadImages` per row would be 81 round trips for a screen that
   * already makes two; this is the third. A product with no pictures is simply absent from
   * the map, which the caller reads as an empty gallery.
   */
  async galleriesOf(tx: Tx, productIds: readonly string[]): Promise<Map<string, string[]>> {
    const byProduct = new Map<string, string[]>();
    if (productIds.length === 0) return byProduct;

    const rows = await tx
      .select({ productId: productImages.productId, path: productImages.path })
      .from(productImages)
      .where(inArray(productImages.productId, [...productIds]))
      .orderBy(asc(productImages.productId), asc(productImages.sortOrder));

    for (const row of rows) {
      const gallery = byProduct.get(row.productId);
      if (gallery === undefined) byProduct.set(row.productId, [row.path]);
      else gallery.push(row.path);
    }
    return byProduct;
  }

  /** The gallery, in `sort_order`. The order is content: the first picture is seen first. */
  async loadImages(tx: Tx, productId: string): Promise<readonly string[]> {
    const rows = await tx
      .select({ path: productImages.path })
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(asc(productImages.sortOrder));

    return rows.map((row) => row.path);
  }

  /** The product row, or `undefined`. `loadProductRow` is the same read that insists. */
  async findProductRow(tx: Tx, productId: string): Promise<DraftProductRow | undefined> {
    const [row] = await tx
      .select({
        id: products.id,
        slug: products.slug,
        skuPrefix: products.skuPrefix,
        categoryId: products.categoryId,
        nameTh: products.nameTh,
        summaryTh: products.summaryTh,
        heroImage: products.heroImage,
        leadTimeMinDays: products.leadTimeMinDays,
        leadTimeMaxDays: products.leadTimeMaxDays,
        pricePerSqmMinor: products.pricePerSqmMinor,
        minBillableSqUm: products.minBillableSqUm,
        elevation: products.elevation,
        videoUrl: products.videoUrl,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    return row;
  }

  private async loadProductRow(tx: Tx, productId: string): Promise<DraftProductRow> {
    const row = await this.findProductRow(tx, productId);
    if (!row) throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
    return row;
  }

  /**
   * A version's groups, with their values attached.
   *
   * Two queries and a join in memory rather than one query and a group-by: the value list
   * has to keep its own order (`pvov.sort_order`) *inside* an order over groups, and a
   * flat result set with both orderings is one where a reader has to reconstruct the
   * nesting anyway. Two round trips for one draft is not the query that will ever be hot.
   *
   * Both orderings fall back to a code, because `sort_order` is an editor's field and two
   * groups may share a number. The document is hashed, so "some order" is not enough —
   * two compiles of the same rows have to produce the same bytes or the storefront's
   * staleness check starts firing on documents that did not change.
   */
  private async loadOptionRows(tx: Tx, versionId: string): Promise<DraftOptionRow[]> {
    const optionRows = await tx
      .select({
        optionId: productVersionOptions.id,
        sortOrder: productVersionOptions.sortOrder,
        defaultValueCode: productVersionOptions.defaultValueCode,
        minUm: productVersionOptions.minUm,
        maxUm: productVersionOptions.maxUm,
        stepUm: productVersionOptions.stepUm,
        defaultUm: productVersionOptions.defaultUm,
        groupCode: optionGroups.code,
        kind: optionGroups.kind,
        labelTh: optionGroups.labelTh,
        input: optionGroups.input,
        includeInSkuCode: optionGroups.includeInSkuCode,
        authoredUnit: optionGroups.authoredUnit,
        helperTh: optionGroups.helperTh,
      })
      .from(productVersionOptions)
      .innerJoin(optionGroups, eq(optionGroups.id, productVersionOptions.optionGroupId))
      .where(eq(productVersionOptions.productVersionId, versionId))
      .orderBy(asc(productVersionOptions.sortOrder), asc(optionGroups.code));

    if (optionRows.length === 0) return [];

    const valueRows = await tx
      .select({
        optionId: productVersionOptionValues.productVersionOptionId,
        sortOrder: productVersionOptionValues.sortOrder,
        code: optionValues.code,
        labelTh: optionValues.labelTh,
        swatchHex: optionValues.swatchHex,
        deltaType: optionValues.deltaType,
        deltaMinor: optionValues.deltaMinor,
        deltaBp: optionValues.deltaBp,
        available: optionValues.available,
      })
      .from(productVersionOptionValues)
      .innerJoin(optionValues, eq(optionValues.id, productVersionOptionValues.optionValueId))
      .where(
        inArray(
          productVersionOptionValues.productVersionOptionId,
          optionRows.map((row) => row.optionId),
        ),
      )
      .orderBy(asc(productVersionOptionValues.sortOrder), asc(optionValues.code));

    const byOption = new Map<string, DraftOptionValueRow[]>();
    for (const row of valueRows) {
      const bucket = byOption.get(row.optionId);
      const value: DraftOptionValueRow = {
        code: row.code,
        labelTh: row.labelTh,
        swatchHex: row.swatchHex,
        deltaType: row.deltaType,
        deltaMinor: row.deltaMinor,
        deltaBp: row.deltaBp,
        available: row.available,
        sortOrder: row.sortOrder,
      };
      if (bucket) bucket.push(value);
      else byOption.set(row.optionId, [value]);
    }

    return optionRows.map((row) => ({
      groupCode: row.groupCode,
      kind: row.kind,
      labelTh: row.labelTh,
      input: row.input,
      includeInSkuCode: row.includeInSkuCode,
      authoredUnit: row.authoredUnit,
      helperTh: row.helperTh,
      sortOrder: row.sortOrder,
      defaultValueCode: row.defaultValueCode,
      minUm: row.minUm,
      maxUm: row.maxUm,
      stepUm: row.stepUm,
      defaultUm: row.defaultUm,
      values: byOption.get(row.optionId) ?? [],
    }));
  }

  private async loadRuleRows(tx: Tx, versionId: string): Promise<DraftRuleRow[]> {
    return tx
      .select({
        code: productVersionRules.code,
        severity: productVersionRules.severity,
        messageTh: productVersionRules.messageTh,
        whenExpr: productVersionRules.whenExpr,
        sortOrder: productVersionRules.sortOrder,
      })
      .from(productVersionRules)
      .where(eq(productVersionRules.productVersionId, versionId))
      .orderBy(asc(productVersionRules.sortOrder), asc(productVersionRules.code));
  }

  /* ---------------------------------------------------------------- *
   * The recompile — the invariant this module is built on
   * ---------------------------------------------------------------- */

  /**
   * Read the draft's rows, compile them, and store the result on the version row.
   *
   * Called at the end of *every* mutation, inside the same transaction, which is what makes
   * the invariant true at every commit point rather than at publish time:
   *
   *     product_versions.document == compile(the rows that version is made of)
   *
   * The alternative — compiling once at publish — leaves a draft whose stored document is
   * whatever it was when the version was opened, so the thing an editor previews is not the
   * thing that gets frozen, and a draft can sit for a week in a state that will fail to
   * publish. Recompiling per edit costs one small write per edit and buys a publish that
   * cannot fail for data reasons and a preview that is the document.
   *
   * `compileDraft` throws 422 on a draft core would refuse. That throw is inside the
   * caller's transaction, so the edit that broke the draft is rolled back with it — there
   * is no state in which a saved edit left the draft unpublishable.
   */
  async recompile(tx: Tx, productId: string, versionId: string): Promise<CompiledDraft> {
    const rows = await this.loadRows(tx, productId, versionId);
    const compiled = compileDraft(rows);

    await withTranslatedErrors(() =>
      tx
        .update(productVersions)
        .set({
          document: compiled.document,
          documentHash: compiled.documentHash,
          updatedAt: sql`now()`,
        })
        .where(eq(productVersions.id, versionId)),
    );

    return compiled;
  }

  /* ---------------------------------------------------------------- *
   * Products
   * ---------------------------------------------------------------- */

  async insertProduct(
    tx: Tx,
    identity: { readonly id: string; readonly slug: string; readonly skuPrefix: string },
    fields: ProductFieldsWire,
  ): Promise<void> {
    await withTranslatedErrors(() =>
      tx.insert(products).values({
        id: identity.id,
        slug: identity.slug,
        skuPrefix: identity.skuPrefix,
        categoryId: fields.categoryId,
        nameTh: fields.nameTh,
        summaryTh: fields.summaryTh,
        heroImage: fields.heroImage,
        leadTimeMinDays: fields.leadTimeDays[0],
        leadTimeMaxDays: fields.leadTimeDays[1],
        pricePerSqmMinor: decodePricePerSqmMinor(fields.pricePerSqm),
        minBillableSqUm: decodeMinBillableSqUm(fields.minBillableSqUm),
        elevation: decodeElevation(fields.elevation),
        /* ⭐ 0052. `undefined` and `null` both mean no video on a brand-new product. */
        videoUrl: fields.videoUrl ?? null,
      }),
    );

    /*
     * The gallery, if the caller sent one. Separate statement because it is a separate table;
     * same transaction, so a product cannot exist with half its pictures.
     */
    const images = fields.images ?? [];
    if (images.length > 0) {
      await withTranslatedErrors(() =>
        tx
          .insert(productImages)
          .values(images.map((path, index) => ({ productId: identity.id, path, sortOrder: index }))),
      );
    }
  }

  /**
   * Patch the product row.
   *
   * Every branch is spelled out rather than built by iterating the request object, because
   * the two exact quantities have to go through their decoders — `pricePerSqm` is satang
   * per m² on the wire and satang in the column, and `minBillableSqUm` is µm². A generic
   * copy would put a `MoneyRateWire` object into a `bigint` column, and the failure would
   * be a driver error rather than a type error.
   */
  async updateProductFields(
    tx: Tx,
    productId: string,
    patch: {
      readonly slug?: string | undefined;
      readonly skuPrefix?: string | undefined;
      readonly fields?: ProductFieldsPatchWire | undefined;
    },
  ): Promise<boolean> {
    const set: Record<string, unknown> = {};

    if (patch.slug !== undefined) set['slug'] = patch.slug;
    if (patch.skuPrefix !== undefined) set['skuPrefix'] = patch.skuPrefix;

    const fields = patch.fields;
    if (fields) {
      if (fields.nameTh !== undefined) set['nameTh'] = fields.nameTh;
      if (fields.categoryId !== undefined) set['categoryId'] = fields.categoryId;
      if (fields.summaryTh !== undefined) set['summaryTh'] = fields.summaryTh;
      if (fields.heroImage !== undefined) set['heroImage'] = fields.heroImage;
      if (fields.leadTimeDays !== undefined) {
        set['leadTimeMinDays'] = fields.leadTimeDays[0];
        set['leadTimeMaxDays'] = fields.leadTimeDays[1];
      }
      if (fields.pricePerSqm !== undefined) {
        set['pricePerSqmMinor'] = decodePricePerSqmMinor(fields.pricePerSqm);
      }
      if (fields.minBillableSqUm !== undefined) {
        set['minBillableSqUm'] = decodeMinBillableSqUm(fields.minBillableSqUm);
      }
      if (fields.elevation !== undefined) set['elevation'] = decodeElevation(fields.elevation);
      /*
       * ⭐ 0052. `null` clears the link and `undefined` leaves it alone — which is why the wire
       * type is `string | null | undefined` rather than merely optional. With optional alone
       * there is no way to say "remove the video" that a patch can tell apart from silence.
       */
      if (fields.videoUrl !== undefined) set['videoUrl'] = fields.videoUrl;
    }

    /*
     * ⭐ 0052. The gallery is rows, not a column, so it is replaced rather than merged — and it
     * counts as a change even when no column moved, which is why it runs before the guard below.
     * Sending `images: []` is how a person removes every picture.
     *
     * Delete-then-insert rather than a diff: `product_images_product_sort_key` is unique on
     * `(product_id, sort_order)`, so re-inserting a moved picture before deleting whatever held
     * its position is a constraint violation. It runs inside the caller's transaction, so a
     * failed insert leaves the old gallery intact rather than an empty one.
     */
    const images = patch.fields?.images;
    if (images !== undefined) {
      await tx.delete(productImages).where(eq(productImages.productId, productId));
      if (images.length > 0) {
        await withTranslatedErrors(() =>
          tx
            .insert(productImages)
            .values(images.map((path, index) => ({ productId, path, sortOrder: index }))),
        );
      }
    }

    if (Object.keys(set).length === 0) return images !== undefined;

    set['updatedAt'] = sql`now()`;
    await withTranslatedErrors(() =>
      tx.update(products).set(set).where(eq(products.id, productId)),
    );
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Versions
   * ---------------------------------------------------------------- */

  /**
   * Open a draft row.
   *
   * `document` is `NOT NULL` and its schema version has to match the column beside it
   * (`product_versions_document_schema_version_matches`), so a version cannot be inserted
   * empty and filled in afterwards. The seed document handed in here is provisional: the
   * caller inserts the option and rule rows and then calls `recompile`, which overwrites it
   * with the compile of what was actually written. The provisional value never leaves the
   * transaction.
   */
  async insertDraftVersion(
    tx: Tx,
    productId: string,
    version: number,
    seed: { readonly document: CatalogDocumentV1; readonly documentHash: string },
  ): Promise<string> {
    const [row] = await withTranslatedErrors(() =>
      tx
        .insert(productVersions)
        .values({
          productId,
          version,
          status: 'draft',
          document: seed.document,
          documentHash: seed.documentHash,
        })
        .returning({ id: productVersions.id }),
    );

    if (!row) throw new Error('admin: inserting a draft version returned no row');
    return row.id;
  }

  /**
   * Copy a version's option and rule rows onto a new draft.
   *
   * This is what "edit a published product" means: the published rows are frozen — the
   * children triggers in `0001_catalog_freeze.sql` refuse an INSERT, UPDATE *or* DELETE
   * against a non-draft parent — so the next version starts as a copy rather than by
   * borrowing them. Copying is also what makes the two versions independently editable
   * afterwards, which is the whole reason an order can still be read against the old one.
   */
  async copyVersionChildren(tx: Tx, fromVersionId: string, toVersionId: string): Promise<void> {
    const sourceOptions = await tx
      .select({
        id: productVersionOptions.id,
        optionGroupId: productVersionOptions.optionGroupId,
        groupKind: productVersionOptions.groupKind,
        sortOrder: productVersionOptions.sortOrder,
        defaultValueCode: productVersionOptions.defaultValueCode,
        minUm: productVersionOptions.minUm,
        maxUm: productVersionOptions.maxUm,
        stepUm: productVersionOptions.stepUm,
        defaultUm: productVersionOptions.defaultUm,
      })
      .from(productVersionOptions)
      .where(eq(productVersionOptions.productVersionId, fromVersionId));

    if (sourceOptions.length > 0) {
      const inserted = await withTranslatedErrors(() =>
        tx
          .insert(productVersionOptions)
          .values(
            sourceOptions.map((option) => ({
              productVersionId: toVersionId,
              optionGroupId: option.optionGroupId,
              groupKind: option.groupKind,
              sortOrder: option.sortOrder,
              defaultValueCode: option.defaultValueCode,
              minUm: option.minUm,
              maxUm: option.maxUm,
              stepUm: option.stepUm,
              defaultUm: option.defaultUm,
            })),
          )
          .returning({ id: productVersionOptions.id, optionGroupId: productVersionOptions.optionGroupId }),
      );

      const newOptionIdByGroup = new Map(inserted.map((row) => [row.optionGroupId, row.id]));

      const sourceValues = await tx
        .select({
          optionGroupId: productVersionOptionValues.optionGroupId,
          optionValueId: productVersionOptionValues.optionValueId,
          sortOrder: productVersionOptionValues.sortOrder,
        })
        .from(productVersionOptionValues)
        .where(
          inArray(
            productVersionOptionValues.productVersionOptionId,
            sourceOptions.map((option) => option.id),
          ),
        );

      if (sourceValues.length > 0) {
        await withTranslatedErrors(() =>
          tx.insert(productVersionOptionValues).values(
            sourceValues.map((value) => {
              const optionId = newOptionIdByGroup.get(value.optionGroupId);
              if (optionId === undefined) {
                throw new Error(
                  `admin: copying version ${fromVersionId} found a value for group ${value.optionGroupId} with no copied option row`,
                );
              }
              return {
                productVersionOptionId: optionId,
                optionGroupId: value.optionGroupId,
                optionValueId: value.optionValueId,
                sortOrder: value.sortOrder,
              };
            }),
          ),
        );
      }
    }

    const sourceRules = await tx
      .select({
        code: productVersionRules.code,
        severity: productVersionRules.severity,
        messageTh: productVersionRules.messageTh,
        whenExpr: productVersionRules.whenExpr,
        referencedGroupCodes: productVersionRules.referencedGroupCodes,
        sortOrder: productVersionRules.sortOrder,
      })
      .from(productVersionRules)
      .where(eq(productVersionRules.productVersionId, fromVersionId));

    if (sourceRules.length > 0) {
      await withTranslatedErrors(() =>
        tx.insert(productVersionRules).values(
          sourceRules.map((rule) => ({ ...rule, productVersionId: toVersionId })),
        ),
      );
    }
  }

  async deleteDraftVersion(tx: Tx, versionId: string): Promise<void> {
    // The children cascade; `product_versions_block_delete` refuses anything but a draft,
    // so a mistake here is a 409 and not a lost published document.
    await withTranslatedErrors(() =>
      tx.delete(productVersions).where(eq(productVersions.id, versionId)),
    );
  }

  /* ---------------------------------------------------------------- *
   * Draft options
   * ---------------------------------------------------------------- */

  /**
   * Set one group's offer on a draft, replacing whatever was there.
   *
   * PUT and not PATCH, and delete-then-insert and not a merge, because the thing being set
   * is a *list*: "these values, in this order, with this default". A merge would need a
   * second vocabulary for removing a value from the list, and the two would disagree about
   * what an empty list means. `product_version_option_values` cascades off the option row,
   * so the delete takes the value list with it.
   */
  async putDraftOption(
    tx: Tx,
    versionId: string,
    groupCode: string,
    option: DraftOptionWire,
  ): Promise<void> {
    const group = await this.requireGroup(tx, groupCode);

    if (group.kind !== option.kind) {
      throw AppError.validationFailed(
        `กลุ่ม "${groupCode}" เป็นชนิด ${group.kind} แต่คำขอส่งมาเป็น ${option.kind}`,
        { groupCode, expected: group.kind, received: option.kind },
      );
    }

    await tx
      .delete(productVersionOptions)
      .where(
        and(
          eq(productVersionOptions.productVersionId, versionId),
          eq(productVersionOptions.optionGroupId, group.id),
        ),
      );

    const [inserted] = await withTranslatedErrors(() =>
      tx
        .insert(productVersionOptions)
        .values({
          productVersionId: versionId,
          optionGroupId: group.id,
          groupKind: group.kind,
          sortOrder: option.sortOrder,
          defaultValueCode: option.kind === 'sku' ? option.defaultValueCode : null,
          minUm: option.kind === 'custom' ? decodeLengthUm(option.minUm) : null,
          maxUm: option.kind === 'custom' ? decodeLengthUm(option.maxUm) : null,
          stepUm: option.kind === 'custom' ? decodeLengthUm(option.stepUm) : null,
          defaultUm: option.kind === 'custom' ? decodeLengthUm(option.defaultUm) : null,
        })
        .returning({ id: productVersionOptions.id }),
    );

    if (!inserted) throw new Error('admin: inserting a draft option returned no row');
    if (option.kind !== 'sku') return;

    const valueIds = await this.resolveValueIds(tx, group.id, groupCode, option.valueCodes);

    await withTranslatedErrors(() =>
      tx.insert(productVersionOptionValues).values(
        option.valueCodes.map((code, index) => {
          const optionValueId = valueIds.get(code);
          if (optionValueId === undefined) {
            throw new Error(`admin: value "${code}" resolved and then did not`);
          }
          return {
            productVersionOptionId: inserted.id,
            optionGroupId: group.id,
            optionValueId,
            sortOrder: index,
          };
        }),
      ),
    );
  }

  async deleteDraftOption(tx: Tx, versionId: string, groupCode: string): Promise<boolean> {
    const group = await this.requireGroup(tx, groupCode);

    const removed = await tx
      .delete(productVersionOptions)
      .where(
        and(
          eq(productVersionOptions.productVersionId, versionId),
          eq(productVersionOptions.optionGroupId, group.id),
        ),
      )
      .returning({ id: productVersionOptions.id });

    return removed.length > 0;
  }

  /* ---------------------------------------------------------------- *
   * Draft rules
   * ---------------------------------------------------------------- */

  /**
   * Store a rule, and the group codes it reads beside it.
   *
   * `referenced_group_codes` is derived here and never accepted from the caller. Plan 5
   * makes it the handle the integrity check grips, and a caller-supplied list would be a
   * handle attached to the wrong thing: the check at publish time would compare an
   * assertion about the rule to the version's groups, rather than the rule itself. The
   * walk is `@wewin/db`'s, which counts `area` as reading both `width` and `height` — a
   * narrower walk would let "area over 8 m²" publish against a product with no width.
   */
  async putDraftRule(tx: Tx, versionId: string, ruleCode: string, rule: DraftRuleWire): Promise<void> {
    const when = decodeRuleExpr(rule.when);
    const compiled = toDocRule({
      id: ruleCode,
      messageTh: rule.messageTh,
      severity: rule.severity,
      when,
    });
    const referenced = referencedGroupCodes(when);

    if (referenced.length === 0) {
      // `product_version_rules_references_something` would refuse this row anyway; saying
      // so here names the rule instead of the constraint.
      throw AppError.validationFailed(
        `กฎ "${ruleCode}" ไม่ได้อ้างถึงกลุ่มตัวเลือกใดเลย จึงทำงานเหมือนกันทุกการตั้งค่า`,
        { ruleCode },
      );
    }

    const whenExpr: DocRuleExpr = compiled.when;

    await tx
      .delete(productVersionRules)
      .where(
        and(
          eq(productVersionRules.productVersionId, versionId),
          eq(productVersionRules.code, ruleCode),
        ),
      );

    await withTranslatedErrors(() =>
      tx.insert(productVersionRules).values({
        productVersionId: versionId,
        code: ruleCode,
        severity: rule.severity,
        messageTh: rule.messageTh,
        whenExpr,
        referencedGroupCodes: referenced,
        sortOrder: rule.sortOrder,
      }),
    );
  }

  async deleteDraftRule(tx: Tx, versionId: string, ruleCode: string): Promise<boolean> {
    const removed = await tx
      .delete(productVersionRules)
      .where(
        and(
          eq(productVersionRules.productVersionId, versionId),
          eq(productVersionRules.code, ruleCode),
        ),
      )
      .returning({ id: productVersionRules.id });

    return removed.length > 0;
  }

  /* ---------------------------------------------------------------- *
   * The shared option catalogue
   * ---------------------------------------------------------------- */

  async requireGroup(
    tx: Tx,
    groupCode: string,
  ): Promise<{ readonly id: string; readonly kind: 'sku' | 'custom' }> {
    const [row] = await tx
      .select({ id: optionGroups.id, kind: optionGroups.kind })
      .from(optionGroups)
      .where(eq(optionGroups.code, groupCode))
      .limit(1);

    if (!row) throw AppError.notFound(`ไม่พบกลุ่มตัวเลือกรหัส "${groupCode}"`, { groupCode });
    return row;
  }

  /**
   * Value codes to ids, refusing the whole list if any one of them is not in this group.
   *
   * The FK pair on `product_version_option_values` already makes "a value from another
   * group" unrepresentable, so this is not the check — it is the *message*. A 23503 names
   * a constraint; this names the codes an editor typed.
   */
  private async resolveValueIds(
    tx: Tx,
    groupId: string,
    groupCode: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(codes)];
    if (unique.length !== codes.length) {
      throw AppError.validationFailed(`กลุ่ม "${groupCode}" มีรหัสตัวเลือกซ้ำในรายการ`, { groupCode });
    }

    const rows = await tx
      .select({ id: optionValues.id, code: optionValues.code })
      .from(optionValues)
      .where(and(eq(optionValues.optionGroupId, groupId), inArray(optionValues.code, unique)));

    const found = new Map(rows.map((row) => [row.code, row.id]));
    const missing = unique.filter((code) => !found.has(code));
    if (missing.length > 0) {
      throw AppError.validationFailed(
        `กลุ่ม "${groupCode}" ไม่มีตัวเลือกรหัส ${missing.join(', ')}`,
        { groupCode, missing },
      );
    }

    return found;
  }

  async insertOptionGroup(tx: Tx, request: CreateOptionGroupRequestWire): Promise<void> {
    await withTranslatedErrors(() =>
      tx.insert(optionGroups).values({
        code: request.code,
        kind: request.kind,
        labelTh: request.labelTh,
        input: request.input,
        includeInSkuCode: request.includeInSkuCode,
        authoredUnit: request.authoredUnit ?? null,
        helperTh: request.helperTh ?? null,
      }),
    );
  }

  async updateOptionGroup(
    tx: Tx,
    groupCode: string,
    request: UpdateOptionGroupRequestWire,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (request.labelTh !== undefined) set['labelTh'] = request.labelTh;
    if (request.helperTh !== undefined) set['helperTh'] = request.helperTh;
    if (Object.keys(set).length === 0) return;

    set['updatedAt'] = sql`now()`;
    await withTranslatedErrors(() =>
      tx.update(optionGroups).set(set).where(eq(optionGroups.code, groupCode)),
    );
  }

  async insertOptionValue(
    tx: Tx,
    group: { readonly id: string; readonly kind: 'sku' | 'custom' },
    request: CreateOptionValueRequestWire,
  ): Promise<void> {
    const delta = decodeStoredPriceDelta(request.delta);

    await withTranslatedErrors(() =>
      tx.insert(optionValues).values({
        optionGroupId: group.id,
        groupKind: group.kind,
        code: request.code,
        labelTh: request.labelTh,
        swatchHex: request.swatchHex ?? null,
        deltaType: delta.type,
        deltaMinor: delta.minor,
        deltaBp: delta.bp,
        sortOrder: request.sortOrder,
      }),
    );
  }

  async updateOptionValue(
    tx: Tx,
    groupId: string,
    valueCode: string,
    request: UpdateOptionValueRequestWire,
  ): Promise<boolean> {
    const set: Record<string, unknown> = {};
    if (request.labelTh !== undefined) set['labelTh'] = request.labelTh;
    if (request.swatchHex !== undefined) set['swatchHex'] = request.swatchHex;
    if (request.sortOrder !== undefined) set['sortOrder'] = request.sortOrder;
    if (request.delta !== undefined) {
      const delta = decodeStoredPriceDelta(request.delta);
      // All three, always. Writing only the column the new type uses would leave the old
      // one populated, and `option_values_delta_shape` counts both.
      set['deltaType'] = delta.type;
      set['deltaMinor'] = delta.minor;
      set['deltaBp'] = delta.bp;
    }
    if (Object.keys(set).length === 0) return false;

    set['updatedAt'] = sql`now()`;
    const updated = await withTranslatedErrors(() =>
      tx
        .update(optionValues)
        .set(set)
        .where(and(eq(optionValues.optionGroupId, groupId), eq(optionValues.code, valueCode)))
        .returning({ id: optionValues.id }),
    );

    return updated.length > 0;
  }

  async setOptionValueAvailability(
    tx: Tx,
    groupId: string,
    valueCode: string,
    available: boolean,
  ): Promise<boolean> {
    const updated = await withTranslatedErrors(() =>
      tx
        .update(optionValues)
        .set({ available, updatedAt: sql`now()` })
        .where(and(eq(optionValues.optionGroupId, groupId), eq(optionValues.code, valueCode)))
        .returning({ id: optionValues.id }),
    );

    return updated.length > 0;
  }

  async listOptionGroups(tx: Tx): Promise<{
    readonly groups: readonly {
      readonly code: string;
      readonly kind: 'sku' | 'custom';
      readonly labelTh: string;
      readonly input: 'swatch' | 'chip' | 'toggle' | 'number';
      readonly includeInSkuCode: boolean;
      readonly authoredUnit: 'cm' | 'mm' | null;
      readonly helperTh: string | null;
    }[];
    readonly values: readonly {
      readonly groupCode: string;
      readonly code: string;
      readonly labelTh: string;
      readonly swatchHex: string | null;
      readonly deltaType: 'none' | 'flat' | 'per_sqm' | 'percent';
      readonly deltaMinor: bigint | null;
      readonly deltaBp: number | null;
      readonly available: boolean;
      readonly sortOrder: number;
    }[];
  }> {
    const groups = await tx
      .select({
        code: optionGroups.code,
        kind: optionGroups.kind,
        labelTh: optionGroups.labelTh,
        input: optionGroups.input,
        includeInSkuCode: optionGroups.includeInSkuCode,
        authoredUnit: optionGroups.authoredUnit,
        helperTh: optionGroups.helperTh,
      })
      .from(optionGroups)
      .orderBy(asc(optionGroups.code));

    const values = await tx
      .select({
        groupCode: optionGroups.code,
        code: optionValues.code,
        labelTh: optionValues.labelTh,
        swatchHex: optionValues.swatchHex,
        deltaType: optionValues.deltaType,
        deltaMinor: optionValues.deltaMinor,
        deltaBp: optionValues.deltaBp,
        available: optionValues.available,
        sortOrder: optionValues.sortOrder,
      })
      .from(optionValues)
      .innerJoin(optionGroups, eq(optionGroups.id, optionValues.optionGroupId))
      .orderBy(asc(optionGroups.code), asc(optionValues.sortOrder), asc(optionValues.code));

    return { groups, values };
  }

  /**
   * Every product row in full, ordered by id.
   *
   * All the columns and not just the four a list shows, because the list also reports
   * which product-level fields have moved away from the published document, and that
   * comparison needs both sides. `products.id` and not `created_at` for the order, for the
   * reason the read path gives: a re-seed rewrites the timestamps and would reshuffle
   * every list.
   */
  async listProducts(tx: Tx): Promise<readonly DraftProductRow[]> {
    return tx
      .select({
        id: products.id,
        slug: products.slug,
        skuPrefix: products.skuPrefix,
        categoryId: products.categoryId,
        nameTh: products.nameTh,
        summaryTh: products.summaryTh,
        heroImage: products.heroImage,
        leadTimeMinDays: products.leadTimeMinDays,
        leadTimeMaxDays: products.leadTimeMaxDays,
        pricePerSqmMinor: products.pricePerSqmMinor,
        minBillableSqUm: products.minBillableSqUm,
        elevation: products.elevation,
        videoUrl: products.videoUrl,
      })
      .from(products)
      .orderBy(asc(products.id));
  }

  /**
   * The live versions of many products in one query.
   *
   * Archived versions are excluded: they are the record an order line points at and there
   * is nothing a dashboard can do with them, so listing every one of them would grow the
   * response by one row per publish, forever.
   */
  async liveVersionsOf(
    tx: Tx,
    productIds: readonly string[],
  ): Promise<readonly (VersionRow & { readonly productId: string })[]> {
    if (productIds.length === 0) return [];

    return tx
      .select({
        productId: productVersions.productId,
        id: productVersions.id,
        version: productVersions.version,
        status: productVersions.status,
        documentHash: productVersions.documentHash,
        document: productVersions.document,
        updatedAt: productVersions.updatedAt,
        publishedAt: productVersions.publishedAt,
      })
      .from(productVersions)
      .where(
        and(
          inArray(productVersions.productId, [...productIds]),
          inArray(productVersions.status, ['draft', 'published']),
        ),
      );
  }
}
