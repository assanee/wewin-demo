import { checkDimensions, malformed, requireLength, type NormalisedImage } from './format';

/**
 * JPEG: keep the picture, drop everything that is a note about the picture.
 *
 * A JPEG is a chain of segments, each `FF <marker> <2-byte length> <payload>`, ending at
 * EOI. The picture lives in the quantisation tables, the Huffman tables, the frame header
 * and the entropy-coded scan. Everything a camera knows about *you* lives in the
 * application segments beside them:
 *
 *   APP1 `Exif\0\0`   — make, model, serial number, the exact second, and **GPS**. This is
 *                       the one plan 9.4 is about.
 *   APP1 `http://ns.adobe.com/xap/1.0/` — XMP, which carries a second copy of most of it
 *                       plus whatever the editing software felt like adding.
 *   APP13             — Photoshop's resource block, i.e. IPTC, which has its own location
 *                       fields and its own creator fields.
 *   APP3…APP12        — maker notes and camera-vendor extensions. Undocumented, varied, and
 *                       there is no reason a product photograph needs any of them.
 *   COM               — a free-text comment.
 *
 * So the rule here is an **allowlist**, not a blocklist: three application segments survive
 * and every other one is dropped, whatever it turns out to contain. A blocklist of "APP1
 * and APP13" would be correct today and wrong the first time a phone vendor invents a new
 * one — and the failure mode of being wrong is the customer's home address in a public
 * image.
 *
 * The three that survive, and why each is not a privacy question but a rendering one:
 *
 *   APP0 `JFIF`  — pixel density and thumbnail flags. Ancient, harmless, and some decoders
 *                  are happier with it present.
 *   APP2 `ICC_PROFILE` — the colour profile. Drop it and a wide-gamut photograph renders
 *                  visibly wrong (over-saturated) in every colour-managed browser. It
 *                  describes the *encoding*, not the photographer.
 *   APP14 `Adobe` — the colour transform flag. Dropping it on a YCCK/CMYK JPEG inverts the
 *                  colours. Six bytes of "how to read the channels below".
 *
 * Two more things this does that are not about metadata:
 *
 *   **it stops at EOI.** Bytes appended after the end-of-image marker are ignored by every
 *   decoder and are the classic way to hide a payload inside something that is, genuinely
 *   and verifiably, a valid image. They do not survive this function.
 *
 *   **it rebuilds rather than edits.** The output is assembled segment by segment from the
 *   input, so anything the parser did not understand well enough to copy is not in it.
 */

/** Standalone markers: no length, no payload. RST0–RST7 and TEM. */
function isStandalone(marker: number): boolean {
  return (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
}

/** Start-of-frame, in any of its flavours. C4 is DHT, C8 is reserved, CC is DAC — not frames. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * An APPn segment survives only if its marker *and* its identifier string are both on the
 * list. The identifier matters: APP1 is Exif and APP1 is also XMP, and a segment claiming
 * to be `ICC_PROFILE` under APP1 is not an ICC profile, it is somebody being clever.
 */
function keptApplicationSegment(marker: number, payload: Buffer): string | null {
  if (marker === 0xe0 && (startsWith(payload, 'JFIF\0') || startsWith(payload, 'JFXX\0'))) return 'JFIF';
  if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) return 'ICC_PROFILE';
  if (marker === 0xee && startsWith(payload, 'Adobe')) return 'Adobe';
  return null;
}

function startsWith(payload: Buffer, prefix: string): boolean {
  return payload.length >= prefix.length && payload.toString('latin1', 0, prefix.length) === prefix;
}

/** What to call a dropped segment in the report, so `stripped` reads as English and not as hex. */
function describeDropped(marker: number, payload: Buffer): string {
  if (marker === 0xfe) return 'COM comment';
  if (marker === 0xe1 && startsWith(payload, 'Exif\0')) return 'Exif';
  if (marker === 0xe1) return 'XMP';
  if (marker === 0xed) return 'Photoshop/IPTC';
  return `APP${String(marker - 0xe0)}`;
}

export function readJpeg(input: Buffer): NormalisedImage {
  if (input.length < 4 || input.readUInt8(0) !== 0xff || input.readUInt8(1) !== 0xd8) {
    throw malformed('no SOI marker');
  }

  const out: Buffer[] = [input.subarray(0, 2)];
  const stripped: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let cursor = 2;

  for (;;) {
    if (cursor + 1 >= input.length) throw malformed('ended before EOI');
    if (input.readUInt8(cursor) !== 0xff) throw malformed(`expected a marker at byte ${String(cursor)}`);

    // 0xFF may repeat as fill before the marker byte; a canonical `FF <marker>` is emitted.
    let markerAt = cursor + 1;
    while (markerAt < input.length && input.readUInt8(markerAt) === 0xff) markerAt += 1;
    if (markerAt >= input.length) throw malformed('fill bytes with no marker after them');

    const marker = input.readUInt8(markerAt);

    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      // Anything after this point is not part of the image. See the module comment.
      if (markerAt + 1 < input.length) stripped.push('trailing bytes after EOI');
      break;
    }

    if (marker === 0xd8) throw malformed('a second SOI marker');

    if (isStandalone(marker)) {
      out.push(Buffer.from([0xff, marker]));
      cursor = markerAt + 1;
      continue;
    }

    requireLength(input, markerAt + 3, 'segment length');
    const length = input.readUInt16BE(markerAt + 1);
    if (length < 2) throw malformed(`segment length ${String(length)}`);
    const segmentEnd = markerAt + 1 + length;
    requireLength(input, segmentEnd, 'segment');
    const payload = input.subarray(markerAt + 3, segmentEnd);

    if (isStartOfFrame(marker) && width === undefined) {
      // precision(1) height(2) width(2), immediately after the length field.
      if (payload.length < 5) throw malformed('a start-of-frame shorter than its own header');
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
    }

    const isApplication = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if ((isApplication && keptApplicationSegment(marker, payload) === null) || isComment) {
      stripped.push(describeDropped(marker, payload));
    } else {
      out.push(Buffer.from([0xff, marker]), input.subarray(markerAt + 1, segmentEnd));
    }

    cursor = segmentEnd;

    if (marker === 0xda) {
      // Start of scan: what follows is entropy-coded data, not segments. Walk it byte by
      // byte to find where it ends, because `FF` inside it is escaped (`FF 00`) or a
      // restart marker, and only an unescaped marker terminates the scan. A progressive
      // JPEG has several of these, so this returns to the loop rather than to the caller.
      const scanEnd = endOfEntropyData(input, segmentEnd);
      out.push(input.subarray(segmentEnd, scanEnd));
      cursor = scanEnd;
    }
  }

  if (width === undefined || height === undefined) throw malformed('no start-of-frame segment');
  checkDimensions(width, height);

  return {
    contentType: 'image/jpeg',
    extension: 'jpg',
    width,
    height,
    bytes: Buffer.concat(out),
    stripped,
  };
}

/** The index of the `FF` that begins the next real marker after the scan. */
function endOfEntropyData(input: Buffer, from: number): number {
  let index = from;
  while (index < input.length) {
    if (input.readUInt8(index) !== 0xff) {
      index += 1;
      continue;
    }
    if (index + 1 >= input.length) throw malformed('entropy data ended on a lone FF');

    const next = input.readUInt8(index + 1);
    // `FF 00` is a stuffed literal FF; RSTn is a restart inside the scan; `FF FF` is fill.
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      index += 2;
      continue;
    }
    if (next === 0xff) {
      index += 1;
      continue;
    }
    return index;
  }
  throw malformed('entropy data ended without a marker');
}
