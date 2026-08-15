import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import type { CatalogDocumentV1 } from '@wewin/db/document';
import { CATALOG_DOCUMENT_SCHEMA_VERSION } from '@wewin/db/document';
import { canonicalJson, documentHash } from '@wewin/db/hash';
import { PublishError, publishProductVersion, type PublishResult } from '@wewin/db/publish';
import { decodeElevation, encodeProduct } from '@wewin/contract/catalog';
import { fromDocument } from '@wewin/db/compile';
import {
  decodeMinBillableSqUm,
  decodePricePerSqmMinor,
  type AdminProductListWire,
  type AdminProductSummaryWire,
  type AdminProductWire,
  type CreateProductRequestWire,
  type DraftSummaryWire,
  type DraftWire,
  type PublishDraftRequestWire,
  type PublishResultWire,
  type PublishedVersionWire,
  type PutDraftOptionRequestWire,
  type PutDraftRuleRequestWire,
  type UpdateProductDraftRequestWire,
} from '@wewin/contract/admin';

import { AppError } from '../common/errors/app-error';
import { code, message } from '../i18n';
import { DRIZZLE } from '../database/database.tokens';
import { availabilityOf, type CompiledDraft, type DraftProductRow } from './draft-document';
import { DraftRepository, type Tx, type VersionRow } from './draft.repository';

/**
 * What "editing a product" means when published documents are frozen.
 *
 * The whole of the write side is three sentences, and they are the reason this file is
 * worth reading before any of the others:
 *
 *   1. **The draft is the editable thing.** Every mutation is addressed to a draft, and a
 *      draft is a `product_versions` row with `status = 'draft'` plus the normalised rows
 *      hanging off it. There is no endpoint that edits a published version, because the
 *      freeze trigger would refuse the statement and because such an endpoint would be
 *      offering to change what a customer was quoted.
 *
 *   2. **Publishing compiles and freezes.** The draft's rows are compiled into a document
 *      on every edit (`DraftRepository.recompile`), so by the time somebody presses
 *      Publish the document already exists, already hashes to what the dashboard was
 *      shown, and has already been proven to parse as a core `Product`. Publishing is then
 *      only the ordering problem `packages/db` already solved.
 *
 *   3. **At most one published version, at most one draft, and never zero of both.** The
 *      first is a partial unique index; the second and third are enforced here, under the
 *      product lock, and are the reason `openDraft` and `discardDraft` are the shape they
 *      are.
 *
 * ### The two states a caller must not be able to reach
 *
 * **Two published versions.** `product_versions_one_published_per_product` makes it
 * impossible to commit, and `publishProductVersion` makes it impossible to *attempt* — it
 * archives before it publishes, under `SELECT ... FOR UPDATE` on the product row, because
 * a partial unique index is evaluated per statement and cannot be deferred. That sequence
 * is not restated here. It is called.
 *
 * **No published version at all.** There is no unpublish. A published version leaves that
 * state only by being archived *by the publish of its successor*, in the same transaction,
 * so the gap never exists — and the freeze trigger refuses `published → draft` outright.
 * The one way to reach "nothing published" would be to discard the first draft of a
 * product that has never published, which `discardDraft` refuses for exactly that reason:
 * it would leave a product row that no catalogue can be built from and no endpoint can
 * repair, because opening a draft copies the published version and there would be none.
 */

/** A draft holding no options yet, so a version row can exist before its children do. */
function seedDocument(product: DraftProductRow): CatalogDocumentV1 {
  return {
    schemaVersion: CATALOG_DOCUMENT_SCHEMA_VERSION,
    id: product.id,
    slug: product.slug,
    nameTh: product.nameTh,
    categoryId: product.categoryId,
    summaryTh: product.summaryTh,
    elevation: product.elevation,
    heroImage: product.heroImage,
    leadTimeDays: [product.leadTimeMinDays, product.leadTimeMaxDays],
    currency: 'THB',
    pricePerSqmMinor: product.pricePerSqmMinor.toString(),
    minBillableSqUm: product.minBillableSqUm.toString(),
    groups: [],
    rules: [],
    skuPrefix: product.skuPrefix,
  };
}

/**
 * Which product-level fields the `products` row and the published document disagree about.
 *
 * `products` is not versioned — there is one row per product and the published document
 * holds a frozen copy of the parts it needs. So editing a price is stored immediately and
 * changes nothing about what is quoted, which is correct and completely invisible. This is
 * the API saying it out loud.
 *
 * `slug` is in the list and is the one that is not merely cosmetic: the read path finds a
 * product by `products.slug` and then serves the frozen document, whose own `slug` field is
 * the old one. Until the draft is published those two disagree, and a dashboard that knows
 * can say so.
 */
