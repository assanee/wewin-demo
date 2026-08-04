import { z } from 'zod';
import type { MediaContentType } from '@wewin/db/schema';

/**
 * What these endpoints send and accept.
 *
 * **This belongs in `packages/contract`, beside `admin.ts` and `catalog.ts`, and it is here
 * instead** — stated plainly because a reader will otherwise assume the omission was
 * thoughtless. That package is another agent's surface in this round and a type moved into
 * it mid-flight is a conflict in a file two apps compile against. The move is a rename and
 * an export line; the shapes below are already written to survive it, and the dashboard
 * currently restates them (apps/dashboard/src/components/media/types.ts) with the same debt
 * written down in the same words.
 *
 * ── Numbers on the wire ───────────────────────────────────────────────────────
 *
 * The repository's rule is that money and lengths cross the wire in a shape that cannot be
 * read as the other unit, because both are `bigint` and JSON has neither bigints nor units.
 * Nothing here is money or a length. `byteSize` is a count of bytes, capped by
 * `MEDIA_MAX_BYTES` at single-digit megabytes; `width` and `height` are pixels, capped at
 * 20,000. All three are plain JSON numbers, exactly representable, and there is no second
 * unit any of them could be mistaken for. `byte_size` is a `bigint` in Postgres only because
 * that is the honest column type for a file size, and it is narrowed here where it is known
 * to be small.
 */

/** A published or archived version that names this image, i.e. a reason it cannot be deleted. */
export interface MediaReferenceWire {
  readonly productId: string;
  readonly productNameTh: string;
  readonly version: number;
  readonly status: 'draft' | 'published' | 'archived';
}

export interface MediaUsageWire {
  /**
   * References from frozen versions. **Non-empty means the image cannot be deleted** — the
   * document those versions carry is what a customer was shown, and plan section 5's freeze
   * covers the picture as much as the price.
   */
  readonly frozen: readonly MediaReferenceWire[];
  /** References from drafts. These do not block deletion; they dangle, visibly, in the editor. */
  readonly drafts: readonly MediaReferenceWire[];
}

export interface MediaObjectWire {
  readonly id: string;
  /**
   * What to put in a catalogue field — `products.heroImage` today.
   *
   * A path and not an absolute URL, on purpose: an absolute URL would be frozen into a
   * published document, and the day the API moves to another hostname every document ever
   * published would point at a domain the company no longer owns. A client prefixes it with
   * whatever base it already knows the API by.
   */
  readonly path: string;
  readonly contentType: MediaContentType;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
  readonly originalFilename: string | null;
  readonly altTextTh: string | null;
  readonly createdAt: string;
  readonly usage: MediaUsageWire;
}

export interface MediaUploadResultWire {
  readonly media: MediaObjectWire;
  /**
   * True when these exact bytes were already stored and the existing row was returned.
   *
   * Surfaced rather than hidden because the two cases differ in a way an operator can see:
   * a "duplicate" upload returns a row whose alt text and filename belong to whoever
   * uploaded it first, and 200 rather than 201 is the only other clue.
   */
  readonly deduplicated: boolean;
  /**
   * Which metadata containers were removed — `Exif`, `XMP`, `tEXt`, `trailing bytes after
   * EOI`. Empty for a file that carried none.
   *
   * The dashboard shows this. "We strip EXIF" is a claim that is either true of the file
   * somebody just uploaded or not, and this is the only way they ever find out which.
   */
  readonly stripped: readonly string[];
}

export interface MediaListWire {
  readonly items: readonly MediaObjectWire[];
  /** Opaque; pass back as `?cursor=`. Null at the end of the list. */
  readonly nextCursor: string | null;
}

/** The one editable field. Everything else about a media object identifies bytes — see the schema. */
export const updateMediaRequestSchema = z.object({
  altTextTh: z.string().trim().max(300).nullable(),
});

export type UpdateMediaRequestWire = z.infer<typeof updateMediaRequestSchema>;

export const mediaListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime({ offset: true }).optional(),
});

export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;
