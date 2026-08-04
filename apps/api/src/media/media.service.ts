import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mediaPath } from '@wewin/db/schema';

import { AppError } from '../common/errors/app-error';
import { normaliseImage, ImageRejected } from './image';
import type { MediaConfig } from './media.config';
import { MEDIA_CONFIG } from './media.tokens';
import type {
  MediaListWire,
  MediaObjectWire,
  MediaUploadResultWire,
  MediaUsageWire,
} from './media.contract';
import { MediaRepository, type MediaRow } from './media.repository';
import { ObjectStorage, StorageError, type StoredObject } from './storage/object-storage';

/**
 * Upload, list, describe, delete.
 *
 * Two orderings in this file are load-bearing, and both are chosen so that the failure mode
 * is *bytes nobody references* rather than *a reference to bytes that are gone*. The first
 * is a wasted object in a bucket; the second is a published product page with a broken
 * image, and there is no undo for it.
 *
 *   **upload:** write the object, then insert the row. A crash in between leaves an
 *   unreferenced object — which the next upload of the same file silently reclaims, because
 *   the key is the content hash and the write is idempotent.
 *
 *   **delete:** delete the row, then delete the object. A crash in between leaves an
 *   unreferenced object again. The reverse order would, for the duration of one failed
 *   statement, leave a row and a document pointing at a key with nothing behind it.
 */

/** Uploads are attributed to a user; an image with no uploader is a row nobody can ask about. */
export interface Uploader {
  readonly userId: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger('MediaService');

