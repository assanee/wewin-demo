import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ObjectStorage, StorageError, type StoredObject } from '../../media/storage/object-storage';
import type { SlipStorageConfig } from './slip-storage.config';
import { SLIP_STORAGE_CONFIG } from './slips.tokens';

/**
 * The private bucket, as three verbs — put, open, forget.
 *
 * It wraps `ObjectStorage` rather than reimplementing SigV4, and constructs its own
 * instance rather than injecting the media module's: the two are pointed at different
 * buckets, and a shared provider would be one `useValue` away from being pointed at the
 * same one. `MediaModule` exports nothing, which makes that impossible by construction and
 * is the reason the construction is by hand here instead.
 *
 * ── The key, and what it does and does not reveal ────────────────────────────────
 *
 *     slips/<orderId>/<sha256>.<ext>
 *
 * Content-addressed within the order, so an impatient customer pressing upload twice
 * converges on one object instead of two. The order id is in the path because a retention
 * sweep is per-order — plan 7.16 says the clock does not exist yet, and when it does, the
 * thing it will want to delete is "every image belonging to orders closed before N", which
 * is a prefix listing rather than a table scan.
 *
 * It is not a secret and is not treated as one. Nothing outside this process ever sees a
 * key: the wire carries a signed grant (`slip-grant.ts`) and never a path, so guessing one
 * buys nothing without the object store's own credentials.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────
 *
 * No `list`. The only thing that would want one is a sweep, and a sweep that enumerates a
 * bucket rather than the rows that reference it is a sweep that deletes an object whose row
 * still points at it. When retention lands, it reads `payment_slips` and clears
 * `storage_key` in the same transaction — see `SlipsRepository.eraseImage`.
 */
@Injectable()
export class SlipImageStore {
  private readonly logger = new Logger('SlipImageStore');
  private readonly storage: ObjectStorage;

  constructor(@Inject(SLIP_STORAGE_CONFIG) private readonly config: SlipStorageConfig) {
    this.storage = new ObjectStorage(this.config.storage);
  }

  /** Bytes only — the ceiling `readBoundedBody` enforces as the upload arrives. */
  get maxBytes(): number {
    return this.config.maxBytes;
  }

  keyFor(orderId: string, checksumSha256: string, extension: string): string {
    return `slips/${orderId}/${checksumSha256}.${extension}`;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await unavailable(() => this.storage.putObject(key, bytes, contentType));
  }

  async open(key: string): Promise<StoredObject> {
    return unavailable(() => this.storage.getObject(key));
  }

  /**
   * Remove the bytes. Called **after** the row has been cleared, never before.
   *
   * The same ordering `MediaService.delete` argues for, and the same reason: a crash
   * between the two leaves an object nobody can reach, which is a bucket to reconcile. The
   * reverse order leaves a row pointing at bytes that are gone, which is a review screen
   * that 503s on a slip somebody is trying to look at.
   *
   * A failure here is logged and swallowed for the same reason it is there: the reference
   * is already gone, and reporting a completed erasure as failed invites a retry that finds
   * nothing to erase.
   */
  async forget(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Slip image ${key} is unreferenced but was not removed from the bucket: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The stored type, read back from the key rather than from a column.
 *
 * `payment_slips` has no `content_type`, and adding one is a migration this module does not
 * own — so the extension carries it. That is sound rather than a shortcut, because the
 * extension did not come from the uploader: `normaliseImage()` dispatches on magic bytes
 * and *chooses* the extension, so the key is a record of what the bytes actually were.
 *
 * The fallback is `application/octet-stream` and never a guess. Paired with `nosniff` on
 * the serving route, an unrecognised extension downloads as bytes instead of being
 * interpreted as a document in an origin that holds sessions.
 */
export function contentTypeForKey(storageKey: string): string {
  if (storageKey.endsWith('.jpg')) return 'image/jpeg';
  if (storageKey.endsWith('.png')) return 'image/png';
  if (storageKey.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/** The extension a download is named with. Same source, same reasoning. */
export function extensionForKey(storageKey: string): string {
  const dot = storageKey.lastIndexOf('.');
  const extension = dot === -1 ? '' : storageKey.slice(dot + 1);
  return /^[a-z0-9]{1,5}$/.test(extension) ? extension : 'bin';
}

/**
 * The object store being unreachable is a 503 and says which side is down.
 *
 * Not a 500: nothing in this process is broken, and the distinction decides whether the
 * person reading the alert restarts the API or looks at the bucket. Copied in spirit from
 * `media.service.ts`; not shared, because that helper is private to a file whose vocabulary
 * is about product imagery.
 */
async function unavailable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StorageError) {
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'ที่เก็บไฟล์สลิปไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง', {
        storageStatus: error.status,
        ...(error.code === undefined ? {} : { storageCode: error.code }),
      });
    }
    throw error;
  }
}
