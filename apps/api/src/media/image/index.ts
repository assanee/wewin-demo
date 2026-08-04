import { ImageRejected, type NormalisedImage } from './format';
import { readJpeg } from './jpeg';
import { readPng } from './png';
import { readWebp } from './webp';

export {
  ImageRejected,
  MAX_DIMENSION,
  MAX_PIXELS,
  type ImageRejectionReason,
  type NormalisedImage,
} from './format';

/**
 * The only entry point: bytes in, a stored image or a refusal out.
 *
 * **Nothing outside this function may decide what an upload is.** Not the `Content-Type`
 * header, which the uploader wrote; not the extension, which the uploader also wrote. An
 * upload endpoint that trusts either is the hole in the wall the brief for this round
 * names — `.jpg` on a file whose bytes are HTML is stored, served back from an origin that
 * holds sessions, and rendered as a document.
 *
 * The three formats are dispatched on their magic bytes, and everything else is refused by
 * name where the name is worth knowing:
 *
 *   **SVG is refused, and it is the one to understand.** It is a real image format that
 *   browsers render, and it is also XML that can carry `<script>`, `<foreignObject>` with
 *   arbitrary HTML, and external references. Served from any origin this app controls it is
 *   stored cross-site scripting. There is no sanitiser here good enough to make it safe, so
 *   it does not come in — and the refusal says so rather than saying "unsupported file",
 *   because somebody uploading a logo needs to know to export a PNG instead.
 *
 *   **GIF and BMP and TIFF are refused as merely unsupported.** No argument about them,
 *   just no reader; TIFF is worth a note of its own, since it is the container EXIF is
 *   built out of and a product catalogue has no use for it.
 */
export function normaliseImage(input: Buffer): NormalisedImage {
  if (startsWith(input, [0xff, 0xd8, 0xff])) return readJpeg(input);
  if (startsWith(input, [0x89, 0x50, 0x4e, 0x47])) return readPng(input);
  if (startsWith(input, [0x52, 0x49, 0x46, 0x46]) && input.toString('latin1', 8, 12) === 'WEBP') {
    return readWebp(input);
  }

  throw rejectionFor(input);
}

function rejectionFor(input: Buffer): ImageRejected {
  if (looksLikeSvg(input)) {
    return new ImageRejected(
      'unsupported',
      'SVG is not accepted: it is XML that can carry script, and serving it back is stored XSS',
      'ระบบไม่รับไฟล์ SVG เพราะเปิดช่องให้ฝังสคริปต์ได้ กรุณาส่งออกเป็น PNG หรือ JPEG แล้วอัปโหลดใหม่',
    );
  }

  const named = knownButUnsupported(input);
  if (named !== null) {
    return new ImageRejected(
      'unsupported',
      `${named} is not one of the accepted formats`,
      `ระบบยังไม่รองรับไฟล์ ${named} — รองรับเฉพาะ JPEG, PNG และ WebP`,
    );
  }

  return new ImageRejected(
    'unrecognised',
    'the leading bytes match no accepted image format',
    'ไฟล์นี้ไม่ใช่รูปภาพที่ระบบรองรับ (รับเฉพาะ JPEG, PNG และ WebP)',
  );
}

function startsWith(input: Buffer, magic: readonly number[]): boolean {
  if (input.length < magic.length) return false;
  return magic.every((byte, index) => input.readUInt8(index) === byte);
}

function knownButUnsupported(input: Buffer): string | null {
  if (startsWith(input, [0x47, 0x49, 0x46, 0x38])) return 'GIF';
  if (startsWith(input, [0x42, 0x4d])) return 'BMP';
  if (startsWith(input, [0x49, 0x49, 0x2a, 0x00]) || startsWith(input, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'TIFF';
  }
  if (startsWith(input, [0x25, 0x50, 0x44, 0x46])) return 'PDF';
  // HEIC/HEIF: an ISO-BMFF box whose brand starts with `heic`/`mif1` at offset 8.
  if (input.length >= 12 && input.toString('latin1', 4, 8) === 'ftyp') return 'HEIC/HEIF';
  return null;
}

/**
 * SVG has no magic bytes — it is text — so this looks for the shape rather than a signature,
 * over a bounded prefix. A byte-order mark, whitespace, an XML declaration and comments may
 * all come first, and any of them is how a naive `startsWith('<svg')` gets bypassed.
 */
function looksLikeSvg(input: Buffer): boolean {
  const head = input.toString('utf8', 0, Math.min(input.length, 1024)).toLowerCase();
  return head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'));
}
