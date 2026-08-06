import { createHash } from 'node:crypto';

import { ImageRejected, normaliseImage, type NormalisedImage } from '../media/image';

/**
 * 📍 The GPS problem — plan 9.4, and the half of it that is code rather than schema.
 *
 * > ลูกค้าถ่ายหน้าต่างบ้านตัวเอง พิกัดบ้านติดมากับไฟล์ — **การเผยแพร่รูปนั้นคือการเผยแพร่ที่อยู่ลูกค้า**
 *
 * A phone JPEG carries EXIF GPS by default. A pipeline that stores the upload verbatim
 * publishes the coordinates of a customer's house with every review, and nothing about the
 * resulting page looks wrong. That is the whole threat, and it is not hypothetical: it is
 * the default behaviour of every phone camera sold.
 *
 * ── Reuse, not a second stripper ────────────────────────────────────────────────
 *
 * `src/media/image` already solves this for product photography — an allowlist of three
 * JPEG application segments, a PNG chunk filter, a WebP chunk filter, a stop at EOI — and it
 * solves it because the module comment there says plan 9.4 is the reason it exists. A second
 * implementation here would be a second answer to "is this file safe to publish", and the
 * two would agree until the day a phone vendor invented a new segment. So this file adds
 * nothing to the stripping and everything to the *checking* of it.
 *
 * ── ⭐ Verify the stripping rather than trusting the library ─────────────────────
 *
 * The brief for this round is explicit, and it is the right instinct: a stripper that
 * reports success and leaves the tag is indistinguishable from one that works, right up
 * until a customer's address is on a public page. Three checks, and each catches a different
 * lie:
 *
 *   ⓵ **the output is re-parsed.** `normaliseImage` is run a second time, on the bytes that
 *      are about to be stored. If anything metadata-shaped survived the first pass, the
 *      second pass finds something to strip — and `stripped` being non-empty on the second
 *      pass means the first pass was incomplete. This is the check that does not depend on
 *      the stripper's own report of what it did.
 *
 *   ⓶ **the output is a fixed point.** Re-parsing must also produce *byte-identical* output.
 *      A stripper that rewrites a file differently every time it sees it has not converged
 *      on a canonical form, and "we removed everything" is not a claim it is entitled to
 *      make. This is stronger than ⓵ and catches a rewrite that drops nothing but reorders.
 *
 *   ⓷ **no EXIF/XMP marker survives a byte scan.** A last, dumb, format-independent sweep
 *      for `Exif\0\0`, the XMP namespace URI and the Photoshop resource signature in the
 *      stored bytes. It knows nothing about container structure, which is exactly why it is
 *      worth having beside two checks that know a great deal: a container the parser
 *      *skipped* rather than dropped would pass ⓵ and ⓶ and fail this.
 *
 * None of the three proves the absence of GPS in general — that would require decoding every
 * container a camera vendor might invent — and the limit is stated rather than implied. What
 * they prove is that this build's stripper did what this build's stripper claims, on this
 * file, which is the claim the API actually makes to the customer.
 *
 * ── 🔴 The one place the schema and this pipeline disagree, measured not guessed ──
 *
 * `review_photos_bytes_were_rewritten` is `CHECK (checksum_sha256 <> source_checksum_sha256)`
 * — the stored bytes must differ from the uploaded bytes. Its purpose is exactly right: it
 * refuses the commonest and worst implementation, *stream the upload straight to object
 * storage*, as a write error on the row that did it.
 *
 * **But a file that carried no metadata comes back byte-identical, and is refused.** Measured
 * rather than reasoned about: a minimal PNG (one IHDR, one IDAT, one IEND — which is what a
 * browser's `canvas.toDataURL()` produces, and a crop widget is a canvas) goes through
 * `normaliseImage` with `stripped: []` and `bytes.equals(input) === true`. So does a JPEG
 * whose only application segments are the three on the allowlist.
 *
 * There is no honest way for this layer to make the two checksums differ. It could store
 * something other than what it received, or record a `source_checksum_sha256` that is not
 * the checksum of the source — and the second is a lie written into the column whose entire
 * job is to be true. So the upload is **refused**, with a reason that names the cause, and
 * the refusal is the safe direction: a rejected upload is a customer pressing the button
 * again, and the alternative failure is coordinates in a public bucket.
 *
 * The fix is one line in `packages/db/drizzle/0020_review_guards.sql` and is not this
 * round's to make — see `STRIP_RECIPE` below and the note reported to the schema's owner.
 */

