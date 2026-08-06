import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  PhotoRejected,
  prepareReviewPhoto,
  STRIP_RECIPE,
} from '../../src/reviews/review-photo.pipeline';

/**
 * 📍 The GPS problem — plan 9.4 — proven without a database.
 *
 * The threat is one sentence: *a customer photographs their own window, the file carries the
 * coordinates of their house, and publishing the file publishes their address.* So the test
 * that matters is not "does the function return". It is **build a JPEG with a GPS tag in it,
 * push it through the pipeline, and assert the coordinates are not in the stored bytes** —
 * which is what the first block does, with a hand-assembled EXIF APP1 segment carrying a
 * recognisable latitude.
 *
 * The second block is the part the brief asks for in as many words — *verify the stripping
 * rather than trusting the library*. It does not test the stripper; it tests the **checker**,
 * by handing the verification a stripper that lied. A verification nobody has ever seen fail
 * is a verification nobody has evidence for.
 *
 * The third block is the 🔴 finding: a file with no metadata comes back byte-identical and
 * the schema's `review_photos_bytes_were_rewritten` refuses it. That is measured here rather
 * than argued about, and it is the reason the pipeline refuses that upload itself.
 */

/* ------------------------------------------------------------------ *
 * Fixtures — real containers, assembled byte by byte
 * ------------------------------------------------------------------ */

/** A latitude a grep can find. Not a real house; the point is that it is distinctive. */
const GPS_NEEDLE = Buffer.from('13.7563N100.5018E', 'latin1');

function segment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

/**
 * A JPEG whose APP1 is an EXIF block containing `GPS_NEEDLE`.
 *
 * The EXIF payload is not a valid TIFF structure and does not need to be: the stripper drops
 * the whole segment on its marker and identifier without parsing inside it, which is the
 * allowlist design `image/jpeg.ts` argues for. What the fixture has to be is a *JPEG* the
 * reader will walk — SOI, segments, a start-of-frame with real dimensions, a scan, EOI.
 */
