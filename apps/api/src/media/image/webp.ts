import { checkDimensions, malformed, requireLength, type NormalisedImage } from './format';

/**
 * WebP: a RIFF container, so the metadata is a chunk like any other and comes off cleanly.
 *
 * `RIFF <size> WEBP` and then a list of `<fourcc> <size> <payload>` chunks, each padded to
 * an even length. Two of those chunks are metadata and nothing else — `EXIF` and `XMP `
 * (note the trailing space; a fourcc is always four bytes) — and WebP is the one format
 * here where the picture data and the metadata never share a structure.
 *
 * The catch that makes this more than "drop two chunks": an extended-format file begins
 * with a `VP8X` chunk whose first byte is a bitfield declaring which optional chunks are
 * present. Removing the EXIF chunk while leaving its bit set produces a file that announces
 * metadata it does not contain, which a strict decoder is entitled to reject. So the bits
 * are cleared in the same pass.
 *
 * Everything else is carried through untouched: `ALPH` (the alpha channel), `ANIM`/`ANMF`
 * (animation), `ICCP` (the colour profile, kept for the reason jpeg.ts keeps ICC), and the
 * `VP8 `/`VP8L` image data itself.
 */

/** Bit positions in VP8X's flag byte. Reserved(2) ICC Alpha Exif XMP Animation Reserved(1). */
const FLAG_EXIF = 0b0000_1000;
const FLAG_XMP = 0b0000_0100;

interface Chunk {
  readonly fourcc: string;
  readonly payload: Buffer;
}

export function readWebp(input: Buffer): NormalisedImage {
  if (
    input.length < 12 ||
    input.toString('latin1', 0, 4) !== 'RIFF' ||
    input.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    throw malformed('no RIFF/WEBP header');
  }

  /*
   * The declared RIFF size, not the buffer length, decides where the file ends. A file with
   * bytes past that point is the WebP spelling of JPEG's trailing-data trick, and the same
   * answer applies: they are not part of the image and they are not stored.
   */
  const declaredEnd = Math.min(8 + input.readUInt32LE(4), input.length);
  if (declaredEnd < 12) throw malformed(`RIFF size ${String(input.readUInt32LE(4))}`);

  const kept: Chunk[] = [];
  const stripped: string[] = [];
  let cursor = 12;

  while (cursor < declaredEnd) {
    requireLength(input, cursor + 8, 'chunk header');
    const fourcc = input.toString('latin1', cursor, cursor + 4);
    const size = input.readUInt32LE(cursor + 4);
    if (size > 0x7fff_ffff) throw malformed(`chunk size ${String(size)}`);
    const payloadEnd = cursor + 8 + size;
    requireLength(input, payloadEnd, `chunk ${fourcc}`);

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      stripped.push(fourcc.trim());
    } else {
      kept.push({ fourcc, payload: input.subarray(cursor + 8, payloadEnd) });
    }

    // Odd-sized payloads are followed by one padding byte, which is not counted in `size`.
    cursor = payloadEnd + (size % 2);
  }

  if (input.length > declaredEnd) stripped.push('trailing bytes after the RIFF chunk');

  const first = kept[0];
  if (first === undefined) throw malformed('no chunks');

  const dimensions = readDimensions(kept);
  checkDimensions(dimensions.width, dimensions.height);

  if (first.fourcc === 'VP8X') {
    if (first.payload.length < 10) throw malformed('VP8X shorter than 10 bytes');
    /*
     * Copied before the write. `first.payload` is a view into the request body, and
     * mutating it would edit the caller's buffer — which happens to be harmless here and
     * would stop being harmless the first time anything hashed the input.
     */
    const patched = Buffer.from(first.payload);
    patched.writeUInt8(patched.readUInt8(0) & ~(FLAG_EXIF | FLAG_XMP), 0);
    kept[0] = { fourcc: 'VP8X', payload: patched };
  }

  return {
    contentType: 'image/webp',
    extension: 'webp',
    width: dimensions.width,
    height: dimensions.height,
    bytes: assemble(kept),
    stripped,
  };
}

/**
 * The canvas size, from whichever chunk is authoritative for this file's flavour.
 *
 * Three encodings for one number, which is a WebP fact rather than a choice here: `VP8X`
 * states the canvas explicitly, a lossy `VP8 ` frame hides it in the keyframe header after
 * a three-byte start code, and a lossless `VP8L` packs both sides into 28 bits of a
 * little-endian word.
 */
function readDimensions(chunks: readonly Chunk[]): { width: number; height: number } {
  const byName = (fourcc: string): Buffer | undefined =>
    chunks.find((chunk) => chunk.fourcc === fourcc)?.payload;

  const vp8x = byName('VP8X');
  if (vp8x !== undefined) {
    if (vp8x.length < 10) throw malformed('VP8X shorter than 10 bytes');
    return {
      width: vp8x.readUIntLE(4, 3) + 1,
      height: vp8x.readUIntLE(7, 3) + 1,
    };
  }

  const lossy = byName('VP8 ');
  if (lossy !== undefined) {
    if (lossy.length < 10) throw malformed('VP8 frame shorter than its header');
    if (lossy.readUInt8(3) !== 0x9d || lossy.readUInt8(4) !== 0x01 || lossy.readUInt8(5) !== 0x2a) {
      throw malformed('VP8 keyframe start code missing');
    }
    // 14 bits of size and 2 bits of upscaling hint, which decoders ignore for the canvas.
    return {
      width: lossy.readUInt16LE(6) & 0x3fff,
      height: lossy.readUInt16LE(8) & 0x3fff,
    };
  }

  const lossless = byName('VP8L');
  if (lossless !== undefined) {
    if (lossless.length < 5 || lossless.readUInt8(0) !== 0x2f) throw malformed('VP8L signature missing');
    const packed = lossless.readUInt32LE(1);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }

  throw malformed('no VP8, VP8L or VP8X chunk');
}

/** Rebuild the container from the chunks that survived, with a corrected RIFF size. */
function assemble(chunks: readonly Chunk[]): Buffer {
  const body: Buffer[] = [];
  for (const chunk of chunks) {
    const header = Buffer.alloc(8);
    header.write(chunk.fourcc, 0, 4, 'latin1');
    header.writeUInt32LE(chunk.payload.length, 4);
    body.push(header, chunk.payload);
    if (chunk.payload.length % 2 === 1) body.push(Buffer.from([0x00]));
  }

  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'latin1');
  // The size field counts everything after itself: the 'WEBP' tag plus the chunks.
  header.writeUInt32LE(4 + payload.length, 4);
  header.write('WEBP', 8, 4, 'latin1');
  return Buffer.concat([header, payload]);
}