  constructor(
    private readonly repository: MediaRepository,
    private readonly storage: ObjectStorage,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  /**
   * Store an image.
   *
   * `filename` is whatever the client put in the `X-Upload-Filename` header and is treated
   * as decoration throughout: it does not decide the type (the bytes do), it does not decide
   * the key (the hash does), and it is never echoed into a header (see media.controller.ts).
   */
  async upload(bytes: Buffer, filename: string | undefined, uploader: Uploader): Promise<MediaUploadResultWire> {
    const image = rejectionToAppError(() => normaliseImage(bytes));

    const checksum = createHash('sha256').update(image.bytes).digest('hex');

    /*
     * Deduplication before the write, and on the *stored* bytes rather than the received
     * ones. Two consequences worth being deliberate about: the same photograph uploaded
     * once straight off a phone and once after an editor stripped its EXIF converges on one
     * row, and re-uploading an image that is already referenced by a published version
     * returns that row instead of creating a second one somebody could later delete.
     */
    const existing = await this.repository.findByChecksum(checksum);
    if (existing !== undefined) {
      return { media: await this.describe(existing), deduplicated: true, stripped: image.stripped };
    }

    const storageKey = `media/${checksum.slice(0, 2)}/${checksum}.${image.extension}`;

    await storageFailureToAppError(() => this.storage.putObject(storageKey, image.bytes, image.contentType));

    const row = await this.repository.insert({
      storageKey,
      contentType: image.contentType,
      byteSize: BigInt(image.bytes.byteLength),
      width: image.width,
      height: image.height,
      checksumSha256: checksum,
      originalFilename: sanitiseFilename(filename),
      uploadedByUserId: uploader.userId,
    });

    if (image.stripped.length > 0) {
      // Logged as well as returned. Plan 9.4 is a promise about every file that goes
      // through here, and a promise nobody can audit after the fact is a slogan.
      this.logger.log(`Stored ${row.id} (${image.contentType}) after removing: ${image.stripped.join(', ')}`);
    }

    return { media: await this.describe(row), deduplicated: false, stripped: image.stripped };
  }

  async list(limit: number, cursor: Date | undefined): Promise<MediaListWire> {
    /*
     * One extra row is fetched to decide whether there is a next page, then dropped. The
     * alternative — a `count(*)` beside the page — is a second scan of the table to answer a
     * question the UI does not ask.
     */
    const rows = await this.repository.list(limit + 1, cursor);
    const page = rows.slice(0, limit);
    const usage = await this.repository.usageFor(page.map((row) => row.id));

    const last = page.at(-1);
    return {
      items: page.map((row) => toWire(row, usage.get(row.id))),
      nextCursor: rows.length > limit && last !== undefined ? last.createdAt.toISOString() : null,
    };
  }

  async get(id: string): Promise<MediaObjectWire> {
    return this.describe(await this.require(id));
  }

  async setAltText(id: string, altTextTh: string | null): Promise<MediaObjectWire> {
    /*
     * Empty string normalised to null. An empty `alt=""` is a meaningful, *deliberate*
     * signal in HTML — "this image is decorative, screen reader should skip it" — and it is
     * not what somebody who cleared a text box meant. Null is "nobody has written one".
     */
    const value = altTextTh === null || altTextTh.trim() === '' ? null : altTextTh.trim();
    const updated = await this.repository.updateAltText(id, value);
    if (updated === undefined) throw notFound(id);
    return this.describe(updated);
  }

  /**
   * Delete an image, unless a frozen document names it.
   *
   * The check here is not the enforcement — `media_objects_block_referenced_delete` in
   * 0005_media.sql is, and it holds for a `DELETE` typed into psql at midnight. This exists
   * so the refusal names the versions rather than arriving as a SQLSTATE, which is the
   * difference between "cannot delete" and "cannot delete: บานเกล็ดปรับได้ v3, published".
   */
  async delete(id: string): Promise<void> {
    const row = await this.require(id);
    const usage = (await this.repository.usageFor([id])).get(id);

    if (usage !== undefined && usage.frozen.length > 0) {
      throw AppError.conflict(
        'ลบรูปนี้ไม่ได้ เพราะเวอร์ชันที่เผยแพร่แล้วอ้างถึงอยู่ — ' +
          'เอกสารที่เผยแพร่แล้วต้องชี้ไปที่รูปเดิมเสมอ',
        // Rebuilt as literals rather than cast: `MediaReferenceWire` is an interface, and an
        // interface has no implicit index signature, so it is not a `JsonValue` however
        // obviously its fields are JSON. A cast here would be a cast on the only part of
        // this error a client reads.
        {
          referencedBy: usage.frozen.map((reference) => ({
            productId: reference.productId,
            productNameTh: reference.productNameTh,
            version: reference.version,
            status: reference.status,
          })),
        },
      );
    }

    const removed = await (async (): Promise<boolean> => {
      try {
        return await this.repository.delete(id);
      } catch (error) {
        throw translateDeleteError(error);
      }
    })();
    if (!removed) throw notFound(id);

    /*
     * After the row, and its failure is not the caller's problem: the reference is already
     * gone, so what is left is an object nobody can reach. Logged at warn so an operator
     * can reconcile the bucket later; thrown, it would report a completed delete as failed
     * and invite a retry that 404s.
     */
    try {
      await this.storage.deleteObject(row.storageKey);
    } catch (error) {
      this.logger.warn(
        `Row ${id} is deleted but its object ${row.storageKey} was not removed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The bytes, for the public serving route. */
  async open(id: string): Promise<{ row: MediaRow; object: StoredObject }> {
    const row = await this.require(id);
    const object = await storageFailureToAppError(() => this.storage.getObject(row.storageKey));
    return { row, object };
  }

  /** Bytes only — the ceiling the upload endpoint enforces, exposed for the controller. */
  get maxBytes(): number {
    return this.config.maxBytes;
  }

  private async require(id: string): Promise<MediaRow> {
    /*
     * Postgres raises `22P02` on a malformed uuid, which would surface as a 500. A shape
     * check first turns "not a uuid" into the same 404 as "no such image", which is also
     * the right answer: both mean the caller named something that does not exist.
     */
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound(id);

    const row = await this.repository.findById(id);
    if (row === undefined) throw notFound(id);
    return row;
  }

  private async describe(row: MediaRow): Promise<MediaObjectWire> {
    return toWire(row, (await this.repository.usageFor([row.id])).get(row.id));
  }
}

function toWire(row: MediaRow, usage: MediaUsageWire | undefined): MediaObjectWire {
  return {
    id: row.id,
    path: mediaPath(row.id),
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: row.width,
    height: row.height,
    checksumSha256: row.checksumSha256,
    originalFilename: row.originalFilename,
    altTextTh: row.altTextTh,
    createdAt: row.createdAt.toISOString(),
    usage: usage ?? { frozen: [], drafts: [] },
  };
}

function notFound(id: string): AppError {
  return AppError.notFound('ไม่พบรูปภาพนี้', { id });
}

/**
 * An image this API will not store is the caller's mistake, not a server fault.
 *
 * 415 rather than 400 or 422: the request was well-formed and the *media type* is the thing
 * that was wrong, which is exactly what 415 means and is a distinction a client can act on
 * — "convert the file" rather than "fix the form".
 */
function rejectionToAppError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ImageRejected) {
      throw new AppError('BAD_REQUEST', 415, error.messageTh, { reason: error.reason });
    }
    throw error;
  }
}

/**
 * The object store being unreachable is a 503, and the message says which side is down.
 *
 * Not a 500: nothing in this process is broken, and the difference decides whether the
 * person reading the alert restarts the API or looks at the bucket.
 */
async function storageFailureToAppError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StorageError) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        503,
        'ที่เก็บไฟล์รูปไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง',
        { storageStatus: error.status, ...(error.code === undefined ? {} : { storageCode: error.code }) },
      );
    }
    throw error;
  }
}

/** The trigger firing means the pre-check above missed a reference. It is still a 409, never a 500. */
function translateDeleteError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (code === '23001') {
      return AppError.conflict('ลบรูปนี้ไม่ได้ เพราะมีเวอร์ชันที่เผยแพร่แล้วอ้างถึงอยู่', {
        reason: 'referenced-by-frozen-version',
      });
    }
  }
  return error;
}

/**
 * A filename for a person to read, and nothing else.
 *
 * It never becomes a path (the key is the content hash), never becomes a content type (the
 * bytes decide) and never reaches a response header (see media.controller.ts). What is left
 * to defend against is display: a name containing control characters, a right-to-left
 * override that renders `gpj.exe` as `exe.jpg`, or five kilobytes of text that breaks a
 * table layout. Thai characters are kept — this is a Thai-language tool and a customer's
 * file is very often named in Thai.
 */
function sanitiseFilename(filename: string | undefined): string | null {
  if (filename === undefined) return null;

  const cleaned = filename
    // C0/C1 controls, zero-width characters, and the bidirectional overrides that render
    // `gpj.exe` as `exe.jpg` in a file list.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 200);

  return cleaned === '' ? null : cleaned;
}
