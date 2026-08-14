/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The image library's one primary statement: what is in it, and what can go.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `media-library.tsx`'s header already names the four questions this screen exists to answer —
 * *"is this the right file, is it big enough, is anything using it, can it go"* — and the third
 * and fourth are the ones a person opens the library **for**. They were also the ones the screen
 * whispered: the citation line rendered muted, at the bottom of each row, underneath the alt-text
 * box, and the count of how many files were sitting there unreferenced existed nowhere.
 *
 * So the sentence at the top is the library's state, and `frozen` — the thing that decides
 * whether ลบ is even offered — is what it counts by.
 *
 * ── ⚠️ The three buckets, and why they are three and not two ─────────────────
 *
 *     cited     `usage.frozen` non-empty. A published document points at these bytes and a
 *               customer was shown them, so **the delete button does not exist** for this row.
 *     inDrafts  cited only by drafts. Deleting is allowed and leaves a draft pointing at
 *               nothing — visibly, in the product editor, which is the point.
 *     unused    nobody references it. This is the only bucket that can simply go.
 *
 * Folding the middle one into either neighbour would make the arithmetic on screen not add up,
 * and a reader who subtracts two numbers and gets a third that is not the total stops trusting
 * all three.
 *
 * Pure, in a `.ts`, because vitest here is `environment: 'node'` and a `.test.tsx` is **silently
 * never collected**.
 */

/** Just enough of a stored object to bucket it. `media-api.ts`'s `MediaObject` satisfies this. */
export interface CountedMedia {
  readonly usage: {
    readonly frozen: readonly unknown[];
    readonly drafts: readonly unknown[];
  };
}

export interface MediaFocus {
  /** ⚠️ What has been **loaded**, not what the library holds. See `moreToLoad`. */
  readonly shown: number;
  readonly cited: number;
  readonly inDrafts: number;
  readonly unused: number;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is the whole answer. */
  readonly detailTh: string | null;
}

/**
 * @param moreToLoad `nextCursor !== null` — the library is paginated and the cursor is the only
 *   thing that knows there is more. ⚠️ Without this, "42 รูปในคลัง" is a claim about a library
 *   that has 900 in it, made confidently by a screen that has seen the first page.
 */
export function mediaFocus(items: readonly CountedMedia[], moreToLoad: boolean): MediaFocus {
  const cited = items.filter((item) => item.usage.frozen.length > 0).length;
  const inDrafts = items.filter(
    (item) => item.usage.frozen.length === 0 && item.usage.drafts.length > 0,
  ).length;
  const unused = items.length - cited - inDrafts;

  if (items.length === 0) {
    return {
      shown: 0,
      cited: 0,
      inDrafts: 0,
      unused: 0,
      headlineTh: 'ยังไม่มีรูปในคลัง',
      detailTh: 'อัปโหลดรูปแรกเพื่อนำไปใช้เป็นภาพหลักของสินค้า',
    };
  }

  return {
    shown: items.length,
    cited,
    inDrafts,
    unused,
    headlineTh: moreToLoad
      ? `${String(items.length)} รูปที่โหลดมาแล้ว`
      : `${String(items.length)} รูปในคลัง`,
    detailTh: [
      ...(cited === 0 ? [] : [`ลบไม่ได้ ${String(cited)} — มีเวอร์ชันที่เผยแพร่แล้วอ้างอิงอยู่`]),
      ...(inDrafts === 0 ? [] : [`อยู่ในฉบับร่าง ${String(inDrafts)}`]),
      ...(unused === 0 ? [] : [`ไม่มีใครใช้ ${String(unused)}`]),
      ...(moreToLoad ? ['ยังโหลดไม่ครบ — กดโหลดเพิ่มเพื่อนับทั้งคลัง'] : []),
    ].join(' · '),
  };
}