function jpegWithGps(): Buffer {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), GPS_NEEDLE, Buffer.alloc(24)]);

  /* precision(1) height(2) width(2) components(1) + one component descriptor(3). */
  const sof0 = Buffer.from([0x08, 0x00, 0x40, 0x00, 0x60, 0x01, 0x01, 0x11, 0x00]);
  /* components(1) + one (id, table) pair + Ss, Se, AhAl. */
  const sos = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    segment(0xfe, Buffer.from('taken at home', 'latin1')),
    segment(0xc0, sof0),
    segment(0xda, sos),
    /* Entropy data, with a stuffed FF so the scan walker has something to do. */
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 1×1 RGBA PNG. `extra` chunks go between IHDR and IDAT. */
function png(extra: readonly Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * ⓵ The coordinates do not survive
 * ------------------------------------------------------------------ */

describe('📍 a photograph of a customer\'s own window', () => {
  it('does not carry their address into storage', () => {
    const input = jpegWithGps();

    /* The premise: the fixture really does contain the coordinates. */
    expect(input.includes(GPS_NEEDLE)).toBe(true);

    const prepared = prepareReviewPhoto(input);

    /* ⭐ The assertion the whole feature exists for. */
    expect(prepared.bytes.includes(GPS_NEEDLE)).toBe(false);
    expect(prepared.bytes.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    /* The free-text comment goes too — plan 9.4 is about metadata, not only about GPS. */
    expect(prepared.bytes.includes(Buffer.from('taken at home', 'latin1'))).toBe(false);
  });

  it('reports what it removed, by name, so the claim is auditable per file', () => {
    const prepared = prepareReviewPhoto(jpegWithGps());
    expect(prepared.stripped).toContain('Exif');
    expect(prepared.stripped).toContain('COM comment');
  });

  it('keeps the picture: the dimensions survive the rewrite', () => {
    const prepared = prepareReviewPhoto(jpegWithGps());
    expect(prepared.width).toBe(0x60);
    expect(prepared.height).toBe(0x40);
    expect(prepared.contentType).toBe('image/jpeg');
  });

  it('stamps the recipe, so a buggy stripper\'s rows are a WHERE clause', () => {
    const prepared = prepareReviewPhoto(jpegWithGps());
    expect(prepared.stripRecipe).toBe(STRIP_RECIPE);
    expect(prepared.verified).toBe(true);
  });

  it('drops PNG text chunks, which are where a phone editor writes its own notes', () => {
    const withText = png([
      pngChunk('tEXt', Buffer.from('Comment\0บ้านคุณสมชาย ซอย 5', 'utf8')),
      pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>', 'latin1')),
    ]);

    const prepared = prepareReviewPhoto(withText);
    expect(prepared.bytes.includes(Buffer.from('ซอย 5', 'utf8'))).toBe(false);
    expect(prepared.stripped.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * ⓶ The verification is what is under test, not the stripper
 * ------------------------------------------------------------------ */

describe('the stripping is verified rather than trusted', () => {
  /**
   * The check that does not depend on the stripper's own report.
   *
   * A stripper that returns `stripped: ['Exif']` and leaves the segment in place is
   * indistinguishable from a working one *if you read its report*. Re-parsing the output is
   * how you stop reading the report — and this asserts the property that makes the re-parse
   * meaningful: the output of a correct strip has nothing left to strip.
   */
  it('finds nothing left to remove in its own output', () => {
    const prepared = prepareReviewPhoto(jpegWithGps());
    const second = prepareReviewPhoto(
      Buffer.concat([prepared.bytes, Buffer.from([0xff, 0xd9])]),
    );
    /* Feeding the output back in produces the same picture and reports only the tail. */
    expect(second.stripped).toStrictEqual(['trailing bytes after EOI']);
  });

  /**
   * ⭐ The verification is exercised by being made to fail.
   *
   * A guard nobody has seen go red is a guard nobody has evidence for. This constructs a file
   * whose *stored* form would still contain an EXIF marker if the byte sweep were not there —
   * the marker is inside the entropy-coded scan, where the container parser has no reason to
   * look and correctly does not.
   *
   * That is not a hypothetical shape: it is exactly what a crafted upload looks like, and it
   * is the case checks ⓵ and ⓶ of the pipeline cannot see. If the sweep is deleted, this test
   * goes green-with-the-wrong-answer — so it asserts the *rejection*, not the absence.
   */
  it('refuses bytes where a metadata signature survived somewhere the parser does not look', () => {
    const sof0 = Buffer.from([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
    const sos = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

    const smuggled = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xc0, sof0),
      segment(0xda, sos),
      /* Entropy data that happens to spell the EXIF identifier. No FF, so the scan continues. */
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from([0xff, 0xd9]),
    ]);

    expect(() => prepareReviewPhoto(smuggled)).toThrow(PhotoRejected);

    try {
      prepareReviewPhoto(smuggled);
      expect.unreachable('the byte sweep must refuse this');
    } catch (error) {
      expect(error).toBeInstanceOf(PhotoRejected);
      expect((error as PhotoRejected).reason).toBe('strip-not-verified');
      /*
       * And the Thai message does not tell the customer to try again, because trying again
       * produces the same answer and they are not the person who can fix it.
       */
      expect((error as PhotoRejected).messageTh).not.toContain('ลองใหม่');
    }
  });
});

/* ------------------------------------------------------------------ *
 * ⓷ 🔴 The measured disagreement with the schema
 * ------------------------------------------------------------------ */

describe('🔴 a file that carried no metadata', () => {
  /**
   * The finding, measured rather than argued.
   *
   * `review_photos_bytes_were_rewritten` is `CHECK (checksum_sha256 <> source_checksum_sha256)`
   * and its purpose is right: it refuses *stream the upload straight to object storage* as a
   * write error on the row that did it. But a minimal PNG — one IHDR, one IDAT, one IEND,
   * which is what a browser canvas produces and therefore what a crop widget uploads — comes
   * back byte-identical, so the row would be refused by Postgres with a constraint name.
   *
   * There is no honest way for the API to make the two checksums differ: it would have to
   * store something other than what it received, or record a `source_checksum_sha256` that is
   * not the checksum of the source, and the second is a lie in the column whose whole job is
   * to be true. So the upload is refused *here*, with a reason that names the cause, and the
   * refusal is the safe direction — a rejected upload is a customer pressing the button
   * again; the alternative failure is coordinates in a public bucket.
   */
  it('is refused, because the schema requires the stored bytes to differ from the uploaded ones', () => {
    const clean = png();

    try {
      prepareReviewPhoto(clean);
      expect.unreachable('a byte-identical rewrite cannot satisfy review_photos_bytes_were_rewritten');
    } catch (error) {
      expect(error).toBeInstanceOf(PhotoRejected);
      expect((error as PhotoRejected).reason).toBe('not-rewritten');
      expect((error as PhotoRejected).message).toContain('review_photos_bytes_were_rewritten');
    }
  });

  /** And the same file with one text chunk in it goes through, which is what makes it a finding. */
  it('goes through the moment there is anything at all to remove', () => {
    const withOneChunk = png([pngChunk('tEXt', Buffer.from('Software\0a phone', 'latin1'))]);
    const prepared = prepareReviewPhoto(withOneChunk);

    expect(prepared.checksumSha256).not.toBe(prepared.sourceChecksumSha256);
    expect(prepared.verified).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * What is refused for being the wrong thing entirely
 * ------------------------------------------------------------------ */

describe('what does not come in at all', () => {
  it('refuses SVG by name — it is XML that can carry script', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    try {
      prepareReviewPhoto(svg);
      expect.unreachable('SVG is stored XSS when served back');
    } catch (error) {
      expect((error as PhotoRejected).reason).toBe('unsupported');
      expect((error as PhotoRejected).messageTh).toContain('SVG');
    }
  });

  it('refuses HEIC, which is what an iPhone sends unless it is told otherwise', () => {
    const heic = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(16),
    ]);
    try {
      prepareReviewPhoto(heic);
      expect.unreachable('there is no HEIC reader here');
    } catch (error) {
      expect((error as PhotoRejected).reason).toBe('unsupported');
    }
  });

  it('refuses a file whose leading bytes are not an image this API accepts', () => {
    try {
      prepareReviewPhoto(Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8'));
      expect.unreachable('the bytes decide, never the filename and never the header');
    } catch (error) {
      expect(error).toBeInstanceOf(PhotoRejected);
    }
  });
});
