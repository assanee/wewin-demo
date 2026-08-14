import { describe, expect, it } from 'vitest';

import { approvalFocus, type CountedApprovalQueue } from './approval-focus';

/**
 * ⚠️ Every assertion compares a **whole string with `toBe`**, never `toContain`. The trap is
 * live in this file's own vocabulary: `'2 คำขอรอคุณตัดสิน'` is a substring of
 * `'12 คำขอรอคุณตัดสิน'`, so a containment assertion on the headline would pass for the wrong
 * number — which on this screen is the difference between an empty afternoon and a full one.
 */

const queue = (
  yours: number,
  withheld: { beyondYourAuthority?: number; yourOwnRequests?: number } = {},
  isTruncated = false,
): CountedApprovalQueue => ({
  approvals: Array.from({ length: yours }, (_, index) => index),
  withheld: {
    beyondYourAuthority: withheld.beyondYourAuthority ?? 0,
    yourOwnRequests: withheld.yourOwnRequests ?? 0,
  },
  isTruncated,
});

describe('approvalFocus', () => {
  it('counts only what this reader may decide', () => {
    const focus = approvalFocus(queue(3, { beyondYourAuthority: 4, yourOwnRequests: 1 }));

    expect(focus.yours).toBe(3);
    expect(focus.withheld).toBe(5);
    expect(focus.total).toBe(8);
    expect(focus.headlineTh).toBe('3 คำขอรอคุณตัดสิน');
  });

  it('reconciles with the dashboard when some requests are withheld', () => {
    /*
     * The overview's ใบเสนอราคารออนุมัติ card counts every pending row in the company. Without
     * this line the screen would say 3 beside a card saying 8 and neither would explain the gap.
     */
    const focus = approvalFocus(queue(3, { beyondYourAuthority: 5 }));

    expect(focus.detailTh).toBe('ทั้งระบบมี 8 คำขอที่ยังไม่ถูกตัดสิน');
  });

  it('drops the detail line when it would only repeat the headline', () => {
    /* Nothing withheld and no truncation: the total *is* the headline, said once. */
    const focus = approvalFocus(queue(3));

    expect(focus.headlineTh).toBe('3 คำขอรอคุณตัดสิน');
    expect(focus.detailTh).toBeNull();
  });

  it('says the queue is empty for you rather than empty, when the backlog is out of reach', () => {
    /*
     * ⭐ The state fail-closed produces: a role with no ceiling can refuse and approve nothing,
     * so every pending row lands in `beyondYourAuthority`. "ไม่มีคำขออนุมัติค้างอยู่ในระบบ" here
     * would be false, and would stop somebody going to find a colleague who can decide.
     */
    const focus = approvalFocus(queue(0, { beyondYourAuthority: 4 }));

    expect(focus.headlineTh).toBe('ไม่มีคำขอที่คุณตัดสินได้ตอนนี้');
    expect(focus.detailTh).toBe('ทั้งระบบมี 4 คำขอที่ยังไม่ถูกตัดสิน');
  });

  it('says nothing is waiting anywhere, calmly, when the whole company is clear', () => {
    const focus = approvalFocus(queue(0));

    expect(focus.total).toBe(0);
    expect(focus.headlineTh).toBe('ไม่มีคำขออนุมัติค้างอยู่ในระบบ');
    expect(focus.detailTh).toBeNull();
  });

  it('says the total is a floor when the read was truncated', () => {
    /* ⚠️ Stated even with nothing withheld — the cap alone makes the count partial. */
    expect(approvalFocus(queue(200, {}, true)).detailTh).toBe(
      'ทั้งระบบมี 200 คำขอที่ยังไม่ถูกตัดสิน — นับเฉพาะ 200 คำขอที่เก่าที่สุด',
    );
  });

  it('stays silent about a truncated read when there is nothing pending at all', () => {
    /* A cap on an empty result set says nothing; the headline is already the whole answer. */
    expect(approvalFocus(queue(0, {}, true)).detailTh).toBeNull();
  });

  it('distinguishes a count whose sentence is a substring of another', () => {
    /* The `toContain` trap, pinned: 2 and 12 must not be mistakable for one another. */
    expect(approvalFocus(queue(2)).headlineTh).toBe('2 คำขอรอคุณตัดสิน');
    expect(approvalFocus(queue(12)).headlineTh).toBe('12 คำขอรอคุณตัดสิน');
  });
});
