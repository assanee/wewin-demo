import { describe, expect, it } from 'vitest';

import { authorityFocus, type CountedCeiling } from './authority-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. `'1 บทบาทลดราคาได้เองภายในเพดาน'` is a
 * substring of `'11 บทบาทลดราคาได้เองภายในเพดาน'`, and `'ถูกถอนไปแล้ว 2'` of
 * `'ถูกถอนไปแล้ว 12'` — the same trap `overview-focus.test.ts` records.
 */

const live: CountedCeiling = { revokedAt: null };
const withdrawn: CountedCeiling = { revokedAt: '2026-08-11T04:00:00.000Z' };

describe('authorityFocus', () => {
  /**
   * ⭐ The most consequential sentence this dashboard prints, and it used to be a
   * default-variant `<Alert>` — the same shape as every routine notice in the app.
   */
  it('states the whole machinery being inert, when it is', () => {
    const focus = authorityFocus({ isFailClosed: true, limits: [] });

    expect(focus.headlineTh).toBe('ยังไม่มีใครมีอำนาจลดราคา');
    expect(focus.detailTh).toBe(
      'ตอนนี้ไม่มีเพดานที่ใช้งานอยู่เลย พนักงานขายจึงลดราคาเองไม่ได้ และไม่มีใครอนุมัติส่วนลดให้ได้ — ใบเสนอราคาที่ไม่มีส่วนลดยังส่งได้ตามปกติ',
    );
  });

  /**
   * ⭐ **The flag decides, not the row count.** Since withdrawal became a flag, a table of
   * nothing but withdrawn ceilings is non-empty *and* fail-closed. A screen that branched on
   * `limits.length` would tell an administrator the feature was on the day it was switched off —
   * the argument `authority-limits.test.ts` makes about the decoder, one layer up.
   */
  it('says the same thing when every ceiling has been withdrawn', () => {
    const focus = authorityFocus({ isFailClosed: true, limits: [withdrawn, withdrawn] });

    expect(focus.headlineTh).toBe('ยังไม่มีใครมีอำนาจลดราคา');
    expect(focus.live).toBe(0);
    expect(focus.withdrawn).toBe(2);
  });

  /**
   * ⚠️ And it wins even against rows that look live. The two are computed server-side from the
   * same table, so they cannot honestly disagree — but if they ever do, the fail-*closed*
   * sentence is the safe one to print, and a client that trusted its own count would print the
   * fail-open one.
   */
  it('lets the server flag win over a row that looks live', () => {
    expect(authorityFocus({ isFailClosed: true, limits: [live] }).headlineTh).toBe(
      'ยังไม่มีใครมีอำนาจลดราคา',
    );
  });

  it('has a counterpart for the good state, which the Alert never had', () => {
    const focus = authorityFocus({ isFailClosed: false, limits: [live, live] });

    expect(focus.live).toBe(2);
    expect(focus.headlineTh).toBe('2 บทบาทลดราคาได้เองภายในเพดาน');
    expect(focus.detailTh).toBe('บทบาทที่ไม่มีเพดานยังลดราคาเองไม่ได้ และอนุมัติส่วนลดให้ใครไม่ได้');
  });

  it('mentions withdrawn rows only when there are some', () => {
    expect(authorityFocus({ isFailClosed: false, limits: [live, withdrawn] }).detailTh).toBe(
      'บทบาทที่ไม่มีเพดานยังลดราคาเองไม่ได้ และอนุมัติส่วนลดให้ใครไม่ได้ · ถูกถอนไปแล้ว 1',
    );
  });

  /**
   * ⚠️ The withdrawn count is on the *screen*, so it must not read as an instruction. It says
   * ถูกถอนไปแล้ว and never the button's own words — `authority-limits.test.ts` asserts that
   * ยกเลิกอำนาจ is absent from a fully withdrawn table, and that assertion is how the screen
   * proves there is nothing left to withdraw. A summary line using the same phrase would make
   * that check pass on a page that says the opposite.
   */
  it('does not put the withdraw button’s words into the summary line', () => {
    const focus = authorityFocus({ isFailClosed: false, limits: [live, withdrawn] });

    expect(focus.detailTh.includes('ยกเลิกอำนาจ')).toBe(false);
    expect(focus.headlineTh.includes('กำหนดเพดาน')).toBe(false);
  });

  it('distinguishes a count whose sentence is a substring of another', () => {
    expect(authorityFocus({ isFailClosed: false, limits: [live] }).headlineTh).toBe(
      '1 บทบาทลดราคาได้เองภายในเพดาน',
    );
    expect(
      authorityFocus({
        isFailClosed: false,
        limits: Array.from({ length: 11 }, () => live),
      }).headlineTh,
    ).toBe('11 บทบาทลดราคาได้เองภายในเพดาน');
  });
});
