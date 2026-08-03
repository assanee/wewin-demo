import { Inject, Injectable } from '@nestjs/common';
import type { Category, Product } from '@wewin/core';
import type { Database } from '@wewin/db';
// From @wewin/db and not from 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
// This app is CommonJS and would otherwise resolve a second, nominally different copy of
// drizzle's declarations from the one the schema was built with.
import { and, asc, eq, inArray, type SQL } from '@wewin/db/sql';
import { CATALOG_DOCUMENT_SCHEMA_VERSION, type CatalogDocumentV1 } from '@wewin/db/document';
import { fromDocument } from '@wewin/db/compile';
import { documentHash } from '@wewin/db/hash';
import { isPublished } from '@wewin/db/publish';
import {
  categories,
  optionGroups,
  optionValues,
  productVersionOptionValues,
  productVersionOptions,
  productVersions,
  products,
} from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Reading the catalogue out of Postgres.
 *
 * This is the whole read path, and it deliberately does not import
 * `@wewin/core/fixtures`. The TS table is still the *seed* in phase 3a, but if it were
 * also the thing served, every test comparing the two would be comparing one object to
 * itself — `tests/catalog-fidelity.pg.test.ts` exists to prove the round trip through the
 * database, and it can only prove it if this file has no other source to fall back on.
 *
 * Three facts about the shape it reads, all from plan section 5:
 *
 *   - the published version's frozen `document` is the product. Not the normalised rows:
 *     those are what the dashboard will edit, and a read that recomposed a product from
 *     them would be pricing from a shape nobody published.
 *   - `available` is the one field the document does not carry, because stock moves
 *     without a publish. It comes from `option_values` and is overlaid here.
 *   - the version id and the document hash travel with the product, so the configurator
 *     can send them back and be told 409 rather than quietly repriced (point 5).
 */

/** A product as published: the document, materialised, plus the handle it was served under. */
export interface PublishedProduct {
  readonly productVersionId: string;
  readonly documentHash: string;
  readonly product: Product;
}

/** `${groupCode}:${valueCode}` → whether it is sellable right now. */
type AvailabilityIndex = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

const availabilityKey = (groupCode: string, valueCode: string): string =>
  `${groupCode}:${valueCode}`;

@Injectable()
export class CatalogRepository {
  /**
   * `${versionId}:${hash}` pairs already shown to agree.
   *
   * The hash is served so that a configurator can send it back and be told 409 (plan 5
   * point 5). Serving it straight out of the column would make it a label rather than a
   * checksum: a document edited in place keeps its old hash, and the one comparison that
   * could have noticed is the one nobody makes. So it is recomputed — but recomputing
   * SHA-256 over 81 documents on every list request is real work to repeat for rows that
   * are, by `0001_catalog_freeze.sql`, immutable.
   *
   * Hence the memo, and hence the *pair* as its key: a republish that rewrites the
   * document also rewrites the hash, so the token changes and the new document is
   * verified. What this deliberately does not do is re-verify a version whose hash is
   * unchanged, so a row edited underneath a running process (which takes disabling the
   * freeze trigger) is caught at the next boot rather than the next request. That is the
   * cost of the memo, stated rather than hidden.
   */
  private readonly verified = new Set<string>();

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findAll(): Promise<PublishedProduct[]> {
    return this.load();
  }

  async findBySlug(slug: string): Promise<PublishedProduct | undefined> {
    const [found] = await this.load(eq(products.slug, slug));
    return found;
  }

