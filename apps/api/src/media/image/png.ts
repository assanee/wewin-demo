import { checkDimensions, malformed, requireLength, type NormalisedImage } from './format';

/**
 * PNG: keep the chunks that make the picture, drop the chunks that describe it.
 *
 * A PNG is a signature and then a list of `length type data crc` chunks. The type's first
 * letter carries a rule the format itself defines: uppercase means **critical** — a decoder
 * that does not understand it must refuse the file — and lowercase means **ancillary**, safe
 * to ignore. That rule is what makes this function possible without a pixel decoder: every
 * critical chunk is copied untouched, and ancillary chunks are copied only if they are on
 * the list below.
 *
 * An allowlist rather than "drop eXIf, tEXt, zTXt, iTXt", for the reason jpeg.ts gives at
 * greater length: the named list is right until somebody's export pipeline invents a new
 * private chunk, and the cost of being wrong is a customer's address in a public file.
 * PNG is unusually friendly to this — a decoder is *required* to survive an ancillary chunk
 * it has never seen, so dropping one can never make a file unreadable.
 *
 * What that removes, concretely: `eXIf` (the same EXIF block a JPEG carries, GPS included —
 * phones write PNG screenshots with location on them), `tEXt`/`zTXt`/`iTXt` (free text, and
 * where most tools put the author, the software and sometimes a file path from the machine
 * it was made on), `tIME`, and anything unrecognised.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The ancillary chunks worth keeping. Every one of them changes how the image *looks*.
 *
 *   gAMA cHRM sRGB iCCP sBIT — colour. Drop `iCCP` from a wide-gamut export and it renders
 *                              over-saturated, exactly as with JPEG's ICC segment.
 *   tRNS                     — the transparency palette. Dropping it makes transparent
 *                              pixels opaque, which for a product cut-out is the whole point
 *                              of using PNG.
 *   bKGD pHYs                — background colour and pixel density.
 *   acTL fcTL fdAT           — APNG. Ancillary by design, so that a non-APNG decoder shows
 *                              the first frame; dropping them silently turns an animation
 *                              into a still.
 */
const KEPT_ANCILLARY = new Set([
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'tRNS',
  'bKGD',
  'pHYs',
  'acTL',
  'fcTL',
  'fdAT',
]);

function isCritical(type: string): boolean {
  const first = type.charCodeAt(0);
  return first >= 0x41 && first <= 0x5a;
}

export function readPng(input: Buffer): NormalisedImage {
  if (input.length < SIGNATURE.length || !input.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw malformed('no PNG signature');
  }

  const out: Buffer[] = [SIGNATURE];
  const stripped: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let cursor = SIGNATURE.length;
  let sawEnd = false;

  while (cursor < input.length) {
    requireLength(input, cursor + 8, 'chunk header');
    const length = input.readUInt32BE(cursor);
    /*
     * The spec caps a chunk at 2^31-1, and this is not pedantry: `readUInt32BE` happily
     * returns 4 billion, and a length that overflows past the buffer is how a parser that
     * trusts it ends up reading somebody else's memory or looping forever.
     */
    if (length > 0x7fff_ffff) throw malformed(`chunk length ${String(length)}`);
    const type = input.toString('latin1', cursor + 4, cursor + 8);
    const chunkEnd = cursor + 12 + length;
    requireLength(input, chunkEnd, `chunk ${type}`);

    if (type === 'IHDR') {
      if (length < 13) throw malformed('IHDR shorter than 13 bytes');
      width = input.readUInt32BE(cursor + 8);
      height = input.readUInt32BE(cursor + 12);
    } else if (width === undefined) {
      throw malformed('the first chunk is not IHDR');
    }

    if (isCritical(type) || KEPT_ANCILLARY.has(type)) {
      out.push(input.subarray(cursor, chunkEnd));
    } else {
      stripped.push(type);
    }

    cursor = chunkEnd;

    if (type === 'IEND') {
      sawEnd = true;
      // Same rule as JPEG's EOI: whatever follows is not part of the image, and the only
      // thing that ever deliberately follows is something somebody wanted carried along.
      if (cursor < input.length) stripped.push('trailing bytes after IEND');
      break;
    }
  }

  if (!sawEnd) throw malformed('no IEND chunk');
  if (width === undefined || height === undefined) throw malformed('no IHDR chunk');
  checkDimensions(width, height);

  return {
    contentType: 'image/png',
    extension: 'png',
    width,
    height,
    bytes: Buffer.concat(out),
    stripped,
  };
}
