import { bigint, char, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth.js';

/**
 * Uploaded images, one row per distinct sequence of bytes.
 *
 * This table is a *ledger of stored objects*, not a join table. Nothing here says which
 * product an image belongs to, and that is deliberate: the catalogue already has a place
 * to say so — `products.hero_image` on the editable side, and the `heroImage` field inside
 * the frozen document on the published side — and a second place would be a second answer
 * to "what does this product show" that only one of the two layers can see.
 *
 * What a reference looks like is therefore the whole contract between this table and the
 * catalogue, and it is exactly one string:
 *
 *     /media/<media_objects.id>
 *
 * `mediaPath()` below is that string in TypeScript. `media_objects_block_referenced_delete`
 * in the migration is the same string in plpgsql, and the duplication is on purpose — the
 * guard has to hold for a row deleted by hand in psql, not only for one deleted through
 * apps/api. Both are named in the other's comment so a change to either is findable.
 *
 * ── The two rules the catalogue's freeze imposes on this table ───────────────────
 *
 * Plan section 5 froze the published document so an order can be re-read years later as
 * the customer saw it. An image is part of what the customer saw, so the same rule reaches
 * in here:
 *
 *   1. **A row referenced by a published or archived version cannot be deleted.** Enforced
 *      by a BEFORE DELETE trigger, not by application code, for the same reason the
 *      catalogue's own freeze is a trigger: a rule that only exists in a service is a rule
 *      that a migration script does not have.
 *   2. **A row's identity cannot be edited.** Deletion is not the only way to break a
 *      frozen document — repointing `storage_key` at different bytes leaves every published
 *      version showing an image nobody reviewed, and it would not even be an anomaly a
 *      referential check could see. So a BEFORE UPDATE trigger freezes every column except
 *      the two that describe the row rather than identify it (`alt_text_th`, `updated_at`).
 *
 * The consequence worth stating out loud: **there is no "replace this image" operation.**
 * Replacing means uploading new bytes and pointing the draft at them, which is a change a
 * publish has to carry. That is not a limitation to route around; it is the same rule that
 * says a price change needs a new version.
 */

/** The one string that ties a catalogue field to a row here. Mirrored in plpgsql by the delete guard. */
export function mediaPath(id: string): string {
  return `/media/${id}`;
}

/** What the upload endpoint accepts, and therefore what `content_type` may hold. */
export const MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Where the bytes are in the object store, content-addressed.
     *
     * `media/<first two hex of the digest>/<digest>.<ext>`. Derived from the checksum
     * rather than from the id, which buys two things: a re-upload of the same photo
     * overwrites itself byte-for-byte instead of accumulating copies, and a bucket listing
     * is a flat-ish tree rather than one directory with every object in it.
     *
     * Unique because two rows pointing at one key would make the delete of either a delete
     * of both — and the first one deleted would take the other's bytes with it while
     * leaving its row and its `/media/<id>` reference intact.
     */
    storageKey: text('storage_key').notNull().unique(),

    /**
     * What this is, as decided by reading the bytes.
     *
     * Never the upload's `Content-Type` header and never the filename's extension: both
     * are attacker-chosen, and the one the browser is later told is this column. The CHECK
     * is the list apps/api will serve with `X-Content-Type-Options: nosniff`, so a type
     * that could be interpreted as a document — `image/svg+xml` above all, which is XML
     * that can carry script — cannot be stored, let alone served.
     *
     * `{ enum }` as well as the CHECK, which is the same list said twice on purpose: the
     * enum is what makes a query's result type a union rather than `string`, so a caller
     * reading this column gets the narrow type without asserting one. The CHECK is what
     * holds for an INSERT that did not come through Drizzle.
     */
    contentType: text('content_type', { enum: MEDIA_CONTENT_TYPES }).notNull(),

    /** Of the stored bytes, i.e. after metadata stripping — the number `Content-Length` will carry. */
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),

    /* Decoded pixel dimensions, read out of the header while sniffing. Kept so the dashboard
     * can lay out a grid without fetching every image, and so a decompression bomb is a
     * number somebody can look at after the fact. */
    width: integer('width').notNull(),
    height: integer('height').notNull(),

    /**
     * SHA-256 of the stored bytes, lowercase hex.
     *
     * Three jobs: it is the storage key's stem, it is the `ETag` the serving route answers
     * with (which is what makes `Cache-Control: immutable` an honest claim), and it is the
     * uniqueness that makes uploading the same photo twice return the same row instead of a
     * second one. Of the stored bytes and not the received ones, so the same photo uploaded
     * once with EXIF and once without converges on one row.
     */
    checksumSha256: char('checksum_sha256', { length: 64 }).notNull().unique(),

    /**
     * What the file was called on the uploader's disk. Display only.
     *
     * Sanitised on the way in and never used to build a path, a content type or a header
     * value — the storage key comes from the checksum and the content type comes from the
     * bytes. It is here so a person recognises their own upload in a grid of thumbnails.
     */
    originalFilename: text('original_filename'),

    /**
     * Alt text, Thai.
     *
     * The one editable column, and the reason the freeze trigger is written per column
     * rather than as a blanket "this row is immutable": alt text is not part of what a
     * customer was quoted, it is an accessibility fact about the picture, and fixing a bad
     * one should not require republishing 60 products.
     */
    altTextTh: text('alt_text_th'),

    /**
     * Who uploaded it. `set null` rather than `restrict`: an account being closed must not
     * be blocked by, or take with it, a picture that a published version depends on.
     */
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onUpdate: 'cascade',
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'media_objects_content_type_supported',
      sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('media_objects_byte_size_positive', sql`${table.byteSize} > 0`),
    check(
      'media_objects_dimensions_positive',
      sql`${table.width} > 0 and ${table.height} > 0`,
    ),
    check('media_objects_checksum_hex', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    /* The newest first, which is the only order a media library is ever read in. */
    index('media_objects_created_at_idx').on(table.createdAt.desc()),
  ],
);