  async findCategories(): Promise<Category[]> {
    const rows = await this.db
      .select({
        id: categories.id,
        labelTh: categories.labelTh,
        summaryTh: categories.summaryTh,
      })
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.id));

    return rows;
  }

  private async load(extra?: SQL): Promise<PublishedProduct[]> {
    const rows = await this.db
      .select({
        versionId: productVersions.id,
        documentHash: productVersions.documentHash,
        schemaVersion: productVersions.documentSchemaVersion,
        document: productVersions.document,
        productId: productVersions.productId,
      })
      .from(productVersions)
      // Joined rather than filtered on `product_versions.product_id`, because the slug is
      // a fact about the product and not about any one of its versions.
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(extra ? and(isPublished, extra) : isPublished)
      // A stable order the caller can rely on. `products.id` and not `created_at`: a
      // re-seed rewrites the timestamps and would silently reshuffle every list.
      .orderBy(asc(products.id));

    const stale = rows.filter((row) => row.schemaVersion !== CATALOG_DOCUMENT_SCHEMA_VERSION);
    if (stale.length > 0) {
      /*
       * Plan 4.5, applied at read time: a stored payload whose shape this build does not
       * know must not be interpreted anyway. `fromDocument` reads a V1 document, and a V2
       * that renamed a field would come back with parts of it silently missing rather
       * than as an error — which is the failure this column exists to make impossible.
       */
      throw new Error(
        `catalog: ${String(stale.length)} published version(s) carry document schema ` +
          `version ${stale.map((row) => String(row.schemaVersion)).join(', ')}; this build reads ` +
          `version ${String(CATALOG_DOCUMENT_SCHEMA_VERSION)} only`,
      );
    }

    const availability = await this.loadAvailability(rows.map((row) => row.versionId));

    return rows.map((row) => {
      this.verifyDocumentHash(row.versionId, row.documentHash, row.document);
      const forVersion = availability.get(row.versionId);
      return {
        productVersionId: row.versionId,
        documentHash: row.documentHash,
        product: fromDocument(row.document, (groupCode, valueCode) =>
          /*
           * Absent means not sellable, not "probably fine". A missing row here is a value
           * the version does not offer at all, and defaulting it to `true` would put an
           * option on the customer's screen that no row in the database backs.
           */
          forVersion?.get(availabilityKey(groupCode, valueCode)) ?? false,
        ),
      };
    });
  }

  private verifyDocumentHash(
    versionId: string,
    stored: string,
    document: CatalogDocumentV1,
  ): void {
    const token = `${versionId}:${stored}`;
    if (this.verified.has(token)) return;

    const actual = documentHash(document);
    if (actual !== stored) {
      /*
       * Refused, not logged and served anyway. A document that does not hash to the value
       * being handed out with it is either corrupt or edited behind the freeze trigger,
       * and both mean the price a customer is about to be quoted comes from a document
       * nobody published. `documentHash` canonicalises first, so this is not a key-order
       * artefact of jsonb — see packages/db/src/hash.ts.
       */
      throw new Error(
        `catalog: published version ${versionId} does not match its stored document hash ` +
          `(stored ${stored}, computed ${actual}); the document was changed after publish`,
      );
    }
    this.verified.add(token);
  }

  /**
   * Stock, for every value every one of these versions offers.
   *
   * One query for all of them rather than one per product: the list endpoint serves 81
   * products, and the per-product shape of this join is the classic N+1 that only shows
   * up once the catalogue is large enough to matter.
   */
  private async loadAvailability(versionIds: readonly string[]): Promise<AvailabilityIndex> {
    const index = new Map<string, Map<string, boolean>>();
    if (versionIds.length === 0) return index;

    const rows = await this.db
      .select({
        versionId: productVersionOptions.productVersionId,
        groupCode: optionGroups.code,
        valueCode: optionValues.code,
        available: optionValues.available,
      })
      .from(productVersionOptionValues)
      .innerJoin(
        productVersionOptions,
        eq(productVersionOptions.id, productVersionOptionValues.productVersionOptionId),
      )
      .innerJoin(optionGroups, eq(optionGroups.id, productVersionOptionValues.optionGroupId))
      .innerJoin(optionValues, eq(optionValues.id, productVersionOptionValues.optionValueId))
      .where(inArray(productVersionOptions.productVersionId, [...versionIds]));

    for (const row of rows) {
      let forVersion = index.get(row.versionId);
      if (!forVersion) {
        forVersion = new Map<string, boolean>();
        index.set(row.versionId, forVersion);
      }
      forVersion.set(availabilityKey(row.groupCode, row.valueCode), row.available);
    }

    return index;
  }
}