/**
 * Which stripper produced the stored bytes, and which version of it.
 *
 * Written to `review_photos.strip_recipe`, whose schema comment gives the reason: when a
 * stripper turns out to have had a bug, the rows it produced must be a WHERE clause rather
 * than an archaeology project. The version moves when the *behaviour* moves — a new dropped
 * segment, a new format, a changed allowlist — and not when this file is reformatted.
 *
 * `verify1` names the checking pass as well as the stripping one, because a build that
 * stripped correctly and checked nothing produced different rows from this one even though
 * the bytes are the same.
 */
export const STRIP_RECIPE = 'wewin/media-image@1+verify1';

export type PhotoRejectionReason =
  /** The bytes are not a JPEG, PNG or WebP — or are an SVG, which is refused by name. */
  | 'unsupported'
  /** Recognised and then unparseable. */
  | 'malformed'
  /** A decompression bomb rather than a photograph. */
  | 'too-many-pixels'
  /**
   * ⭐ The stripper's output did not survive its own verification.
   *
   * This is the reason that must never be reported to a customer as "try again": it means
   * the pipeline is wrong, not the file. It is logged at error and the row is not written.
   */
  | 'strip-not-verified'
  /**
   * The stored bytes equal the uploaded bytes, so `review_photos_bytes_were_rewritten` will
   * refuse the row. See the 🔴 section of the module comment — this is the schema's
   * constraint speaking, not a property of the file.
   */
  | 'not-rewritten';

export class PhotoRejected extends Error {
  readonly reason: PhotoRejectionReason;
  /** Thai, for the customer. `message` stays English for the log. */
  readonly messageTh: string;

  constructor(reason: PhotoRejectionReason, message: string, messageTh: string) {
    super(message);
    this.name = 'PhotoRejected';
    this.reason = reason;
    this.messageTh = messageTh;
  }
}

export interface PreparedPhoto {
  /** The bytes to store — stripped, and verified to be stripped. */
  readonly bytes: Buffer;
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly extension: 'jpg' | 'png' | 'webp';
  readonly width: number;
  readonly height: number;
  /** Of the stored bytes. */
  readonly checksumSha256: string;
  /** Of the received bytes. The pair is the schema's EXIF guard. */
  readonly sourceChecksumSha256: string;
  /** What the first pass removed, by name. Echoed to the client and logged. */
  readonly stripped: readonly string[];
  /** True when all three verification checks passed. Never false on a returned value. */
  readonly verified: boolean;
  readonly stripRecipe: string;
}

/**
 * Byte signatures of metadata containers, for check ⓷.
 *
 * Deliberately not a parse. This runs over the whole stored buffer and knows nothing about
 * where a segment may legally begin, which is exactly why it is worth having beside two
 * checks that know a great deal — a container the parser *skipped* rather than dropped would
 * pass ⓵ and ⓶ and fail this.
 *
 * ── Every signature here is long, and the length is the whole design ─────────────
 *
 * A byte scan over compressed image data will eventually hit any short string by chance, and
 * a check that fires on entropy is a check somebody disables. So the four-byte chunk names —
 * `tEXt`, `iTXt`, `zTXt`, and WebP's `EXIF`/`XMP ` FourCCs — are **deliberately not here**:
 * at one in 2³² per position that is roughly a 1-in-4,000 false refusal on a one-megabyte
 * photograph, which is a handful of angry customers a year for no additional safety. Those
 * containers are already dropped structurally by the PNG and WebP chunk filters, and ⓵ and ⓶
 * are what check that they were.
 *
 * What is left is six, twenty-nine and fourteen bytes of fixed text. One in 2⁴⁸ per position
 * for the shortest of them is never, on any photograph anybody will ever upload — and the
 * failure direction if it did happen is a refused upload rather than a published address.
 *
 * `Exif\0\0` and not `Exif`: the four bare letters appear in ordinary text and in some ICC
 * profile descriptions, and the ICC profile is deliberately kept (dropping it renders a
 * wide-gamut photograph visibly wrong).
 */
