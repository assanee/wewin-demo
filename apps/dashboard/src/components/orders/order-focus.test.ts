import { describe, expect, it } from 'vitest';

import { orderFocus } from './order-focus';
import { transitionForm, type PayloadKind } from './order-language';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. The trap is live here in two ways: the
 * numeral in 'ทำต่อได้ 1 อย่าง' sits inside 'ทำต่อได้ 11 อย่าง', and the no-tail sentence is a
 * **prefix of the with-tail one** — a containment assertion could not tell the two apart at
 * all, which is exactly the distinction these tests exist to hold.
 */

const kind = (payloadKind: PayloadKind) => ({ payloadKind });

/*
 * Pinned against `transitionForm` rather than hard-coded, so this file stays honest if the
 * table changes: `submit` is the kind the dashboard deliberately refuses to compose, and
 * `none`/`confirm_payment` are ones it offers.
 */
describe('the assumptions these tests rest on', () => {
  it('agrees with order-language about which kinds are offered', () => {
    expect(transitionForm('none').offered).toBe(true);
    expect(transitionForm('confirm_payment').offered).toBe(true);
    expect(transitionForm('submit').offered).toBe(false);
  });
});

describe('orderFocus', () => {
  it('calls an order with no available transitions terminal', () => {
    const focus = orderFocus([]);

    expect(focus.actionable).toBe(0);
    expect(focus.explained).toBe(0);
    expect(focus.nextTh).toBe('เป็นสถานะปลายทาง — ออเดอร์นี้เดินต่อไม่ได้แล้ว');
  });

  it('counts the moves it can post and points down the rail', () => {
    const focus = orderFocus([kind('none'), kind('confirm_payment')]);

    expect(focus.actionable).toBe(2);
    expect(focus.explained).toBe(0);
    expect(focus.nextTh).toBe('ทำต่อได้ 2 อย่าง — ปุ่มอยู่ที่ปลายเส้นด้านล่าง');
  });

  it('adds the ones it cannot compose as a tail rather than folding them into the count', () => {
    const focus = orderFocus([kind('none'), kind('submit')]);

    expect(focus.actionable).toBe(1);
    expect(focus.explained).toBe(1);
    expect(focus.nextTh).toBe(
      'ทำต่อได้ 1 อย่าง — ปุ่มอยู่ที่ปลายเส้นด้านล่าง และอีก 1 ทางที่แดชบอร์ดรุ่นนี้ยังทำให้ไม่ได้',
    );
  });

  it('never says an order is terminal when the API offered moves it cannot post', () => {
    /*
     * The distinction the whole module exists for: `offered: false` is "this build cannot build
     * a body", not "you may not". Calling that state terminal would be the one wrong answer.
     */
    const focus = orderFocus([kind('submit')]);

    expect(focus.actionable).toBe(0);
    expect(focus.explained).toBe(1);
    expect(focus.nextTh).toBe(
      'มี 1 ทางที่ API เปิดไว้ แต่แดชบอร์ดรุ่นนี้ยังทำให้ไม่ได้ — เหตุผลอยู่ที่ปลายเส้นด้านล่าง',
    );
    expect(focus.nextTh).not.toBe('เป็นสถานะปลายทาง — ออเดอร์นี้เดินต่อไม่ได้แล้ว');
  });

  it('treats a payload kind from a newer API as explained, not actionable', () => {
    /*
     * `transitionForm` refuses an unrecognised kind out loud. An order carrying only such a
     * move must not read as terminal — that is how a dashboard tells somebody work has stopped
     * when in fact the dashboard is simply out of date.
     */
    const focus = orderFocus([{ payloadKind: 'ship_by_drone' as PayloadKind }]);

    expect(focus.actionable).toBe(0);
    expect(focus.explained).toBe(1);
    expect(focus.nextTh).toBe(
      'มี 1 ทางที่ API เปิดไว้ แต่แดชบอร์ดรุ่นนี้ยังทำให้ไม่ได้ — เหตุผลอยู่ที่ปลายเส้นด้านล่าง',
    );
  });

  it('distinguishes counts whose sentences contain one another', () => {
    /* 1 inside 11, and the no-tail sentence is a prefix of the with-tail one. */
    const one = orderFocus([kind('none')]);
    const oneWithTail = orderFocus([kind('none'), kind('submit')]);

    expect(one.nextTh).toBe('ทำต่อได้ 1 อย่าง — ปุ่มอยู่ที่ปลายเส้นด้านล่าง');
    expect(oneWithTail.nextTh).not.toBe(one.nextTh);
    expect(oneWithTail.nextTh.startsWith(one.nextTh)).toBe(true);
  });
});
