import { describe, expect, it } from 'vitest';

import { outboxFocus, type OutboxCounts } from './outbox-focus';

/**
 * What the outbox's `type-focal` line says, asserted as whole strings.
 *
 * ⚠️ `toBe` on the complete sentence, never `toContain`, and the reason is specific to Thai and to
 * these figures: `'3 ฉบับ'` is a substring of `'13 ฉบับ'`, so a containment assertion on a short
 * count passes against the wrong number. `overview-focus.test.ts` sets the same rule.
 *
 * ⚠️ This is a `.test.ts` and not a `.test.tsx` because `vitest.config.ts` runs
 * `environment: 'node'` — a `.tsx` here is **silently never collected**, so it would report green
 * for ever without running once.
 */

const counts = (over: Partial<OutboxCounts> = {}): OutboxCounts => ({
  dead: 0,
  suppressed: 0,
  stuckSending: 0,
  ...over,
});

describe('outboxFocus', () => {
  it('says nothing is stalled when nothing is', () => {
    const focus = outboxFocus(counts());

    expect(focus.stalled).toBe(0);
    expect(focus.headlineTh).toBe('ไม่มีข้อความที่ค้างส่งไม่ถึงลูกค้า');
    expect(focus.detailTh).toBeNull();
  });

  it('still names unaddressable messages while everything else is calm', () => {
    /*
     * The case the appended clause exists for. `suppressed` is undelivered mail that no button on
     * this screen can fix, so a headline about retryable failures reads as "all clear" beside it —
     * and a version of this clause that only spoke during an incident would be silent for exactly
     * as long as nothing else was wrong.
     */
    const focus = outboxFocus(counts({ suppressed: 2 }));

    expect(focus.stalled).toBe(0);
    expect(focus.headlineTh).toBe('ไม่มีข้อความที่ค้างส่งไม่ถึงลูกค้า');
    expect(focus.detailTh).toBe(
      'อีก 2 ฉบับไม่มีที่อยู่ให้ส่งมาตั้งแต่แรก ส่งซ้ำไม่ได้ — ต้องไปหาเบอร์หรืออีเมลของลูกค้ามาก่อน',
    );
  });

  it('counts dead messages as known non-delivery', () => {
    const focus = outboxFocus(counts({ dead: 3 }));

    expect(focus.stalled).toBe(3);
    expect(focus.headlineTh).toBe('3 ข้อความที่ลูกค้าไม่ได้รับ และระบบเลิกส่งไปแล้ว');
    expect(focus.detailTh).toBe('ลองส่งครบทุกครั้งที่ตั้งไว้แล้วและไม่ถึง กดส่งซ้ำได้ที่รายการด้านล่าง');
  });

  it('does not claim a stuck message failed to arrive — only that nothing will retry it', () => {
    /*
     * ⭐ The one overclaim available on this screen. A worker that died mid-send may have died
     * before the provider was called or after it answered, so `ลูกค้าไม่ได้รับ` about a stuck row
     * asserts something nobody here knows. The stuck-only headline therefore says the system has
     * stopped, not that the customer is uninformed.
     */
    const focus = outboxFocus(counts({ stuckSending: 4 }));

    expect(focus.stalled).toBe(4);
    expect(focus.headlineTh).toBe('4 ข้อความค้างอยู่กลางทาง และไม่มีอะไรมาสะสางให้เอง');
    expect(focus.detailTh).toBe(
      'ตัวส่งหยุดกลางคัน ไม่มีตัวจับเวลาใดมาลองใหม่ให้ และหน้านี้บอกไม่ได้ว่าฉบับไหนออกไปแล้วบ้าง',
    );
  });

  it('adds the two stalled kinds together and keeps their sentences apart', () => {
    const focus = outboxFocus(counts({ dead: 2, stuckSending: 1 }));

    expect(focus.stalled).toBe(3);
    expect(focus.headlineTh).toBe('3 ข้อความที่ระบบหยุดส่งไปแล้ว โดยที่ยังไม่ถึงลูกค้า');
    expect(focus.detailTh).toBe(
      'ส่งไม่สำเร็จ 2 ฉบับ — ลองส่งครบทุกครั้งที่ตั้งไว้แล้วและไม่ถึง กดส่งซ้ำได้ที่รายการด้านล่าง · ' +
        'ค้างในสถานะกำลังส่ง 1 ฉบับ — ตัวส่งหยุดกลางคัน ไม่มีตัวจับเวลาใดมาลองใหม่ให้ และหน้านี้บอกไม่ได้ว่าฉบับไหนออกไปแล้วบ้าง',
    );
  });

  it('leaves suppressed out of the headline count on purpose', () => {
    /*
     * ⚠️ The load-bearing assertion of this file: 5 undelivered messages, and the headline says 2.
     * Retrying a suppressed row would fail identically — there was never an address — so one
     * total covering all three would promise one action for two different jobs. It is stated in
     * its own clause instead, which the detail assertion here pins.
     */
    const focus = outboxFocus(counts({ dead: 2, suppressed: 3 }));

    expect(focus.stalled).toBe(2);
    expect(focus.headlineTh).toBe('2 ข้อความที่ลูกค้าไม่ได้รับ และระบบเลิกส่งไปแล้ว');
    expect(focus.detailTh).toBe(
      'ลองส่งครบทุกครั้งที่ตั้งไว้แล้วและไม่ถึง กดส่งซ้ำได้ที่รายการด้านล่าง · ' +
        'อีก 3 ฉบับไม่มีที่อยู่ให้ส่งมาตั้งแต่แรก ส่งซ้ำไม่ได้ — ต้องไปหาเบอร์หรืออีเมลของลูกค้ามาก่อน',
    );
  });
});
