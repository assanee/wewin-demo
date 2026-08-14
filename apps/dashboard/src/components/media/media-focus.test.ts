import { describe, expect, it } from 'vitest';

import { mediaFocus, type CountedMedia } from './media-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. `'1 รูปในคลัง'` is a substring of
 * `'11 รูปในคลัง'` and `'ไม่มีใครใช้ 2'` of `'ไม่มีใครใช้ 12'`, so containment here would prove
 * nothing about the number the sentence actually carries.
 */

const media = (frozen: number, drafts: number): CountedMedia => ({
  usage: {
    frozen: Array.from({ length: frozen }, (_, index) => index),
    drafts: Array.from({ length: drafts }, (_, index) => index),
  },
});

describe('mediaFocus', () => {
  it('turns an empty library into the invitation, not a zero', () => {
    const focus = mediaFocus([], false);

    expect(focus.shown).toBe(0);
    expect(focus.headlineTh).toBe('ยังไม่มีรูปในคลัง');
    expect(focus.detailTh).toBe('อัปโหลดรูปแรกเพื่อนำไปใช้เป็นภาพหลักของสินค้า');
  });

  /**
   * ⭐ `frozen` is the field that decides whether ลบ is offered at all, so it is the field the
   * summary counts by. A published document points at these bytes and a customer was shown them.
   */
  it('counts by what stops a file being deleted', () => {
    const focus = mediaFocus([media(1, 0), media(2, 1), media(0, 0)], false);

    expect(focus.cited).toBe(2);
    expect(focus.unused).toBe(1);
    expect(focus.headlineTh).toBe('3 รูปในคลัง');
    expect(focus.detailTh).toBe('ลบไม่ได้ 2 — มีเวอร์ชันที่เผยแพร่แล้วอ้างอิงอยู่ · ไม่มีใครใช้ 1');
  });

  /**
   * ⚠️ Draft-only is its own bucket. It can be deleted and doing so leaves a draft pointing at
   * nothing — a different answer from both neighbours, and the reason the three numbers have to
   * add up to the total on screen.
   */
  it('keeps draft-only separate from both cited and unused', () => {
    const focus = mediaFocus([media(0, 1), media(0, 3), media(1, 1), media(0, 0)], false);

    expect(focus.cited).toBe(1);
    expect(focus.inDrafts).toBe(2);
    expect(focus.unused).toBe(1);
    expect(focus.cited + focus.inDrafts + focus.unused).toBe(focus.shown);
    expect(focus.detailTh).toBe(
      'ลบไม่ได้ 1 — มีเวอร์ชันที่เผยแพร่แล้วอ้างอิงอยู่ · อยู่ในฉบับร่าง 2 · ไม่มีใครใช้ 1',
    );
  });

  it('drops the buckets that are empty rather than printing zeroes', () => {
    expect(mediaFocus([media(0, 0), media(0, 0)], false).detailTh).toBe('ไม่มีใครใช้ 2');
  });

  /**
   * ⭐ The honesty rule this screen needs most. The library is paginated, so a count taken from
   * the first page is a count of the first page — and "42 รูปในคลัง" said over a library of nine
   * hundred is a confident wrong answer rather than a missing one.
   */
  it('says it is describing what has loaded when there is more behind the cursor', () => {
    const focus = mediaFocus([media(1, 0), media(0, 0)], true);

    expect(focus.headlineTh).toBe('2 รูปที่โหลดมาแล้ว');
    expect(focus.detailTh).toBe(
      'ลบไม่ได้ 1 — มีเวอร์ชันที่เผยแพร่แล้วอ้างอิงอยู่ · ไม่มีใครใช้ 1 · ยังโหลดไม่ครบ — กดโหลดเพิ่มเพื่อนับทั้งคลัง',
    );
  });

  it('distinguishes a count whose sentence is a substring of another', () => {
    expect(mediaFocus([media(0, 0)], false).headlineTh).toBe('1 รูปในคลัง');
    expect(
      mediaFocus(Array.from({ length: 11 }, () => media(0, 0)), false).headlineTh,
    ).toBe('11 รูปในคลัง');
  });
});
