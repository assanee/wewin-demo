import { describe, expect, it } from 'vitest';

import { slipQueueFocus, type CountedSlip } from './slip-focus';

/**
 * ⚠️ Every assertion compares a **whole string with `toBe`**, never `toContain`. `toContain` on
 * short Thai is unsound here — `'2 สลิปรอตรวจ รวม ฿1,500'` is a substring of
 * `'12 สลิปรอตรวจ รวม ฿1,500'` — so a containment assertion on this headline would pass for the
 * wrong number. Same rule `overview-focus.test.ts` keeps.
 */

const slip = (amountThbMinor: bigint, hasImage = true): CountedSlip => ({
  amountThbMinor,
  hasImage,
});

describe('slipQueueFocus', () => {
  it('says the queue is empty, calmly, rather than counting to zero', () => {
    const focus = slipQueueFocus([]);

    expect(focus.waiting).toBe(0);
    expect(focus.claimedThbMinor).toBe(0n);
    expect(focus.headlineTh).toBe('ไม่มีสลิปรอตรวจ');
    expect(focus.detailTh).toBe('สลิปที่ลูกค้าส่งเข้ามาถูกตัดสินครบแล้ว');
  });

  it('states how many are waiting and for how much', () => {
    const focus = slipQueueFocus([slip(150_000n), slip(50_000n)]);

    expect(focus.waiting).toBe(2);
    expect(focus.claimedThbMinor).toBe(200_000n);
    expect(focus.headlineTh).toBe('2 สลิปรอตรวจ รวม ฿2,000');
  });

  /**
   * ⭐ The sentence may not call this money, and this is the case that pins it.
   *
   * Nothing in the total has moved a balance — `order_settled_thb_minor()` counts accepted slips
   * only. A detail line that stopped saying so would leave a ฿2,000 figure on screen that a
   * reader would reconcile against the overview's รับชำระเดือนนี้ and find missing.
   */
  it('qualifies the total as a claim, every time, including when nothing is odd about it', () => {
    expect(slipQueueFocus([slip(150_000n)]).detailTh).toBe(
      'ยอดที่ลูกค้าแจ้ง ยังไม่ตัดเข้างวดจนกว่าจะมีคนรับสลิป',
    );
  });

  it('names the slips with no image, because those are claims with no evidence', () => {
    const focus = slipQueueFocus([slip(150_000n), slip(50_000n, false), slip(10_000n, false)]);

    expect(focus.withoutImage).toBe(2);
    expect(focus.detailTh).toBe(
      'ยอดที่ลูกค้าแจ้ง ยังไม่ตัดเข้างวดจนกว่าจะมีคนรับสลิป · ไม่มีภาพแนบ 2 รายการ',
    );
  });

  /**
   * ⚠️ satang, summed as `bigint`. `9007199254740992n` is `2 ** 53`: a `number` accumulator adds
   * the `1n` beside it and returns `9007199254740992` unchanged, silently losing a satang and
   * every satang after it. The queue is capped at 200 rows, which is not far enough away from
   * this to be a theoretical concern on a company that quotes in millions.
   */
  it('sums satang exactly, past the point a number stops being able to', () => {
    const focus = slipQueueFocus([slip(9_007_199_254_740_992n), slip(1n)]);

    expect(focus.claimedThbMinor).toBe(9_007_199_254_740_993n);
  });

  /**
   * ⭐ A full page is a floor, not a total.
   *
   * `GET /payments/slips` caps at `limit` and the overview's card counts the whole `submitted`
   * clause. Without อย่างน้อย the two screens disagree by however many rows the cap swallowed,
   * and neither of them says so.
   */
  it('turns the count into a floor when the API returned a full page', () => {
    const focus = slipQueueFocus([slip(150_000n), slip(50_000n)], true);

    expect(focus.headlineTh).toBe('อย่างน้อย 2 สลิปรอตรวจ รวม ฿2,000');
    expect(focus.detailTh).toBe(
      'ยอดที่ลูกค้าแจ้ง ยังไม่ตัดเข้างวดจนกว่าจะมีคนรับสลิป · นับเฉพาะรายการที่ API ส่งมา — ตัวเลขบนภาพรวมคือยอดจริงทั้งหมด',
    );
  });

  it('distinguishes a count whose sentence is a substring of another', () => {
    /* The `toContain` trap, pinned: 2 and 12 must not be mistakable for one another. */
    expect(slipQueueFocus([slip(100n), slip(100n)]).headlineTh).toBe('2 สลิปรอตรวจ รวม ฿2');
    expect(
      slipQueueFocus(Array.from({ length: 12 }, () => slip(100n))).headlineTh,
    ).toBe('12 สลิปรอตรวจ รวม ฿12');
  });

  it('does not reorder or otherwise disturb the list it was handed', () => {
    /* The queue arrives in the API's order and `slip-queue.tsx` renders that same array. */
    const slips = [slip(300n), slip(100n), slip(200n)];
    slipQueueFocus(slips);

    expect(slips.map((entry) => entry.amountThbMinor)).toEqual([300n, 100n, 200n]);
  });
});
