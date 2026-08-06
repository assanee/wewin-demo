import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppError } from '../common/errors/app-error';
import { ObjectStorage, StorageError, type StoredObject } from '../media/storage/object-storage';
import type { ReviewPhotoConfig } from './review-photo.config';
import { REVIEW_PHOTO_CONFIG } from './reviews.tokens';

/**
 * The private bucket for customer photographs, as three verbs — put, open, forget.
 *
 * It wraps `ObjectStorage` rather than reimplementing SigV4, and constructs its own instance
 * rather than injecting the media module's, on `SlipImageStore`'s reasoning: the two are
 * pointed at different buckets and a shared provider would be one `useValue` away from being
 * pointed at the same one. `MediaModule` exports nothing, which makes that impossible by
 * construction and is why the construction is by hand here.
 *
 * ── The key, and the one way it differs from every other key in this system ──────
 *
 *     reviews/<reviewId>/<uuid>.<ext>
 *
 * **Not content-addressed, deliberately.** `media_objects` keys on the content hash so that
 * two uploads of the same bytes converge on one object, which is right for a catalogue of 81
 * product photographs and wrong here in a way plan 7.16 already flags: two customers who
 * photograph the same standard window in the same light could converge, and then erasing one
 * person's photograph would erase the other's. `review_photos` has **no unique index on
 * `checksum_sha256`** for exactly this reason, and a content-addressed key would put the
 * deduplication back in the storage layer where the schema cannot see it.
 *
 * So the key carries a fresh uuid, and identical bytes uploaded by two people are two
 * objects. That costs storage and buys the property `erase_user()` depends on: deleting one
 * row's object deletes one person's photograph.
 *
 * The review id is in the path because a retention sweep is per-review — plan 13's clock does
 * not exist yet, and when it does, what it will want is a prefix listing rather than a table
 * scan.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────
 *
 * No `list`. The only caller would be a sweep, and a sweep that enumerates a bucket rather
 * than the rows referencing it deletes an object whose row still points at it. When retention
 * lands it reads `review_photos` and clears `storage_key` in the same transaction — the
 * column is nullable and stamped precisely so that it can.
 */
@Injectable()
export class ReviewPhotoStore {
  private readonly logger = new Logger('ReviewPhotoStore');
  private readonly storage: ObjectStorage;

  constructor(@Inject(REVIEW_PHOTO_CONFIG) private readonly config: ReviewPhotoConfig) {
    this.storage = new ObjectStorage(this.config.storage);
  }

  get maxBytes(): number {
    return this.config.maxBytes;
  }

  /** A key nothing else will produce. See the module comment for why it is not the checksum. */
  keyFor(reviewId: string, extension: string): string {
    return `reviews/${reviewId}/${randomUUID()}.${extension}`;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.translate(() => this.storage.putObject(key, bytes, contentType));
  }

  async open(key: string): Promise<StoredObject> {
    return this.translate(() => this.storage.getObject(key));
  }

  /**
   * Best effort, and the failure is not the caller's problem.
   *
   * Called after the row is gone, so what is left is an object nobody can reach. Logged at
   * warn so an operator can reconcile the bucket; thrown, it would report a completed
   * deletion as failed and invite a retry that finds no row. `MediaService.delete` makes the
   * same trade in the same words, and here it matters more: the row is what a customer was
   * told was deleted.
   */
  async forget(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Photo row is gone but its object ${key} was not removed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The object store being unreachable is a 503 and says which side is down.
   *
   * Not a 500: nothing in this process is broken, and the difference decides whether the
   * person reading the alert restarts the API or looks at the bucket.
   */
  private async translate<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StorageError) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'ที่เก็บไฟล์รูปไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง', {
          storageStatus: error.status,
          ...(error.code === undefined ? {} : { storageCode: error.code }),
        });
      }
      throw error;
    }
  }
}