export function unpublishedFieldsOf(
  product: DraftProductRow,
  published: CatalogDocumentV1 | null,
): readonly string[] {
  if (!published) return [];

  const differences: string[] = [];
  const differs = (field: string, condition: boolean): void => {
    if (condition) differences.push(field);
  };

  differs('slug', product.slug !== published.slug);
  differs('skuPrefix', product.skuPrefix !== published.skuPrefix);
  differs('nameTh', product.nameTh !== published.nameTh);
  differs('categoryId', product.categoryId !== published.categoryId);
  differs('summaryTh', product.summaryTh !== published.summaryTh);
  differs('heroImage', product.heroImage !== published.heroImage);
  differs(
    'leadTimeDays',
    product.leadTimeMinDays !== published.leadTimeDays[0] ||
      product.leadTimeMaxDays !== published.leadTimeDays[1],
  );
  differs('pricePerSqm', product.pricePerSqmMinor.toString() !== published.pricePerSqmMinor);
  differs('minBillableSqUm', product.minBillableSqUm.toString() !== published.minBillableSqUm);
  // Compared through the canonical serialisation the document hash uses, so key order in
  // the jsonb — which does not preserve it — cannot make an unchanged elevation look edited.
  differs('elevation', canonicalJson(product.elevation) !== canonicalJson(published.elevation));

  return differences;
}

