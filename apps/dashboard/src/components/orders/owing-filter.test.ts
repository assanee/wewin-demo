import { describe, expect, it } from 'vitest';

import { describeOwingFilter } from './owing-filter';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE ONE NUMBER THIS SCREEN MUST NOT PRINT IS A TOTAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The list is fetched with a `limit`. A sum of its rows understates the debt the moment there
 * are more owing orders than fit on the page, and nothing on screen would say so — the exact
 * shape of defect `outstanding-breakdown.ts` shipped once, where a TypeScript sum was compared
 * against the server's aggregate over a different predicate.
 *
 * So these tests pin two things: that the sentence counts and never sums, and that a full page
 * says it may be a page.
 */

const at = (over: Partial<Parameters<typeof describeOwingFilter>[0]>) =>
  describeOwingFilter({ owingOnly: true, shown: 3, limit: 100, statusLabelTh: null, ...over });

describe('the owing filter says how many, never how much', () => {
  it('counts the orders on screen', () => {
    const notice = at({ shown: 7 });

    expect(notice.summaryTh).toContain('7 ออเดอร์');
    /* ⭐ No baht sign, anywhere, at any count. The per-row column carries the amounts. */
    expect(notice.summaryTh).not.toContain('฿');
  });

  it('⭐ warns that a full page may not be the whole debt', () => {
    /*
     * THE ASSERTION THE LIMIT TURNS ON. Ninety-nine rows is an answer; a hundred out of a
     * hundred is a page, and a reader told "ค้างชำระ 100 ออเดอร์" with no qualifier will chase
     * a hundred and stop.
     */
    expect(at({ shown: 100, limit: 100 }).summaryTh).toContain('อาจมีมากกว่านี้');
    expect(at({ shown: 99, limit: 100 }).summaryTh).not.toContain('อาจมีมากกว่านี้');
  });

  it('reads a server that over-delivers as possibly truncated rather than as complete', () => {
    /* `>=`, not `===`. More rows than asked for is somebody else's bug; claiming completeness
     * on the strength of it would be this function's. */
    expect(at({ shown: 101, limit: 100 }).summaryTh).toContain('อาจมีมากกว่านี้');
  });

  it('says the ordering, because the ordering is the point of the filter', () => {
    expect(at({ shown: 4 }).summaryTh).toContain('เรียงจากยอดมากไปน้อย');
  });

  it('names the status when one is also chosen, so the count is not read too widely', () => {
    const notice = at({ shown: 2, statusLabelTh: 'กำลังผลิต' });

    expect(notice.summaryTh).toContain('กำลังผลิต');
    expect(notice.summaryTh).toContain('2 ออเดอร์');
  });
});

describe('nothing owing is stated, not left as an absence', () => {
  it('⭐ says the company is paid up rather than showing an empty filtered list', () => {
    /*
     * An empty table under an active filter reads as "the filter is broken" at least as often
     * as "you are paid up", and the two call for opposite reactions from whoever is looking.
     */
    const notice = at({ shown: 0 });

    expect(notice.emptyTh).toBe('ไม่มีออเดอร์ที่ค้างชำระ');
    expect(notice.summaryTh).toBeNull();
  });

  it('scopes that sentence to the status when one is chosen', () => {
    expect(at({ shown: 0, statusLabelTh: 'ส่งมอบแล้ว' }).emptyTh).toContain('ส่งมอบแล้ว');
  });
});

describe('with the filter off it says nothing, and the empty text goes back to the list’s own', () => {
  it('adds no sentence above an unfiltered table', () => {
    expect(at({ owingOnly: false }).summaryTh).toBeNull();
  });

  it('keeps the wording the screen used before this filter existed', () => {
    expect(at({ owingOnly: false, shown: 0 }).emptyTh).toBe('ยังไม่มีออเดอร์ในระบบ');
    expect(at({ owingOnly: false, shown: 0, statusLabelTh: 'ยกเลิก' }).emptyTh).toBe(
      'ไม่มีออเดอร์ในสถานะ “ยกเลิก”',
    );
  });
});
