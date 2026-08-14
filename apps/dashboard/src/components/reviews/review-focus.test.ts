import { describe, expect, it } from 'vitest';

import { hoursLeft, reviewFocus, type CountedReview } from './review-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. The trap is live and this file is where it
 * bites hardest: **`'3 ชม.'` is a substring of `'13 ชม.'`**, so a containment assertion on the
 * detail line would pass for a review with ten hours more left than the one it meant.
 */

const item = (hoursRemaining: number): CountedReview => ({ hoursRemaining });

describe('reviewFocus', () => {
  it('says nothing is on its way out when the queue is empty', () => {
    const focus = reviewFocus([]);

    expect(focus.waiting).toBe(0);
    expect(focus.soonestHours).toBeNull();
    expect(focus.headlineTh).toBe('ไม่มีรีวิวที่กำลังจะเผยแพร่เอง');
    expect(focus.detailTh).toBeNull();
  });

  /**
   * ⭐ The verb is the point. Nobody is waiting for the moderator — the clock is running and the
   * moderator is who may stop it. A headline reading "3 รีวิวรอกลั่นกรอง" describes a different
   * feature, one where doing nothing is safe.
   */
  it('says what is about to happen, not what is waiting', () => {
    const focus = reviewFocus([item(40), item(30), item(20)]);

    expect(focus.headlineTh).toBe('3 รีวิวกำลังจะขึ้นหน้าเว็บเอง');
    expect(focus.detailTh).toBe('เร็วที่สุดอีก 20 ชม.');
  });

  it('names how many are inside the twelve-hour window', () => {
    const focus = reviewFocus([item(40), item(11), item(2)]);

    expect(focus.urgent).toBe(2);
    expect(focus.detailTh).toBe('เร็วที่สุดอีก 2 ชม. · ภายใน 12 ชม. 2 รายการ');
  });

  /** The boundary is inclusive: a review with exactly twelve hours left is inside the window. */
  it('counts exactly twelve hours as urgent', () => {
    expect(reviewFocus([item(12)]).urgent).toBe(1);
    expect(reviewFocus([item(12.4)]).urgent).toBe(0);
  });

  it('finds the soonest whatever order the queue arrived in', () => {
    expect(reviewFocus([item(5), item(1), item(9)]).soonestHours).toBe(1);
    expect(reviewFocus([item(9), item(5), item(1)]).soonestHours).toBe(1);
  });

  /**
   * ⚠️ The race, rendered honestly. `hoursRemaining` goes negative between the window elapsing
   * and the row leaving this queue on the next read, and "อีก -0 ชม." is a rendering of that race
   * rather than of anything a moderator can act on.
   */
  it('never counts down past zero', () => {
    expect(hoursLeft(-0.4)).toBe(0);
    expect(hoursLeft(-9)).toBe(0);
    expect(reviewFocus([item(-0.4)]).detailTh).toBe('เร็วที่สุดอีก 0 ชม. · ภายใน 12 ชม. 1 รายการ');
  });

  /**
   * ⭐ The substring trap, pinned. `'3 ชม.'` occurs inside `'13 ชม.'`, so these two must be
   * compared whole or the assertion proves nothing.
   */
  it('distinguishes three hours from thirteen', () => {
    expect(reviewFocus([item(3)]).detailTh).toBe('เร็วที่สุดอีก 3 ชม. · ภายใน 12 ชม. 1 รายการ');
    expect(reviewFocus([item(13)]).detailTh).toBe('เร็วที่สุดอีก 13 ชม.');
  });

  it('rounds the same way the row beside it does', () => {
    /* One rounding rule, called from both places, so the summary and the row cannot disagree. */
    expect(reviewFocus([item(2.6)]).soonestHours).toBe(hoursLeft(2.6));
    expect(hoursLeft(2.6)).toBe(3);
  });

  it('does not reorder the list it was handed', () => {
    /* `review-queue.tsx` sorts its own copy for display; this must not sort the caller's array. */
    const items = [item(5), item(1), item(9)];
    reviewFocus(items);

    expect(items.map((entry) => entry.hoursRemaining)).toEqual([5, 1, 9]);
  });
});
