import { describe, expect, it } from 'vitest';

import {
  groupSuppressed,
  suppressionGroup,
  NOTHING_TO_SEND_DESCRIPTION_TH,
  NOTHING_TO_SEND_TITLE_TH,
  SUPPRESSED_FIGURE_LABEL_TH,
  UNKNOWN_DESCRIPTION_TH,
  UNKNOWN_TITLE_TH,
  UNREACHABLE_DESCRIPTION_TH,
  UNREACHABLE_TITLE_TH,
} from './outbox-suppression';

/**
 * The outbox's suppression vocabulary.
 *
 * ⚠️ A `.test.ts` and not a `.test.tsx`: `vitest.config.ts` runs `environment: 'node'` and a
 * `.tsx` here is **silently never collected**. That is not a footnote on this file — it is the
 * reason the sentences under test moved out of `outbox-screen.tsx` at all, because the wrong
 * ones sat there for a whole round with a green suite over them.
 *
 * ⚠️ `toBe` on whole strings, never `toContain`, for the reason `outbox-focus.test.ts` gives.
 */

const row = (reason: string | null): { readonly id: string; readonly reason: string | null } => ({
  id: reason ?? 'null',
  reason,
});

describe('suppressionGroup', () => {
  it('files every reason that means nobody could be written to under one group', () => {
    expect(suppressionGroup('no_contact_channel')).toBe('unreachable');
    expect(suppressionGroup('channel_disabled')).toBe('unreachable');
    expect(suppressionGroup('recipient_erased')).toBe('unreachable');
  });

  it('⭐ does not file a settled balance as a contact-details problem', () => {
    /*
     * The defect this module exists for. `balance_settled` is a customer who paid before the
     * worker drained the queued reminder — undelivered, correct, and nothing to chase. Reading it
     * as `unreachable` is what put it under ไม่มีที่อยู่ให้ส่ง and sent somebody looking for an
     * address that was never the problem.
     */
    expect(suppressionGroup('balance_settled')).toBe('nothingToSend');
    expect(suppressionGroup('balance_settled')).not.toBe('unreachable');
  });

  it('⭐ claims nothing about a reason this build has never seen', () => {
    /*
     * The fail-closed arm. A reason added by a later migration must not inherit either group's
     * sentence: `unreachable` would send somebody hunting again, and `nothingToSend` would say
     * "nothing is wrong" about a message that may not have arrived.
     */
    expect(suppressionGroup('some_future_reason')).toBe('unknown');
    expect(suppressionGroup(null)).toBe('unknown');
  });
});

describe('groupSuppressed', () => {
  it('⭐ keeps a settled balance out of the section that tells staff to find an address', () => {
    const grouped = groupSuppressed([
      row('no_contact_channel'),
      row('balance_settled'),
      row('recipient_erased'),
      row('future_thing'),
      row(null),
    ]);

    expect(grouped.unreachable.map((each) => each.reason)).toEqual([
      'no_contact_channel',
      'recipient_erased',
    ]);
    expect(grouped.nothingToSend.map((each) => each.reason)).toEqual(['balance_settled']);
    expect(grouped.unknown.map((each) => each.reason)).toEqual(['future_thing', null]);
  });

  it('preserves the newest-first order the API sorted each list into', () => {
    /* Grouping rows already in hand must not become a re-sort nobody asked for. */
    const grouped = groupSuppressed([
      { id: 'a', reason: 'no_contact_channel' },
      { id: 'b', reason: 'channel_disabled' },
      { id: 'c', reason: 'no_contact_channel' },
    ]);

    expect(grouped.unreachable.map((each) => each.id)).toEqual(['a', 'b', 'c']);
  });

  it('gives every group an empty list rather than an absent one', () => {
    const grouped = groupSuppressed([]);

    expect(grouped.unreachable).toEqual([]);
    expect(grouped.nothingToSend).toEqual([]);
    expect(grouped.unknown).toEqual([]);
  });
});

describe('the sentences', () => {
  it('⭐ never sends the reader after a contact detail except where that is the reason', () => {
    /*
     * ⚠️ The load-bearing assertion of this file, and the one that would have caught the round
     * that shipped the defect: the two sentences shown over a settled balance, and the one shown
     * over a reason nobody here recognises, must not instruct anybody to go and obtain an address.
     * `ที่อยู่` is the word the section above uses for exactly that instruction.
     */
    expect(NOTHING_TO_SEND_TITLE_TH).not.toContain('ที่อยู่');
    expect(NOTHING_TO_SEND_DESCRIPTION_TH).not.toContain('ที่อยู่');
    expect(NOTHING_TO_SEND_DESCRIPTION_TH).not.toContain('เบอร์');
    expect(UNKNOWN_DESCRIPTION_TH).not.toContain('ที่อยู่');
    /* And the aggregate label over a count that mixes both kinds states neither cause. */
    expect(SUPPRESSED_FIGURE_LABEL_TH).not.toContain('ที่อยู่');
  });

  it('⭐ leaves the contact section its instruction, word for word', () => {
    /*
     * The other half. Softening this to cover a settled balance would have cost the rows it is
     * genuinely about their remedy — so the split had to leave it untouched, and this pins that.
     */
    expect(UNREACHABLE_TITLE_TH).toBe('ไม่มีที่อยู่ให้ส่ง — ส่งซ้ำไม่ได้');
    expect(UNREACHABLE_DESCRIPTION_TH).toBe(
      'ตั้งแต่แรกก็ไม่มีช่องทางติดต่อ ส่งซ้ำก็ล้มเหมือนเดิม — ต้องไปหาที่อยู่หรือเบอร์ของลูกค้ามาก่อน',
    );
  });

  it('says what a settled balance actually was, in the words this app already uses', () => {
    expect(NOTHING_TO_SEND_TITLE_TH).toBe('ไม่มีเรื่องต้องแจ้งแล้ว — ส่งซ้ำไม่ได้');
    expect(NOTHING_TO_SEND_DESCRIPTION_TH).toBe(
      'พอถึงคิวส่ง ก็ไม่มีเรื่องต้องแจ้งแล้ว — ลูกค้าชำระครบแล้วก่อนที่ข้อความแจ้งยอดคงค้างจะออกไป ' +
        'ไม่ใช่ปัญหาเรื่องช่องทางติดต่อ และไม่มีอะไรต้องตามต่อ',
    );
  });

  it('leaves an unrecognised reason without a cause or a remedy', () => {
    expect(UNKNOWN_TITLE_TH).toBe('ไม่ได้ส่ง — เหตุผลที่หน้านี้ยังไม่รู้จัก');
    expect(UNKNOWN_DESCRIPTION_TH).toBe(
      'ระบบปิดรายการเหล่านี้ไปโดยไม่ได้ส่ง ด้วยเหตุผลที่หน้านี้ยังไม่มีคำอธิบายให้ — ' +
        'อ่านรหัสในคอลัมน์เหตุผลก่อน แล้วค่อยตัดสินว่าต้องทำอะไรต่อ',
    );
  });

  it('labels the mixed total with the status rather than with one of its causes', () => {
    expect(SUPPRESSED_FIGURE_LABEL_TH).toBe('ไม่ได้ส่ง');
  });
});
