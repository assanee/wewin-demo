/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The catalogue's one primary statement: what customers cannot buy right now.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `available` is the one field in this whole area that reaches a customer **without a publish**.
 * Everything else here — a group's name, a value's code, the order they sit in — only becomes
 * real when somebody publishes a product version. Switching a value off is live immediately, on
 * every published version, for everybody.
 *
 * That makes ปิดการขาย the dangerous control on the screen, and the count of values currently
 * switched off the one number nobody goes looking for: the most likely way it becomes permanent
 * is somebody turning a value off for an afternoon and the afternoon ending.
 *
 * ── ⚠️ This replaced a colour, and the colour was the wrong tool ─────────────
 *
 * The first pass at this screen made the count prominent by painting it
 * `text-amber-700 dark:text-amber-500` inside an otherwise muted sentence. Two objections, and
 * the second is the one that matters:
 *
 *   ⓵ The house does not use colour for emphasis. `globals.css` caps the lime accent at two
 *      places per screen and keeps shadcn's `--primary` neutral **on purpose**, and the brief
 *      for this work says hierarchy comes from type, space and weight. An amber that needs two
 *      spellings to survive both themes is a third palette entry nobody agreed to.
 *   ⓶ It was colour standing in for a focal point. The count stayed at `text-sm` inside a
 *      muted paragraph and got *tinted* instead of promoted — which is emphasis you can only
 *      see once you are already reading the sentence, on the one number the comment above it
 *      says nobody reads. Making it the `type-focal` statement is the fix the screen actually
 *      needed; the tint was a way of not making it.
 *
 * Lives in a `.ts` because `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx`
 * is **silently never collected** — a rule written into a component is a rule with no test.
 */

/** Just enough of a value to count it. `OptionValueWire` structurally satisfies this. */
export interface CountableValue {
  readonly available: boolean;
}

/** Just enough of a group. `OptionGroupWire` structurally satisfies this. */
export interface CountableGroup {
  readonly values: readonly CountableValue[];
}

export interface OptionGroupFocus {
  readonly groups: number;
  readonly values: number;
  /** Values switched off — live on every published version the moment they change. */
  readonly unavailable: number;
  /** The `type-focal` line. A statement about the catalogue, not a label. */
  readonly headlineTh: string;
  /** The caption under it. Never null: the totals are always worth stating. */
  readonly detailTh: string;
}

export function optionGroupFocus(groups: readonly CountableGroup[]): OptionGroupFocus {
  const values = groups.flatMap((group) => group.values);
  const unavailable = values.filter((value) => !value.available).length;

  return {
    groups: groups.length,
    values: values.length,
    unavailable,
    /*
     * Two headlines, and the calm one is not "0 รายการปิดการขายอยู่".
     *
     * A zero here is the normal, healthy state of a catalogue and should read as one — the same
     * argument `overviewFocus` makes for an empty queue. Printing a zero invites somebody to
     * check what it means; saying ทุกตัวเลือกเปิดขายอยู่ answers it.
     */
    headlineTh:
      unavailable === 0
        ? 'ทุกตัวเลือกเปิดขายอยู่'
        : `${unavailable} ตัวเลือกปิดการขายอยู่`,
    /*
     * ⚠️ The consequence, not just the totals — and stated only in the non-zero branch, because
     * it is a warning rather than a description. "ลูกค้าเลือกไม่ได้ทันทีทุกเวอร์ชันที่เผยแพร่แล้ว"
     * is the fact that makes the number worth a focal point: it is the only edit in this area
     * that does not wait for a publish.
     */
    detailTh:
      unavailable === 0
        ? `${groups.length} กลุ่ม · ${values.length} ตัวเลือก`
        : `ลูกค้าเลือกไม่ได้ทันที ทุกเวอร์ชันที่เผยแพร่แล้ว — จาก ${groups.length} กลุ่ม · ${values.length} ตัวเลือก`,
  };
}
