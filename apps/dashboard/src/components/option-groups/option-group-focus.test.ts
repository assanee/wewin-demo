import { describe, expect, it } from 'vitest';

import { optionGroupFocus, type CountableGroup } from './option-group-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. The trap is live: `'1 ตัวเลือกปิดการขายอยู่'`
 * is a substring of `'11 ตัวเลือกปิดการขายอยู่'`, and the zero-branch detail line is a *suffix*
 * of the non-zero one, so containment could not separate the two branches at all.
 */

const group = (...available: boolean[]): CountableGroup => ({
  values: available.map((a) => ({ available: a })),
});

describe('optionGroupFocus', () => {
  it('reads as calm when every value is on sale', () => {
    const focus = optionGroupFocus([group(true, true), group(true)]);

    expect(focus.unavailable).toBe(0);
    expect(focus.headlineTh).toBe('ทุกตัวเลือกเปิดขายอยู่');
    expect(focus.detailTh).toBe('2 กลุ่ม · 3 ตัวเลือก');
  });

  it('never prints a zero as the headline', () => {
    /*
     * "0 ตัวเลือกปิดการขายอยู่" is a number a reader has to parse before they can relax, on the
     * healthy state of a catalogue. Same argument `overviewFocus` makes for an empty queue.
     */
    expect(optionGroupFocus([group(true)]).headlineTh).not.toBe('0 ตัวเลือกปิดการขายอยู่');
  });

  it('counts values switched off across every group', () => {
    const focus = optionGroupFocus([group(true, false), group(false), group(true)]);

    expect(focus.groups).toBe(3);
    expect(focus.values).toBe(4);
    expect(focus.unavailable).toBe(2);
    expect(focus.headlineTh).toBe('2 ตัวเลือกปิดการขายอยู่');
  });

  it('states the consequence only when something is actually switched off', () => {
    /*
     * The warning is what makes the number worth a focal point: `available` is the one edit in
     * this area that reaches customers without a publish. On a healthy catalogue there is no
     * consequence to warn about, so the caption falls back to plain totals.
     */
    const off = optionGroupFocus([group(false)]);
    const on = optionGroupFocus([group(true)]);

    expect(off.detailTh).toBe(
      'ลูกค้าเลือกไม่ได้ทันที ทุกเวอร์ชันที่เผยแพร่แล้ว — จาก 1 กลุ่ม · 1 ตัวเลือก',
    );
    expect(on.detailTh).toBe('1 กลุ่ม · 1 ตัวเลือก');
  });

  it('handles a group with no values at all', () => {
    const focus = optionGroupFocus([group(), group(true)]);

    expect(focus.groups).toBe(2);
    expect(focus.values).toBe(1);
    expect(focus.headlineTh).toBe('ทุกตัวเลือกเปิดขายอยู่');
  });

  it('handles an empty catalogue without claiming anything is wrong', () => {
    const focus = optionGroupFocus([]);

    expect(focus.headlineTh).toBe('ทุกตัวเลือกเปิดขายอยู่');
    expect(focus.detailTh).toBe('0 กลุ่ม · 0 ตัวเลือก');
  });

  it('distinguishes counts whose sentences contain one another', () => {
    const one = optionGroupFocus([group(false)]);
    const eleven = optionGroupFocus([group(...Array<boolean>(11).fill(false))]);

    expect(one.headlineTh).toBe('1 ตัวเลือกปิดการขายอยู่');
    expect(eleven.headlineTh).toBe('11 ตัวเลือกปิดการขายอยู่');
  });
});
