import { describe, expect, it } from 'vitest';

import { publishFocus, type PublishFacts } from './publish-focus';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain`. Live traps in this file's own vocabulary:
 * `'ลูกค้ายังเห็นเวอร์ชัน 1 ไม่ใช่สิ่งที่คุณแก้ไว้'` is **not** distinguishable from the v11
 * sentence by containment in the other direction, and `'ต่างจากที่เผยแพร่ 2 จุด'` sits inside
 * `'ต่างจากที่เผยแพร่ 12 จุด'`. Both would pass a containment assertion for the wrong version.
 */

const facts = (over: Partial<PublishFacts> = {}): PublishFacts => ({
  publishedVersion: 3,
  draftVersion: null,
  draftChangeCount: null,
  unpublishedFieldCount: 0,
  ...over,
});

describe('publishFocus', () => {
  it('confirms in words that what is live matches what was edited', () => {
    const focus = publishFocus(facts());

    expect(focus.pending).toBe(false);
    expect(focus.headlineTh).toBe('ลูกค้าเห็นเวอร์ชัน 3 ตรงกับที่แก้ไว้ทั้งหมด');
    expect(focus.detailTh).toBeNull();
  });

  it('accounts for an open draft that happens to match', () => {
    /* Reached by undoing your own edits. Without this line the open draft looks like unsent work. */
    const focus = publishFocus(facts({ draftVersion: 4, draftChangeCount: 0 }));

    expect(focus.pending).toBe(false);
    expect(focus.detailTh).toBe('ฉบับร่างเวอร์ชัน 4 ยังไม่ต่างจากที่เผยแพร่');
  });

  it('says the live version is stale rather than just naming it', () => {
    /*
     * ⭐ The failure this screen exists to prevent is reading the published version number as
     * confirmation that an edit went out. "ยังเห็น … ไม่ใช่สิ่งที่คุณแก้ไว้" is the sentence that
     * stops it; the number alone is what caused it.
     */
    const focus = publishFocus(facts({ draftVersion: 4, draftChangeCount: 5 }));

    expect(focus.pending).toBe(true);
    expect(focus.headlineTh).toBe('ลูกค้ายังเห็นเวอร์ชัน 3 ไม่ใช่สิ่งที่คุณแก้ไว้');
    expect(focus.detailTh).toBe('ฉบับร่างต่างจากที่เผยแพร่ 5 จุด');
  });

  it('reports the two pending counts side by side and never added together', () => {
    /*
     * ⚠️ 2 + 3 is not 5 here. `draftChangeCount` measures the published document against the
     * draft; `unpublishedFieldCount` measures it against the live `products` row, and
     * `diffFields` compares slug/skuPrefix/nameTh/categoryId — so the same field can land in
     * both. A summed "5 pending changes" is a number a reader can catch being wrong.
     */
    const focus = publishFocus(
      facts({ draftVersion: 4, draftChangeCount: 2, unpublishedFieldCount: 3 }),
    );

    expect(focus.detailTh).toBe('ฉบับร่างต่างจากที่เผยแพร่ 2 จุด · แก้ไขแล้วยังไม่เผยแพร่ 3 รายการ');
  });

  it('catches a saved product-row edit even when no draft is open at all', () => {
    /*
     * ⭐ The state nothing else on the screen says out loud: `products` is not versioned, so a
     * price edit is stored the moment it is made while quotes keep coming from the frozen figure.
     * With no draft there is no diff to look at, and the badge was the only witness.
     */
    const focus = publishFocus(facts({ unpublishedFieldCount: 1 }));

    expect(focus.pending).toBe(true);
    expect(focus.headlineTh).toBe('ลูกค้ายังเห็นเวอร์ชัน 3 ไม่ใช่สิ่งที่คุณแก้ไว้');
    expect(focus.detailTh).toBe('แก้ไขแล้วยังไม่เผยแพร่ 1 รายการ');
  });

  it('does not claim a version is stale when there has never been one', () => {
    const focus = publishFocus(facts({ publishedVersion: null, draftVersion: 1, draftChangeCount: 7 }));

    expect(focus.headlineTh).toBe('ลูกค้ายังไม่เห็นสินค้านี้');
    expect(focus.detailTh).toBe('ฉบับร่างเวอร์ชัน 1 รอเผยแพร่เป็นครั้งแรก');
  });

  it('tells a reader with neither a draft nor a publish what to do first', () => {
    const focus = publishFocus(facts({ publishedVersion: null }));

    expect(focus.pending).toBe(false);
    expect(focus.headlineTh).toBe('ลูกค้ายังไม่เห็นสินค้านี้');
    expect(focus.detailTh).toBe('ยังไม่เคยเผยแพร่ และยังไม่มีฉบับร่าง — ต้องเปิดฉบับร่างก่อนจึงจะแก้ได้');
  });

  it('distinguishes versions and counts whose sentences are substrings of one another', () => {
    /* The `toContain` trap, pinned on the version and on the change count. */
    expect(publishFocus(facts({ publishedVersion: 1, draftChangeCount: 1 })).headlineTh).toBe(
      'ลูกค้ายังเห็นเวอร์ชัน 1 ไม่ใช่สิ่งที่คุณแก้ไว้',
    );
    expect(publishFocus(facts({ publishedVersion: 11, draftChangeCount: 1 })).headlineTh).toBe(
      'ลูกค้ายังเห็นเวอร์ชัน 11 ไม่ใช่สิ่งที่คุณแก้ไว้',
    );
    expect(publishFocus(facts({ draftChangeCount: 2 })).detailTh).toBe('ฉบับร่างต่างจากที่เผยแพร่ 2 จุด');
    expect(publishFocus(facts({ draftChangeCount: 12 })).detailTh).toBe(
      'ฉบับร่างต่างจากที่เผยแพร่ 12 จุด',
    );
  });
});
