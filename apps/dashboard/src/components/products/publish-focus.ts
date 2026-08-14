/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The product editor's one primary statement: is what I changed live yet?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That is the question this screen exists for. Editing a product here is never editing what
 * customers see — a published document is frozen in Postgres and a trigger refuses to update
 * one — so the gap between "saved" and "live" is the single thing a person can get wrong, and
 * getting it wrong means either quoting a price nobody agreed to or believing a correction went
 * out when it did not.
 *
 * The screen answered it only by implication: three badges in a toolbar, and a diff list buried
 * inside the third of three Cards. This turns it into a sentence at `type-focal`.
 *
 * No React here — `apps/dashboard`'s vitest is `environment: 'node'`, so a `.test.tsx` is
 * **silently never collected** and a sentence assembled inside a component is one nothing can
 * prove.
 *
 * ── ⚠️ THE TWO PENDING COUNTS ARE NEVER ADDED TOGETHER ───────────────────────
 *
 * They measure different pairs of documents and they overlap:
 *
 *   `draftChangeCount` — the published document against **the draft document**. This is what
 *   pressing เผยแพร่ would change for a customer, and it is what `diffDocuments` returns.
 *
 *   `unpublishedFieldCount` — the published document against **the live `products` row**. This
 *   one exists because that row is *not* versioned: an edit to `pricePerSqm` is stored the
 *   moment it is made while quotes keep coming from the frozen figure. `unpublishedFields` is
 *   the server naming which ones.
 *
 * `diffFields` compares slug, skuPrefix, nameTh and categoryId, so the same field can be counted
 * by both. Summing them would report six pending changes where there are four, and a number a
 * reader can catch being wrong is worse than no number. So the headline is a **verdict** and the
 * detail line reports the two figures side by side, each labelled with what it measures.
 */

export interface PublishFacts {
  /** The version customers are being quoted from, or `null` if this was never published. */
  readonly publishedVersion: number | null;
  /** The editable version, or `null` when no draft is open. */
  readonly draftVersion: number | null;
  /** How many things publishing the draft would change for a customer. `null` with no draft. */
  readonly draftChangeCount: number | null;
  /** Product-row fields already saved that the frozen document does not carry. */
  readonly unpublishedFieldCount: number;
}

export interface PublishFocus {
  /** Whether anything a person has changed is still not visible to a customer. */
  readonly pending: boolean;
  /** The `type-focal` line — a verdict, never a bare number. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is already the whole answer. */
  readonly detailTh: string | null;
}

export function publishFocus(facts: PublishFacts): PublishFocus {
  const draftChanges = facts.draftChangeCount ?? 0;
  const pending = draftChanges > 0 || facts.unpublishedFieldCount > 0;

  if (facts.publishedVersion === null) {
    /*
     * Never published. `firstPublish` in `document-diff.ts` makes the same distinction and gives
     * the reason: an empty change list means "publishing changes nothing", and on a first publish
     * it changes everything. So this case cannot borrow the sentences below — there is no version
     * to be behind, and a customer sees no product at all.
     */
    return {
      pending,
      headlineTh: 'ลูกค้ายังไม่เห็นสินค้านี้',
      detailTh:
        facts.draftVersion === null
          ? 'ยังไม่เคยเผยแพร่ และยังไม่มีฉบับร่าง — ต้องเปิดฉบับร่างก่อนจึงจะแก้ได้'
          : `ฉบับร่างเวอร์ชัน ${facts.draftVersion} รอเผยแพร่เป็นครั้งแรก`,
    };
  }

  if (!pending) {
    return {
      pending,
      headlineTh: `ลูกค้าเห็นเวอร์ชัน ${facts.publishedVersion} ตรงกับที่แก้ไว้ทั้งหมด`,
      /*
       * An open draft that happens to match is worth saying: it is the state somebody reaches by
       * undoing their own edits, and without this line the open draft looks like unsent work.
       */
      detailTh:
        facts.draftVersion === null
          ? null
          : `ฉบับร่างเวอร์ชัน ${facts.draftVersion} ยังไม่ต่างจากที่เผยแพร่`,
    };
  }

  /*
   * ⚠️ "ยังเห็น" rather than "เห็น". The whole failure this screen guards against is somebody
   * reading the published version number as confirmation that their edit went out; the word that
   * stops that is the one saying the number is *stale*, not the number itself.
   */
  const parts: string[] = [];
  if (draftChanges > 0) parts.push(`ฉบับร่างต่างจากที่เผยแพร่ ${draftChanges} จุด`);
  if (facts.unpublishedFieldCount > 0) {
    parts.push(`แก้ไขแล้วยังไม่เผยแพร่ ${facts.unpublishedFieldCount} รายการ`);
  }

  return {
    pending,
    headlineTh: `ลูกค้ายังเห็นเวอร์ชัน ${facts.publishedVersion} ไม่ใช่สิ่งที่คุณแก้ไว้`,
    detailTh: parts.join(' · '),
  };
}
