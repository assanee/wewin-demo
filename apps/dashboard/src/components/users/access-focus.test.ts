import { describe, expect, it } from 'vitest';

import { accessFocus, type AccessStatus, type CountedUser } from './access-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. The trap is live twice over in this file's
 * vocabulary: `'2 บัญชีเข้าระบบได้ จาก 15'` is a substring of `'12 บัญชีเข้าระบบได้ จาก 15'`, and
 * `'ถูกระงับ 1'` is a substring of `'ถูกระงับ 12'`. A containment assertion would pass for the
 * wrong count in both directions.
 */

const users = (...statuses: readonly AccessStatus[]): readonly CountedUser[] =>
  statuses.map((status) => ({ status }));

const repeat = (status: AccessStatus, times: number): readonly AccessStatus[] =>
  Array.from({ length: times }, () => status);

describe('accessFocus', () => {
  it('says so plainly when nothing has been taken away', () => {
    const focus = accessFocus(users('active', 'active', 'active'));

    expect(focus.total).toBe(3);
    expect(focus.blocked).toBe(0);
    expect(focus.headlineTh).toBe('3 บัญชี เข้าระบบได้ทั้งหมด');
    expect(focus.detailTh).toBeNull();
  });

  it('leads with how many can still sign in, out of how many exist', () => {
    const focus = accessFocus(users('active', 'active', 'suspended', 'closed'));

    expect(focus.active).toBe(2);
    expect(focus.blocked).toBe(2);
    expect(focus.headlineTh).toBe('2 บัญชีเข้าระบบได้ จาก 4');
  });

  it('names the kind of blocked, because the kind decides whether anything can be done', () => {
    /*
     * ⭐ A suspension is reversible from the button in this very table; a closure and an erasure
     * are not. Collapsing the three into one number would send an administrator looking for a
     * ปลดระงับ button that does not exist for two of them.
     */
    const focus = accessFocus(users('active', 'suspended', 'suspended', 'closed', 'erased'));

    expect(focus.detailTh).toBe('ถูกระงับ 2 · ปิดบัญชีแล้ว 1 · ลบข้อมูลแล้ว 1');
  });

  it('omits a status nobody is in rather than printing a zero', () => {
    const focus = accessFocus(users('active', 'erased'));

    expect(focus.detailTh).toBe('ลบข้อมูลแล้ว 1');
  });

  it('keeps the order of recourse regardless of which status is commonest', () => {
    /*
     * ⚠️ Sorting by count would reorder this line every time somebody was suspended. A line
     * people are meant to skim has to say its parts in the same place every day.
     */
    const focus = accessFocus(users(...repeat('erased', 5), 'suspended', 'active'));

    expect(focus.detailTh).toBe('ถูกระงับ 1 · ลบข้อมูลแล้ว 5');
  });

  it('handles a company where nobody can sign in at all', () => {
    /* Not an error state: every account suspended is exactly what a shutdown looks like. */
    const focus = accessFocus(users('suspended', 'suspended'));

    expect(focus.active).toBe(0);
    expect(focus.headlineTh).toBe('0 บัญชีเข้าระบบได้ จาก 2');
    expect(focus.detailTh).toBe('ถูกระงับ 2');
  });

  it('says the list is empty rather than claiming zero of zero can sign in', () => {
    const focus = accessFocus([]);

    expect(focus.headlineTh).toBe('ยังไม่มีบัญชีผู้ใช้ในระบบ');
    expect(focus.detailTh).toBeNull();
  });

  it('distinguishes counts whose sentences are substrings of one another', () => {
    /* The `toContain` trap, pinned on both halves of the sentence. */
    expect(accessFocus(users(...repeat('active', 2), ...repeat('suspended', 13))).headlineTh).toBe(
      '2 บัญชีเข้าระบบได้ จาก 15',
    );
    expect(accessFocus(users(...repeat('active', 12), ...repeat('suspended', 3))).headlineTh).toBe(
      '12 บัญชีเข้าระบบได้ จาก 15',
    );
    expect(accessFocus(users('active', ...repeat('suspended', 12))).detailTh).toBe('ถูกระงับ 12');
  });
});