@Injectable()
export class CatalogAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly drafts: DraftRepository,
  ) {}

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  async listProducts(): Promise<AdminProductListWire> {
    return this.db.transaction(async (tx) => {
      const rows = await this.drafts.listProducts(tx);
      const versions = await this.drafts.liveVersionsOf(
        tx,
        rows.map((row) => row.id),
      );

      const byProduct = new Map<string, { draft?: VersionRow; published?: VersionRow }>();
      for (const version of versions) {
        const entry = byProduct.get(version.productId) ?? {};
        if (version.status === 'draft') entry.draft = version;
        if (version.status === 'published') entry.published = version;
        byProduct.set(version.productId, entry);
      }

      const products: AdminProductSummaryWire[] = rows.map((row) => {
        const entry = byProduct.get(row.id) ?? {};
        return {
          id: row.id,
          slug: row.slug,
          skuPrefix: row.skuPrefix,
          categoryId: row.categoryId,
          nameTh: row.nameTh,
          published: entry.published ? publishedVersionOf(entry.published) : null,
          draft: entry.draft ? draftSummaryOf(entry.draft) : null,
          unpublishedFields: unpublishedFieldsOf(row, entry.published?.document ?? null),
        };
      });

      return { products };
    });
  }

  async getProduct(productId: string): Promise<AdminProductWire> {
    return this.db.transaction(async (tx) => {
      const row = await this.drafts.findProductRow(tx, productId);
      if (!row) throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });

      const published = await this.drafts.findVersion(tx, productId, 'published');
      const draft = await this.drafts.findVersion(tx, productId, 'draft');

      return {
        id: row.id,
        slug: row.slug,
        skuPrefix: row.skuPrefix,
        categoryId: row.categoryId,
        nameTh: row.nameTh,
        published: published ? publishedVersionOf(published) : null,
        draft: draft ? await this.draftView(tx, productId, draft) : null,
        unpublishedFields: unpublishedFieldsOf(row, published?.document ?? null),
      };
    });
  }

  async getDraft(productId: string): Promise<DraftWire> {
    return this.db.transaction(async (tx) => {
      const draft = await this.requireDraft(tx, productId);
      return this.draftView(tx, productId, draft);
    });
  }

  /* ---------------------------------------------------------------- *
   * Create
   * ---------------------------------------------------------------- */

  /**
   * A product and its first draft, in one transaction.
   *
   * There is no useful state between "does not exist" and "has enough rows to compile": a
   * `product_versions.document` is `NOT NULL`, and core's schema refuses a product with no
   * `width` and no `height`. So the request carries the options, and the alternative — a
   * product that exists but cannot be compiled — is never representable.
   */
  async createProduct(request: CreateProductRequestWire): Promise<DraftWire> {
    return this.db.transaction(async (tx) => {
      if (await this.drafts.productExists(tx, request.id)) {
        throw AppError.conflict(`มีสินค้ารหัส "${request.id}" อยู่แล้ว`, { productId: request.id });
      }

      await this.drafts.insertProduct(
        tx,
        { id: request.id, slug: request.slug, skuPrefix: request.skuPrefix },
        request.fields,
      );

      const seed = seedDocument({
        id: request.id,
        slug: request.slug,
        skuPrefix: request.skuPrefix,
        categoryId: request.fields.categoryId,
        nameTh: request.fields.nameTh,
        summaryTh: request.fields.summaryTh,
        heroImage: request.fields.heroImage,
        leadTimeMinDays: request.fields.leadTimeDays[0],
        leadTimeMaxDays: request.fields.leadTimeDays[1],
        pricePerSqmMinor: decodePricePerSqmMinor(request.fields.pricePerSqm),
        minBillableSqUm: decodeMinBillableSqUm(request.fields.minBillableSqUm),
        elevation: decodeElevation(request.fields.elevation),
        /*
         * ⭐ 0052. Never set at creation: `createProductRequestSchema` carries no gallery, and
         * this seed is overwritten by `recompile` at the end of the same transaction anyway.
         * Spelled `null` rather than left off so the row shape is the one every other reader
         * of `DraftProductRow` sees.
         */
        videoUrl: null,
      });

      const versionId = await this.drafts.insertDraftVersion(tx, request.id, 1, {
        document: seed,
        documentHash: documentHash(seed),
      });

      for (const [groupCode, option] of Object.entries(request.options)) {
        await this.drafts.putDraftOption(tx, versionId, groupCode, option);
      }
      for (const [ruleCode, rule] of Object.entries(request.rules ?? {})) {
        await this.drafts.putDraftRule(tx, versionId, ruleCode, rule);
      }

      // Throws 422 and rolls the whole thing back if what was written does not compile —
      // which is what keeps "a product that exists but cannot be published" out of reach.
      const compiled = await this.drafts.recompile(tx, request.id, versionId);
      return this.viewOf(versionId, 1, compiled, new Date());
    });
  }

  /* ---------------------------------------------------------------- *
   * Opening and discarding a draft
   * ---------------------------------------------------------------- */

  /**
   * Start the next version, as a copy of the published one.
   *
   * This is the operation the whole two-layer design exists for. The published version's
   * rows are frozen — the children triggers refuse INSERT, UPDATE and DELETE against a
   * non-draft parent — so the next version is a *copy*, and the copy is what makes an old
   * order still readable against the document it was quoted from.
   *
   * The copy picks up any product-level edits made since the publish, because `recompile`
   * reads the (unversioned) `products` row. That is the point of reporting
   * `unpublishedFields`: those edits were already saved and have been waiting for a draft
   * to carry them.
   */
  async openDraft(productId: string): Promise<DraftWire> {
    return this.db.transaction(async (tx) => {
      if (!(await this.drafts.lockProduct(tx, productId))) {
        throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
      }

      const existing = await this.drafts.findVersion(tx, productId, 'draft');
      if (existing) {
        /*
         * One draft per product, enforced here under the lock. There is no partial unique
         * index for it in `packages/db` — see the note in README/report — so this check is
         * the only thing standing between two editors and two parallel drafts, which is
         * why it is inside the same lock the publish takes rather than a pre-flight query.
         */
        throw AppError.conflict(`สินค้านี้มีร่างที่แก้ไขอยู่แล้ว (เวอร์ชัน ${String(existing.version)})`, {
          productVersionId: existing.id,
          version: existing.version,
        });
      }

      const published = await this.drafts.findVersion(tx, productId, 'published');
      if (!published) {
        throw AppError.conflict(
          'สินค้านี้ยังไม่มีเวอร์ชันที่เผยแพร่ จึงไม่มีอะไรให้คัดลอกเป็นร่างใหม่',
          { productId },
        );
      }

      const version = await this.drafts.nextVersionNumber(tx, productId);
      const versionId = await this.drafts.insertDraftVersion(tx, productId, version, {
        document: published.document,
        documentHash: published.documentHash,
      });

      await this.drafts.copyVersionChildren(tx, published.id, versionId);

      const compiled = await this.drafts.recompile(tx, productId, versionId);
      return this.viewOf(versionId, version, compiled, new Date());
    });
  }

  /**
   * Throw the draft away, leaving the published version untouched.
   *
   * Refused when there is nothing published, and that refusal is load-bearing rather than
   * conservative: the only way back from "a product with no versions" would be to open a
   * draft, and `openDraft` copies the published version. Allowing this would create a
   * product row that no endpoint in this module can ever make sellable again.
   */
  async discardDraft(productId: string, expectedDocumentHash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await this.drafts.lockProduct(tx, productId))) {
        throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
      }

      const draft = await this.requireDraft(tx, productId);
      this.assertFresh(draft, expectedDocumentHash);

      const published = await this.drafts.findVersion(tx, productId, 'published');
      if (!published) {
        throw AppError.conflict(
          'ทิ้งร่างนี้ไม่ได้ เพราะสินค้ายังไม่เคยเผยแพร่ — สินค้าจะเหลือสถานะที่แก้ไขต่อไม่ได้',
          { productId },
        );
      }

      await this.drafts.deleteDraftVersion(tx, draft.id);
    });
  }

  /* ---------------------------------------------------------------- *
   * Editing a draft
   * ---------------------------------------------------------------- */

  async updateDraft(productId: string, request: UpdateProductDraftRequestWire): Promise<DraftWire> {
    return this.mutate(productId, request.expectedDocumentHash, async (tx, draft) => {
      const changed = await this.drafts.updateProductFields(tx, productId, {
        ...(request.slug === undefined ? {} : { slug: request.slug }),
        ...(request.skuPrefix === undefined ? {} : { skuPrefix: request.skuPrefix }),
        ...(request.fields === undefined ? {} : { fields: request.fields }),
      });

      if (!changed) {
        throw AppError.badRequest('คำขอนี้ไม่ได้ระบุค่าที่จะแก้ไข', { productVersionId: draft.id });
      }
    });
  }

  async putOption(
    productId: string,
    groupCode: string,
    request: PutDraftOptionRequestWire,
  ): Promise<DraftWire> {
    return this.mutate(productId, request.expectedDocumentHash, async (tx, draft) => {
      await this.drafts.putDraftOption(tx, draft.id, groupCode, request.option);
    });
  }

  async deleteOption(
    productId: string,
    groupCode: string,
    expectedDocumentHash: string,
  ): Promise<DraftWire> {
    return this.mutate(productId, expectedDocumentHash, async (tx, draft) => {
      const removed = await this.drafts.deleteDraftOption(tx, draft.id, groupCode);
      if (!removed) {
        throw AppError.notFound(`ร่างนี้ไม่ได้เสนอกลุ่มตัวเลือก "${groupCode}"`, { groupCode });
      }
    });
  }

  async putRule(
    productId: string,
    ruleCode: string,
    request: PutDraftRuleRequestWire,
  ): Promise<DraftWire> {
    return this.mutate(productId, request.expectedDocumentHash, async (tx, draft) => {
      await this.drafts.putDraftRule(tx, draft.id, ruleCode, request.rule);
    });
  }

  async deleteRule(
    productId: string,
    ruleCode: string,
    expectedDocumentHash: string,
  ): Promise<DraftWire> {
    return this.mutate(productId, expectedDocumentHash, async (tx, draft) => {
      const removed = await this.drafts.deleteDraftRule(tx, draft.id, ruleCode);
      if (!removed) {
        throw AppError.notFound(`ร่างนี้ไม่มีกฎรหัส "${ruleCode}"`, { ruleCode });
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Publish
   * ---------------------------------------------------------------- */

  /**
   * Freeze the draft as the product's published version.
   *
   * Two steps, and the split between them is the one thing in this file that is a
   * compromise rather than a design:
   *
   *   1. Under `SELECT ... FOR UPDATE` on the product row, check that the draft is the one
   *      the caller means (`productVersionId`) and is still what they reviewed
   *      (`expectedDocumentHash`), and that its stored document really is the compile of
   *      its own rows.
   *   2. Call `publishProductVersion`, which takes the same lock in its own transaction and
   *      does the archive-then-publish sequence that `packages/db` owns.
   *
   * They cannot be one transaction: `publishProductVersion` takes a `Database` and opens
   * its own, and a drizzle transaction handle is not assignable to `Database` (it has no
   * `$client`). Reimplementing the sequence to inline it is exactly what this round was
   * told not to do, and it is the sequence most worth not having two of.
   *
   * **What that costs, precisely.** Between step 1 committing and step 2 taking the lock, a
   * colleague can commit an edit to the same draft. The publish then freezes *their*
   * version rather than the one this caller reviewed. It is never an invalid document —
   * every mutation recompiles and validates inside its own transaction, so whatever is
   * frozen still parses as a `Product` and still matches its own rows — but it may not be
   * the document the person pressing the button looked at. The response therefore carries
   * the hash that was actually frozen, so a caller that cares can compare. Closing the
   * window properly means `publishProductVersion` growing an optional expected hash, which
   * is a change to `packages/db` and not to this module.
   */
  async publish(productId: string, request: PublishDraftRequestWire): Promise<PublishResultWire> {
    const draft = await this.db.transaction(async (tx) => {
      if (!(await this.drafts.lockProduct(tx, productId))) {
        throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
      }

      const found = await this.requireDraft(tx, productId);

      if (found.id !== request.productVersionId) {
        throw AppError.conflict(
          'ร่างที่ระบุไม่ใช่ร่างปัจจุบันของสินค้านี้ — โหลดร่างใหม่แล้วลองอีกครั้ง',
          { expected: request.productVersionId, current: found.id },
        );
      }

      this.assertFresh(found, request.expectedDocumentHash);

      /*
       * Recompile before publishing, and refuse if it disagrees with what is stored.
       *
       * Belt to the invariant's braces. Every mutation recompiles, so this should always
       * agree — and if it ever does not, something wrote to the normalised rows without
       * going through this module, and the document about to be frozen for the lifetime of
       * every order that references it would not be the product those rows describe.
       * Cheap here, permanent there.
       */
      const compiled = await this.drafts.recompile(tx, productId, found.id);
      if (compiled.documentHash !== found.documentHash) {
        throw AppError.conflict(
          'ร่างนี้ถูกแก้ไขนอกเส้นทางปกติ — เอกสารที่เก็บไว้ไม่ตรงกับข้อมูลจริง จึงเผยแพร่ไม่ได้',
          { productVersionId: found.id, stored: found.documentHash, compiled: compiled.documentHash },
        );
      }

      return { id: found.id, version: found.version, documentHash: compiled.documentHash };
    });

    const result = await this.runPublish(draft.id);

    /*
     * Read back rather than echoing what was sent. If the window above closed on somebody
     * else's edit, this is where the caller finds out — the hash here is the one that was
     * actually frozen, whoever wrote it.
     *
     * By id, not by status. The two differ only when a *later* publish has already
     * superseded this one, and in that case reporting the newer row's version and hash
     * beside this call's `productVersionId` and `archivedVersionId` would be one response
     * describing two versions. `PublishResultWire` says what this publish did, so every
     * field on it comes from the version this publish froze.
     */
    const frozen = await this.db.transaction((tx) =>
      this.drafts.findVersionById(tx, result.publishedVersionId),
    );
    if (!frozen) {
      throw new Error(
        `admin: version ${result.publishedVersionId} vanished immediately after publishing it`,
      );
    }

    return {
      productVersionId: result.publishedVersionId,
      version: frozen.version,
      documentHash: frozen.documentHash,
      publishedAt: result.publishedAt.toISOString(),
      archivedVersionId: result.archivedVersionId,
    };
  }

  /**
   * `packages/db`'s publish, with its errors turned into HTTP answers.
   *
   * A method rather than a `try` around the call site so the result keeps a name — the
   * inline version needed a `let` with no annotation, which is the one shape in this file
   * that would have been an implicit `any` if control flow had not narrowed it.
   */
  private async runPublish(versionId: string): Promise<PublishResult> {
    try {
      return await publishProductVersion(this.db, versionId);
    } catch (error) {
      if (error instanceof PublishError) throw publishErrorToAppError(error);
      throw error;
    }
  }

  /* ---------------------------------------------------------------- *
   * Shared plumbing
   * ---------------------------------------------------------------- */

  /**
   * The shape every draft mutation has: lock, find, check freshness, apply, recompile.
   *
   * Written once because the order is the correctness. Applying before checking freshness
   * would mean a rejected request had already written; recompiling outside the transaction
   * would leave a draft whose document and rows disagree if the process died in between.
   */
  private async mutate(
    productId: string,
    expectedDocumentHash: string,
    apply: (tx: Tx, draft: VersionRow) => Promise<void>,
  ): Promise<DraftWire> {
    return this.db.transaction(async (tx) => {
      if (!(await this.drafts.lockProduct(tx, productId))) {
        throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
      }

      const draft = await this.requireDraft(tx, productId);
      this.assertFresh(draft, expectedDocumentHash);

      await apply(tx, draft);

      const compiled = await this.drafts.recompile(tx, productId, draft.id);
      return this.viewOf(draft.id, draft.version, compiled, new Date());
    });
  }

  private async requireDraft(tx: Tx, productId: string): Promise<VersionRow> {
    const draft = await this.drafts.findVersion(tx, productId, 'draft');
    if (draft) return draft;

    if (!(await this.drafts.productExists(tx, productId))) {
      throw AppError.notFound(message('error.catalog.product_not_found', { productId: code(productId) }), {
        productId,
      });
    }

    /*
     * 409 and not 404: the product exists and the draft is a thing the caller can create.
     * `POST .../draft` is named in the message because "not found" on a resource whose
     * absence is the normal state after a publish is the least useful answer available.
     */
    throw AppError.conflict('สินค้านี้ยังไม่มีร่างที่แก้ไขได้ — เปิดร่างใหม่ก่อน', { productId });
  }

  /**
   * Plan 5 point 5, one layer in.
   *
   * The storefront sends back the hash of the document it was priced from and is answered
   * 409 when a publish moved underneath it. A dashboard has the same problem with a
   * colleague rather than with a publish, and the same answer: the mutation is refused with
   * both hashes named, and the client reloads the draft rather than overwriting an edit it
   * never saw.
   */
  private assertFresh(draft: VersionRow, expected: string): void {
    if (draft.documentHash === expected) return;

    throw AppError.conflict(
      'ร่างนี้ถูกแก้ไขโดยผู้ใช้อื่นหลังจากที่คุณโหลด — โหลดใหม่แล้วลองอีกครั้ง',
      { productVersionId: draft.id, expected, current: draft.documentHash },
    );
  }

  /** The stored document of an existing draft, rendered without recompiling it. */
  private async draftView(tx: Tx, productId: string, draft: VersionRow): Promise<DraftWire> {
    const rows = await this.drafts.loadRows(tx, productId, draft.id);
    return {
      productVersionId: draft.id,
      version: draft.version,
      documentHash: draft.documentHash,
      updatedAt: draft.updatedAt.toISOString(),
      /*
       * From the *stored* document, with current stock overlaid — the same two steps the
       * public read path takes. Rendering the rows instead would give the dashboard a
       * preview that agrees with the edit form and can disagree with what publishing would
       * freeze; this one cannot, because it is the thing that would be frozen.
       */
      product: encodeProduct(fromDocument(draft.document, availabilityOf(rows))),
    };
  }

  private viewOf(
    versionId: string,
    version: number,
    compiled: CompiledDraft,
    updatedAt: Date,
  ): DraftWire {
    return {
      productVersionId: versionId,
      version,
      documentHash: compiled.documentHash,
      updatedAt: updatedAt.toISOString(),
      product: encodeProduct(compiled.product),
    };
  }
}

const publishedVersionOf = (version: VersionRow): PublishedVersionWire => ({
  productVersionId: version.id,
  version: version.version,
  documentHash: version.documentHash,
  // `published_at` is `NOT NULL` for a published row by CHECK; the fallback exists so a
  // row that somehow lacks one is reported with its own timestamp rather than crashing a
  // list of 81 products.
  publishedAt: (version.publishedAt ?? version.updatedAt).toISOString(),
});

const draftSummaryOf = (version: VersionRow): DraftSummaryWire => ({
  productVersionId: version.id,
  version: version.version,
  documentHash: version.documentHash,
  updatedAt: version.updatedAt.toISOString(),
});

/**
 * `PublishError` is `packages/db`'s vocabulary; these are the HTTP answers for it.
 *
 * `unknown_referenced_group` should be unreachable from this module — every mutation
 * recompiles and `productSchema` refuses a rule naming a group the product does not offer,
 * so a draft in that state cannot be saved. It is mapped anyway, because "unreachable"
 * here means "unreachable through this module", and the row could have been written by the
 * seed or by hand.
 */
function publishErrorToAppError(error: PublishError): AppError {
  switch (error.code) {
    case 'version_not_found':
      return AppError.notFound('ไม่พบเวอร์ชันที่จะเผยแพร่', { reason: error.code });
    case 'not_a_draft':
      return AppError.conflict('เวอร์ชันนี้ไม่ใช่ร่างแล้ว — อาจมีผู้ใช้อื่นเผยแพร่ไปก่อน', {
        reason: error.code,
      });
    case 'unknown_referenced_group':
      return AppError.validationFailed(
        'มีกฎที่อ้างถึงกลุ่มตัวเลือกที่ร่างนี้ไม่ได้เสนอ',
        { reason: error.code, message: error.message },
      );
  }
}