const METADATA_SIGNATURES: readonly (readonly [string, Buffer])[] = [
  ['Exif', Buffer.from('Exif\0\0', 'latin1')],
  ['XMP', Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')],
  ['Photoshop/IPTC', Buffer.from('Photoshop 3.0\0', 'latin1')],
];

/**
 * Bytes in, a photograph that is safe to publish out — or a refusal.
 *
 * The whole of plan 9.4(1) is this function returning rather than throwing.
 */
export function prepareReviewPhoto(input: Buffer): PreparedPhoto {
  const first = strip(input);

  /* ⓵ and ⓶ — see the module comment. Both against the bytes that are about to be stored. */
  const second = strip(first.bytes);

  if (second.stripped.length > 0) {
    throw notVerified(
      `the stripper left ${second.stripped.join(', ')} in its own output`,
    );
  }

  if (!second.bytes.equals(first.bytes)) {
    throw notVerified('the stripper is not idempotent: re-running it changed the bytes again');
  }

  /* ⓷ — the format-independent sweep. */
  const surviving = METADATA_SIGNATURES.filter(([, signature]) => first.bytes.includes(signature)).map(
    ([name]) => name,
  );

  if (surviving.length > 0) {
    throw notVerified(`metadata signatures survived in the stored bytes: ${surviving.join(', ')}`);
  }

  const sourceChecksumSha256 = createHash('sha256').update(input).digest('hex');
  const checksumSha256 = createHash('sha256').update(first.bytes).digest('hex');

  /* 🔴 The schema's constraint, refused here so it arrives as a 415 and not a 23514. */
  if (checksumSha256 === sourceChecksumSha256) {
    throw new PhotoRejected(
      'not-rewritten',
      'the stored bytes equal the uploaded bytes, so review_photos_bytes_were_rewritten will refuse ' +
        'the row: this file carried no metadata container for the stripper to remove',
      'ไฟล์นี้ไม่มีข้อมูลแฝงให้ระบบลบออก จึงยืนยันไม่ได้ว่ารูปถูกเขียนใหม่ — ' +
        'กรุณาบันทึกรูปใหม่จากแอปแก้ไขรูปแล้วอัปโหลดอีกครั้ง',
    );
  }

  return {
    bytes: first.bytes,
    contentType: first.contentType,
    extension: first.extension,
    width: first.width,
    height: first.height,
    checksumSha256,
    sourceChecksumSha256,
    stripped: first.stripped,
    verified: true,
    stripRecipe: STRIP_RECIPE,
  };
}

function strip(bytes: Buffer): NormalisedImage {
  try {
    return normaliseImage(bytes);
  } catch (error) {
    if (error instanceof ImageRejected) {
      throw new PhotoRejected(
        error.reason === 'unrecognised' ? 'unsupported' : error.reason,
        error.message,
        error.messageTh,
      );
    }
    throw error;
  }
}

/**
 * The refusal that means the pipeline is wrong.
 *
 * The Thai message deliberately does not say "try again", because trying again will produce
 * exactly the same result and the customer is not the person who can fix it. It says the
 * system could not confirm the file was cleaned, which is true and is the only honest thing
 * to put in front of somebody whose address is in the file.
 */
function notVerified(what: string): PhotoRejected {
  return new PhotoRejected(
    'strip-not-verified',
    `EXIF stripping could not be verified: ${what}`,
    'ระบบยืนยันไม่ได้ว่าลบข้อมูลตำแหน่งที่ถ่าย (GPS) ออกจากรูปนี้ได้ครบถ้วน จึงไม่บันทึกรูปไว้ ' +
      'ทีมงานได้รับแจ้งแล้ว',
  );
}
