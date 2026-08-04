import type { MediaContentType } from '@wewin/db/schema';

/**
 * What the three readers in this directory agree on.
 *
 * Every one of them does the same two jobs in one pass, and it is worth saying why they
 * are one job rather than two:
 *
 *   **decide what this is** — from the bytes, never from the filename and never from the
 *   request's `Content-Type`. Both of those are typed by whoever is uploading.
 *
 *   **rewrite it without the metadata** — plan 9.4: a JPEG straight off a phone carries the
 *   GPS coordinates of wherever it was taken, so publishing a photograph of a customer's
 *   window publishes their address. The plan makes the point about review photos; it is the
 *   same file arriving through a different door here.
 *
 * They are one pass because the alternative is parsing the file twice with two parsers that
 * can disagree — and a validator that disagrees with the thing doing the writing is how a
 * file gets accepted as one format and stored as another.
 *
 * ── What this is not ──────────────────────────────────────────────────────────
 *
 * These readers walk container structure. They do **not** decode pixels, so they do not
 * and cannot prove that the compressed data inside is safe for a decoder: a malformed
 * scan that trips a bug in a browser's JPEG decoder passes through here intact. Re-encoding
 * through an image library would address that, at the cost of a native dependency, of
 * re-compressing every photograph the studio uploads, and of trusting that library's own
 * decoder with the same bytes. What is done instead is defence at the serving edge — the
 * stored content type, `nosniff`, a sandboxing CSP and an origin that hosts nothing else
 * (see media.controller.ts). This paragraph exists so that trade is visible rather than
 * assumed.
 */

export interface NormalisedImage {
  readonly contentType: MediaContentType;
  /** For the storage key. Not taken from the upload's filename — see the module comment. */
  readonly extension: 'jpg' | 'png' | 'webp';
  readonly width: number;
  readonly height: number;
  /** The bytes to store: the same image, with every metadata container removed. */
  readonly bytes: Buffer;
  /**
   * What was dropped, by name — `Exif`, `XMP`, `tEXt`, `trailing bytes after EOI`.
   *
   * Reported back on the upload response and logged. Not decoration: "we strip EXIF" is a
   * claim that is either true of this file or not, and the only way anybody finds out
   * which is if the endpoint says what it did.
   */
  readonly stripped: readonly string[];
}

export type ImageRejectionReason =
  /** The leading bytes match no format this API accepts. */
  | 'unrecognised'
  /** Recognised, and deliberately refused — SVG above all. */
  | 'unsupported'
  /** The right magic bytes and then a structure that does not parse. */
  | 'malformed'
  /** Parsed, but the pixel dimensions are a decompression bomb rather than a photograph. */
  | 'too-many-pixels';

/**
 * A rejected upload, with a reason a caller can branch on and a Thai message for a person.
 *
 * The message never quotes the file's contents back. An error body is logged, and a
 * rejected upload is exactly the file you least want appearing in a log.
 */
export class ImageRejected extends Error {
  readonly reason: ImageRejectionReason;
  /** Thai, for the dashboard to show as-is. `message` stays English for the log. */
  readonly messageTh: string;

  constructor(reason: ImageRejectionReason, message: string, messageTh: string) {
    super(message);
    this.name = 'ImageRejected';
    this.reason = reason;
    this.messageTh = messageTh;
  }
}

export function malformed(what: string): ImageRejected {
  return new ImageRejected(
    'malformed',
    `malformed image: ${what}`,
    'ไฟล์รูปเสียหายหรือไม่สมบูรณ์ กรุณาบันทึกใหม่แล้วอัปโหลดอีกครั้ง',
  );
}

/**
 * The ceiling on decoded size, which is a different limit from the byte ceiling and has to
 * be, because they defend against different things.
 *
 * `MEDIA_MAX_BYTES` bounds what this process reads into memory. This bounds what a
 * *browser* is asked to allocate when it decodes the result: a 40 kB PNG can legally
 * declare 40000×40000 pixels, and 1.6 gigapixels at 4 bytes each is 6.4 GB in the tab of
 * whoever opened the product page. 50 megapixels is roughly a 100-megabyte-file DSLR raw
 * export — far above any product photograph and far below anything dangerous.
 */
export const MAX_PIXELS = 50_000_000;

/** No single side beyond this, so an 80000×1 strip is refused before the pixel count is. */
export const MAX_DIMENSION = 20_000;

export function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw malformed(`declared dimensions ${String(width)}×${String(height)}`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new ImageRejected(
      'too-many-pixels',
      `image is ${String(width)}×${String(height)}, beyond the ${String(MAX_PIXELS)} pixel ceiling`,
      `รูปมีขนาด ${String(width)}×${String(height)} พิกเซล ซึ่งใหญ่เกินกว่าที่ระบบรับได้`,
    );
  }
}

/** Bounds-checked reads. Buffer's own accessors throw `RangeError`, which says nothing about the file. */
export function requireLength(input: Buffer, end: number, what: string): void {
  if (end > input.length) throw malformed(`${what} runs past the end of the file`);
}
