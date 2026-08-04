import { deflateSync } from 'node:zlib';

/**
 * Real files, built here rather than committed as binaries.
 *
 * A test that asserts "EXIF is removed" against a hand-typed byte array proves that the
 * parser agrees with the test author. These fixtures are built the other way round: the PNG
 * is assembled with real zlib and real CRCs, the JPEG below came out of an actual encoder,
 * and the EXIF block is a real TIFF structure with real GPS rationals in it — so the tests
 * fail if the readers stop understanding files that other software produces.
 *
 * Provenance of the JPEG, so nobody has to trust it: `makePng()` was written to disk and
 * converted with macOS `sips -s format jpeg`, which is why it carries both an `Exif` APP1
 * segment and a `Photoshop 3.0` APP13 segment that nobody asked for — exactly the metadata
 * an ordinary export pipeline attaches without being told to, which is the point.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * PNG
 * ────────────────────────────────────────────────────────────────────────── */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    let c = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A genuine 8×6 truecolour PNG: real deflate, real CRCs, openable by anything. */
export function makePng(extraChunks: readonly Buffer[] = []): Buffer {
  const width = 8;
  const height = 6;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour

  const scanlines: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3); // leading filter byte, then RGB
    for (let x = 0; x < width; x += 1) {
      row.writeUInt8((x * 31) & 0xff, 1 + x * 3);
      row.writeUInt8((y * 41) & 0xff, 2 + x * 3);
      row.writeUInt8(0x80, 3 + x * 3);
    }
    scanlines.push(row);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', deflateSync(Buffer.concat(scanlines))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * EXIF, with coordinates in it
 * ────────────────────────────────────────────────────────────────────────── */

/** ~13°44'36"N 100°30'18"E — the middle of Bangkok, as a camera would write it. */
export const GPS_LATITUDE_DEGREES = 13;
export const GPS_LONGITUDE_DEGREES = 100;

/**
 * A real EXIF payload: TIFF header, an IFD0 whose only entry points at a GPS IFD, and four
 * GPS tags with rational values. This is the block plan 9.4 is about — the thing that turns
 * a photograph of a customer's window into their home address.
 *
 * Hand-built rather than copied out of a photograph so the test can assert on the actual
 * numbers, and so this file carries nobody's real location.
 */
export function exifWithGps(): Buffer {
  const tiff = Buffer.alloc(128);
  tiff.write('MM', 0, 'latin1'); // big-endian
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 begins at byte 8

  tiff.writeUInt16BE(1, 8); // IFD0: one entry
  writeEntry(tiff, 10, 0x8825, 4, 1, 26); // GPSInfoIFDPointer -> byte 26
  tiff.writeUInt32BE(0, 22); // no IFD1

  tiff.writeUInt16BE(4, 26); // GPS IFD: four entries
  writeAsciiEntry(tiff, 28, 0x0001, 'N'); // GPSLatitudeRef
  writeEntry(tiff, 40, 0x0002, 5, 3, 80); // GPSLatitude  -> three rationals at byte 80
  writeAsciiEntry(tiff, 52, 0x0003, 'E'); // GPSLongitudeRef
  writeEntry(tiff, 64, 0x0004, 5, 3, 104); // GPSLongitude -> three rationals at byte 104
  tiff.writeUInt32BE(0, 76); // no next IFD

  writeRational(tiff, 80, GPS_LATITUDE_DEGREES, 1);
  writeRational(tiff, 88, 44, 1);
  writeRational(tiff, 96, 3600, 100);
  writeRational(tiff, 104, GPS_LONGITUDE_DEGREES, 1);
  writeRational(tiff, 112, 30, 1);
  writeRational(tiff, 120, 1800, 100);

  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

function writeEntry(
  target: Buffer,
  at: number,
  tag: number,
  type: number,
  count: number,
  value: number,
): void {
  target.writeUInt16BE(tag, at);
  target.writeUInt16BE(type, at + 2);
  target.writeUInt32BE(count, at + 4);
  target.writeUInt32BE(value, at + 8);
}

/** A two-byte ASCII value fits in the entry itself, left-justified. */
function writeAsciiEntry(target: Buffer, at: number, tag: number, letter: string): void {
  target.writeUInt16BE(tag, at);
  target.writeUInt16BE(2, at + 2);
  target.writeUInt32BE(2, at + 4);
  target.write(`${letter}\0\0\0`, at + 8, 4, 'latin1');
}

function writeRational(target: Buffer, at: number, numerator: number, denominator: number): void {
  target.writeUInt32BE(numerator, at);
  target.writeUInt32BE(denominator, at + 4);
}

/** Splice an APP1 segment in immediately after SOI, where a camera puts it. */
export function jpegWithSegment(jpeg: Buffer, marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, marker]),
    length,
    payload,
    jpeg.subarray(2),
  ]);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * JPEG
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 8×6, quality 60, straight out of macOS `sips`. See the provenance note at the top.
 *
 * Kept as base64 rather than as a binary file so that this directory stays diffable and so
 * that a test fixture cannot be silently replaced by something nobody can read.
 */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAABgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABgAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAAf/aAAwDAQACEQMRAD8AqeFfhTpnycp+X/1q9B/4VTpnqn5Vs+Ff4K9BrxcfmuM9u/3rNuEs7zD+y6f75n//2Q==';

export function makeJpeg(): Buffer {
  return Buffer.from(JPEG_BASE64, 'base64');
}

export const JPEG_WIDTH = 8;
export const JPEG_HEIGHT = 6;

/* ─────────────────────────────────────────────────────────────────────────────
 * WebP
 * ────────────────────────────────────────────────────────────────────────── */

export function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 4, 'latin1');
  header.writeUInt32LE(payload.length, 4);
  const padding = payload.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([header, payload, padding]);
}

export function riffFile(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([...chunks]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * A `VP8X` header with the canvas size and flags a real extended WebP carries.
 *
 * The byte layout was checked against an actual 1370×2534 WebP on this machine
 * (`VP8X` payload `10 00 00 00 59 05 00 e5 09 00`: alpha flag, then two 24-bit little-endian
 * "size minus one" fields) — which is how a fixture built by hand earns the right to stand
 * in for a real file.
 */
export function vp8xPayload(width: number, height: number, flags: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUInt8(flags, 0);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}

/** A lossless VP8L header: the 0x2F signature and 14+14 bits of "size minus one". */
export function vp8lPayload(width: number, height: number): Buffer {
  const payload = Buffer.alloc(16);
  payload.writeUInt8(0x2f, 0);
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return payload;
}
