import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { mediaObjects, products, productVersions, type MediaContentType } from '@wewin/db/schema';
import { desc, eq, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
import type { MediaReferenceWire, MediaUsageWire } from './media.contract';

/**
 * The only thing in this app that reads or writes `media_objects`.
 *
 * The interesting query is `usageFor`, and it deserves its paragraph. Everything else is
 * a single-table read.
 */

export interface MediaRow {
  readonly id: string;
  readonly storageKey: string;
  readonly contentType: MediaContentType;
  readonly byteSize: bigint;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly originalFilename: string | null;
  readonly altTextTh: string | null;
  readonly createdAt: Date;
}

export interface NewMediaRow {
  readonly storageKey: string;
  readonly contentType: MediaContentType;
  readonly byteSize: bigint;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly originalFilename: string | null;
  readonly uploadedByUserId: string | null;
}

/**
 * Every `/media/<uuid>` in a document, found in one pass.
 *
 * A regex over the serialised document rather than `document->>'heroImage'`, for the same
 * two reasons the delete trigger in 0005_media.sql matches the same way, and it is worth
 * having them in both places:
 *
 *   * being wrong in this direction is safe. A false positive reports an image as in use
 *     and refuses a delete somebody can argue about; a false negative deletes bytes a
 *     frozen document names, and there is no argument available afterwards.
 *   * it keeps working when the document grows a second place to put a picture. That
 *     change will be made by somebody who has never read this file, and it should not also
 *     require them to find it.
 *
 * `[0-9a-f-]` and the exact uuid shape, not `[^"]+`: the point is to match a reference,
 * not any string that happens to start with `/media/`.
 */
const REFERENCE_PATTERN = '/media/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

@Injectable()
export class MediaRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insert(row: NewMediaRow): Promise<MediaRow> {
    const [inserted] = await this.db.insert(mediaObjects).values(row).returning(COLUMNS);
    if (inserted === undefined) throw new Error('insert into media_objects returned no row');
    return inserted;
  }

  async findById(id: string): Promise<MediaRow | undefined> {
    const [row] = await this.db.select(COLUMNS).from(mediaObjects).where(eq(mediaObjects.id, id)).limit(1);
    return row;
  }

  async findByChecksum(checksum: string): Promise<MediaRow | undefined> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(mediaObjects)
      .where(eq(mediaObjects.checksumSha256, checksum))
      .limit(1);
    return row;
  }

  /**
   * Newest first, keyset-paginated on `created_at`.
   *
   * A cursor rather than an offset because a media library is inserted into from the top:
   * with `OFFSET`, uploading while somebody pages pushes a row they have already seen onto
   * the next page and hides the one behind it. `created_at` is not unique in principle —
   * two uploads in the same microsecond would tie — which is a real if unlikely gap; the
   * fix is a `(created_at, id)` composite cursor, and it is not made here because the
   * index that would support it does not exist yet.
   */
  async list(limit: number, cursor: Date | undefined): Promise<readonly MediaRow[]> {
    /*
     * `sql` rather than `lt(...)`: `@wewin/db/sql` re-exports a deliberately short list of
     * operators and `lt` is not on it. Adding one is a change to a file this round does not
     * own, and the comparison is one line either way.
     */
    const where = cursor === undefined ? undefined : sql`${mediaObjects.createdAt} < ${cursor}`;
    return this.db
      .select(COLUMNS)
      .from(mediaObjects)
      .where(where)
      .orderBy(desc(mediaObjects.createdAt))
      .limit(limit);
  }

  async updateAltText(id: string, altTextTh: string | null): Promise<MediaRow | undefined> {
    const [row] = await this.db
      .update(mediaObjects)
      .set({ altTextTh, updatedAt: new Date() })
      .where(eq(mediaObjects.id, id))
      .returning(COLUMNS);
    return row;
  }

  /** Returns false when the row was already gone, so a retried delete is not an error. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(mediaObjects)
      .where(eq(mediaObjects.id, id))
      .returning({ id: mediaObjects.id });
    return deleted.length > 0;
  }

  /**
   * Which product versions name each of these images.
   *
   * One query for the whole page, not one per row: a media library shows fifty thumbnails
   * and each needs a "safe to delete?" answer, and fifty scans of `product_versions` to
   * render one grid is how a list endpoint becomes the slowest thing in the dashboard.
   */
  async usageFor(ids: readonly string[]): Promise<ReadonlyMap<string, MediaUsageWire>> {
    const usage = new Map<string, { frozen: MediaReferenceWire[]; drafts: MediaReferenceWire[] }>(
      ids.map((id) => [id, { frozen: [], drafts: [] }]),
    );
    if (ids.length === 0) return new Map();

    const result = await this.db.execute(sql`
      select distinct
        reference.captures[1] as media_id,
        ${productVersions.productId} as product_id,
        ${productVersions.version} as version,
        ${productVersions.status} as status,
        ${products.nameTh} as product_name_th
      from ${productVersions}
      join ${products} on ${products.id} = ${productVersions.productId}
      cross join lateral regexp_matches(${productVersions.document}::text, ${REFERENCE_PATTERN}, 'g')
        as reference(captures)
      where reference.captures[1] = any(${sql.param(ids)})
      order by product_id, version
    `);

    for (const row of rowsOf(result)) {
      const reference = referenceOf(row);
      if (reference === undefined) continue;
      const bucket = usage.get(reference.mediaId);
      if (bucket === undefined) continue;
      // 'draft' is the only status that does not freeze the document (see 0001_catalog_freeze.sql).
      (reference.wire.status === 'draft' ? bucket.drafts : bucket.frozen).push(reference.wire);
    }

    return new Map([...usage].map(([id, value]) => [id, { frozen: value.frozen, drafts: value.drafts }]));
  }
}

const COLUMNS = {
  id: mediaObjects.id,
  storageKey: mediaObjects.storageKey,
  contentType: mediaObjects.contentType,
  byteSize: mediaObjects.byteSize,
  width: mediaObjects.width,
  height: mediaObjects.height,
  checksumSha256: mediaObjects.checksumSha256,
  originalFilename: mediaObjects.originalFilename,
  altTextTh: mediaObjects.altTextTh,
  createdAt: mediaObjects.createdAt,
} as const;

/**
 * A raw `execute` hands back the driver's own result object, whose rows are `unknown` as far
 * as this file is concerned. They are narrowed rather than asserted, on the same rule the
 * rest of this app follows for anything it did not construct (`isRouteAccess`,
 * `isPermissionCode`): a column renamed in the query above should fail here, by name, and
 * not three layers up as an `undefined` in a response body.
 */
function rowsOf(result: unknown): readonly unknown[] {
  if (typeof result !== 'object' || result === null || !('rows' in result)) return [];
  const { rows } = result as { rows: unknown };
  return Array.isArray(rows) ? rows : [];
}

function referenceOf(row: unknown): { mediaId: string; wire: MediaReferenceWire } | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const candidate = row as Record<string, unknown>;

  const mediaId = candidate['media_id'];
  const productId = candidate['product_id'];
  const version = candidate['version'];
  const status = candidate['status'];
  const productNameTh = candidate['product_name_th'];

  if (
    typeof mediaId !== 'string' ||
    typeof productId !== 'string' ||
    typeof version !== 'number' ||
    typeof productNameTh !== 'string' ||
    (status !== 'draft' && status !== 'published' && status !== 'archived')
  ) {
    return undefined;
  }

  return { mediaId, wire: { productId, productNameTh, version, status } };
}
