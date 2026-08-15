import { describe, expect, it } from 'vitest';

import { GALLERY_MAX, addImage, moveImage, readVideoUrl, removeImageAt } from './gallery';

const A = '/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '/media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = '/products/casement.svg';

describe('adding a picture', () => {
  it('appends to the end, because the end is where a new picture goes', () => {
    const result = addImage([A], B);
    expect(result.ok && result.images).toStrictEqual([A, B]);
  });

  it('⚠️ refuses one that is already in the gallery', () => {
    /*
     * The database would take it — unique is on `(product_id, sort_order)`, not on the path.
     * The same photograph at positions 2 and 5 reads as a broken shop.
     */
    const result = addImage([A, B], A);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonTh).toContain('อยู่ในแกลเลอรี');
  });

  it('⚠️ refuses the twenty-fifth, which is what the contract refuses', () => {
    const full = Array.from({ length: GALLERY_MAX }, (_, index) => `/media/${String(index)}`);
    expect(addImage(full, '/media/extra').ok).toBe(false);
    expect(addImage(full.slice(1), '/media/extra').ok).toBe(true);
  });
});

describe('removing a picture', () => {
  it('takes out the one named and leaves the order of the rest', () => {
    expect(removeImageAt([A, B, C], 1)).toStrictEqual([A, C]);
  });

  it('an index that is not there changes nothing', () => {
    expect(removeImageAt([A], 5)).toStrictEqual([A]);
    expect(removeImageAt([A], -1)).toStrictEqual([A]);
  });
});

describe('reordering', () => {
  it('⭐ swaps with the neighbour in the direction asked for', () => {
    expect(moveImage([A, B, C], 2, -1)).toStrictEqual([A, C, B]);
    expect(moveImage([A, B, C], 0, 1)).toStrictEqual([B, A, C]);
  });

  it('⛔ clamps at the ends rather than wrapping', () => {
    /*
     * A wrapping list would send the first picture — the one a customer sees first, and so
     * the one most likely to have "up" clicked on it — all the way to the back. The button
     * would mean "one earlier" every time but once.
     */
    expect(moveImage([A, B, C], 0, -1)).toStrictEqual([A, B, C]);
    expect(moveImage([A, B, C], 2, 1)).toStrictEqual([A, B, C]);
  });

  it('leaves a one-picture gallery alone in both directions', () => {
    expect(moveImage([A], 0, -1)).toStrictEqual([A]);
    expect(moveImage([A], 0, 1)).toStrictEqual([A]);
  });

  it('does not mutate the list it was given', () => {
    const original = [A, B];
    moveImage(original, 0, 1);
    expect(original).toStrictEqual([A, B]);
  });
});

describe('the video link', () => {
  it('empty means the link is removed, not left alone', () => {
    expect(readVideoUrl('')).toStrictEqual({ ok: true, value: null });
    expect(readVideoUrl('   ')).toStrictEqual({ ok: true, value: null });
  });

  it('takes an http(s) link, trimmed', () => {
    expect(readVideoUrl('  https://www.youtube.com/watch?v=abc  ')).toStrictEqual({
      ok: true,
      value: 'https://www.youtube.com/watch?v=abc',
    });
    expect(readVideoUrl('http://vimeo.com/1').ok).toBe(true);
  });

  it('⛔ refuses javascript: and data:, which are well-formed URLs', () => {
    /*
     * This is the whole reason the check is not `new URL()` alone. The value is stored,
     * frozen into a published document, and rendered into an `href` by the storefront —
     * fixing this form later would not reach a document that already carries one.
     */
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      const result = readVideoUrl(hostile);
      expect(result.ok, hostile).toBe(false);
      expect(!result.ok && result.reasonTh).toContain('http');
    }
  });

  it('refuses something that is not a URL at all', () => {
    expect(readVideoUrl('youtube.com/watch?v=abc').ok).toBe(false);
    expect(readVideoUrl('ดูวิดีโอที่ยูทูบ').ok).toBe(false);
  });

  it('refuses a link past the column width', () => {
    expect(readVideoUrl(`https://a.com/${'x'.repeat(500)}`).ok).toBe(false);
  });
});
