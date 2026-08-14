import { describe, expect, it } from 'vitest';

import { refundFocus, type PayableRefund } from './refund-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. `'฿4,000 อนุมัติแล้วแต่ยังไม่ได้จ่าย'` is a
 * substring of `'฿14,000 อนุมัติแล้วแต่ยังไม่ได้จ่าย'`, so a containment assertion here would
 * pass for a debt ten thousand baht larger than the one it meant.
 */

const refund = (amountThbMinor: bigint): PayableRefund => ({ amountThbMinor });

describe('refundFocus', () => {
  /**
   * ⭐ The state that must not be folded into zero.
   *
   * A failed count and an empty queue are the same shape and opposite news. "ไม่มีเงินค้างจ่าย"
   * printed because a request 500'd is how a company stops chasing a payment it still owes.
   */
  it('admits it does not know, rather than reporting nothing owed', () => {
    const focus = refundFocus(null);

    expect(focus.count).toBeNull();
    expect(focus.totalThbMinor).toBeNull();
    expect(focus.headlineTh).toBe('ยังไม่ทราบยอดที่อนุมัติแล้วแต่ยังไม่ได้จ่าย');
    expect(focus.detailTh).toBe('นับยอดค้างจ่ายไม่สำเร็จ — ตารางด้านล่างคือหมวดที่เลือกไว้เท่านั้น');
  });

  it('says nothing is owed, calmly, when the payable queue is empty', () => {
    const focus = refundFocus([]);

    expect(focus.count).toBe(0);
    expect(focus.totalThbMinor).toBe(0n);
    expect(focus.headlineTh).toBe('ไม่มีเงินที่อนุมัติแล้วและยังไม่ได้จ่าย');
    expect(focus.detailTh).toBe('คำขอที่อนุมัติแล้วถูกบันทึกว่าจ่ายครบทุกรายการ');
  });

  it('leads with the amount, because the amount is what nobody could see before', () => {
    const focus = refundFocus([refund(400_000n), refund(150_000n)]);

    expect(focus.totalThbMinor).toBe(550_000n);
    expect(focus.headlineTh).toBe('฿5,500 อนุมัติแล้วแต่ยังไม่ได้จ่าย');
    expect(focus.detailTh).toBe('2 รายการ — เงินที่บริษัทรับปากลูกค้าไว้แล้วและยังไม่ออกจากบัญชี');
  });

  it('says so when the page is full and the total is therefore partial', () => {
    const focus = refundFocus([refund(400_000n)], true);

    expect(focus.detailTh).toBe(
      '1 รายการ — เงินที่บริษัทรับปากลูกค้าไว้แล้วและยังไม่ออกจากบัญชี · นับเฉพาะรายการที่ API ส่งมา ยอดจริงอาจสูงกว่านี้',
    );
  });

  /**
   * ⚠️ satang, summed as `bigint`. `9007199254740992n` is `2 ** 53`: a `number` accumulator adds
   * the satang beside it and returns the same value it started with.
   */
  it('sums satang exactly, past the point a number stops being able to', () => {
    expect(refundFocus([refund(9_007_199_254_740_992n), refund(1n)]).totalThbMinor).toBe(
      9_007_199_254_740_993n,
    );
  });

  it('distinguishes an amount whose sentence is a substring of another', () => {
    expect(refundFocus([refund(400_000n)]).headlineTh).toBe('฿4,000 อนุมัติแล้วแต่ยังไม่ได้จ่าย');
    expect(refundFocus([refund(1_400_000n)]).headlineTh).toBe('฿14,000 อนุมัติแล้วแต่ยังไม่ได้จ่าย');
  });

  it('does not disturb the list it was handed', () => {
    const payable = [refund(300n), refund(100n)];
    refundFocus(payable);

    expect(payable.map((entry) => entry.amountThbMinor)).toEqual([300n, 100n]);
  });
});
