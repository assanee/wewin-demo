import { describe, expect, it } from 'vitest';

import { overviewFocus, type CountedQueue } from './overview-focus';

/**
 * ⚠️ Every assertion here compares a **whole string with `toBe`**, never `toContain`.
 * `toContain` on short Thai is unsound in this repository's own house rule — `'3 ชม.'` matches
 * inside `'13 ชม.'` — and the same trap is live here: `'2 รายการรอดำเนินการ'` is a substring of
 * `'12 รายการรอดำเนินการ'`. A containment assertion on the headline would pass for the wrong
 * number.
 */

const q = (label: string, count: number): CountedQueue => ({ label, count });

describe('overviewFocus', () => {
  it('says nothing is waiting, calmly, when every visible queue is empty', () => {
    const focus = overviewFocus([q('สลิปรอตรวจ', 0), q('คำขอคืนเงิน', 0)]);

    expect(focus.waiting).toBe(0);
    expect(focus.headlineTh).toBe('ไม่มีงานค้างในคิวที่คุณดูได้');
    expect(focus.detailTh).toBe('ทุกคิวที่บัญชีนี้เห็นว่างอยู่');
    expect(focus.pressing).toEqual([]);
  });

  it('drops the detail line when the reader can see no queue at all', () => {
    /*
     * An account in no group reaches `overview-screen.tsx`'s `nothingAtAll` branch, but a
     * reader holding only, say, `catalog.read` gets a real screen with an empty queue list —
     * and "ทุกคิวที่บัญชีนี้เห็นว่างอยู่" would be a claim about a set with nothing in it.
     */
    const focus = overviewFocus([]);

    expect(focus.headlineTh).toBe('ไม่มีงานค้างในคิวที่คุณดูได้');
    expect(focus.detailTh).toBeNull();
  });

  it('totals every visible queue and names only the non-empty ones', () => {
    const focus = overviewFocus([
      q('สลิปรอตรวจ', 4),
      q('ใบเสนอราคารออนุมัติ', 0),
      q('คำขอคืนเงิน', 2),
      q('รีวิวรอกลั่นกรอง', 0),
    ]);

    expect(focus.waiting).toBe(6);
    expect(focus.headlineTh).toBe('6 รายการรอดำเนินการ');
    expect(focus.detailTh).toBe('สลิปรอตรวจ 4 · คำขอคืนเงิน 2');
  });

  it('puts the heaviest queue first regardless of the order it arrived in', () => {
    const focus = overviewFocus([q('สลิปรอตรวจ', 1), q('คำขอคืนเงิน', 9), q('รีวิวรอกลั่นกรอง', 3)]);

    expect(focus.pressing.map((queue) => queue.label)).toEqual([
      'คำขอคืนเงิน',
      'รีวิวรอกลั่นกรอง',
      'สลิปรอตรวจ',
    ]);
    expect(focus.detailTh).toBe('คำขอคืนเงิน 9 · รีวิวรอกลั่นกรอง 3 · สลิปรอตรวจ 1');
  });

  it('keeps the order of the working day when counts tie', () => {
    /* Five queues holding one item each is a real state; the day's order is the tiebreak. */
    const focus = overviewFocus([
      q('สลิปรอตรวจ', 1),
      q('ใบเสนอราคารออนุมัติ', 1),
      q('คำขอคืนเงิน', 1),
    ]);

    expect(focus.detailTh).toBe('สลิปรอตรวจ 1 · ใบเสนอราคารออนุมัติ 1 · คำขอคืนเงิน 1');
  });

  it('does not mutate the list it was handed', () => {
    /*
     * `pressing` sorts, and sorting in place would reorder the very array
     * `overview-screen.tsx` renders its tiles from — the queue list and the summary line would
     * disagree about the order of the working day.
     *
     * ⚠️ What protects this is that `filter` runs **before** `sort` and returns a fresh array.
     * Mutation-tested: rewriting the chain as `queues.sort(…).filter(…)` fails this case, which
     * is the check being load-bearing. The same test also proved an earlier `[...queues]` spread
     * was dead code — removing it changed nothing — so the spread was deleted rather than left
     * standing as a protection it did not provide.
     */
    const queues = [q('สลิปรอตรวจ', 1), q('คำขอคืนเงิน', 9)];
    overviewFocus(queues);

    expect(queues.map((queue) => queue.label)).toEqual(['สลิปรอตรวจ', 'คำขอคืนเงิน']);
  });

  it('distinguishes a count whose sentence is a substring of another', () => {
    /* The `toContain` trap, pinned: 2 and 12 must not be mistakable for one another. */
    expect(overviewFocus([q('สลิปรอตรวจ', 2)]).headlineTh).toBe('2 รายการรอดำเนินการ');
    expect(overviewFocus([q('สลิปรอตรวจ', 12)]).headlineTh).toBe('12 รายการรอดำเนินการ');
  });
});
