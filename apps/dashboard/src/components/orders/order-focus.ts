import { transitionForm, type PayloadKind } from './order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ An order's one primary statement: where it is, and whether it can move.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The status used to be a `Badge` beside the title — physically smaller than the three card
 * headings below it — and what could be done next lived at the bottom of the third card. This
 * derives the caption that now sits under the status at `type-focal`.
 *
 * ── ⚠️ This names the moves; it does not offer them ──────────────────────────
 *
 * The buttons stay at the terminus of the rail in `order-spine.tsx`, which put them there on
 * purpose: the events are the rows of `order_status_transitions` that were written and
 * `availableTransitions` is the rows that could be, so the buttons are the end of one line
 * rather than a separate box. A second set of buttons up beside the status would split what
 * that file was written to join, **and** would put two assertions of the same gate on one
 * screen — the failure `quote-editor.tsx` already warns about in its own comments.
 *
 * So the caption counts and points. It is deliberately the *weaker* statement.
 *
 * ── Why `offered` is counted separately from the API's list ───────────────────
 *
 * `transitionForm(kind).offered === false` does not mean the move is forbidden — the API said
 * it was available. It means **this build cannot compose a body for it**, and the spine renders
 * a dashed non-button with `whyNotTh` in that case. A caption that promised "ทำต่อได้ 3 อย่าง"
 * and then showed one button and two explanations would be lying about the smaller number, so
 * the two are counted apart and only the actionable count is promised.
 */

export interface OrderFocus {
  /** Moves the API offered *and* this build can post. The number the caption promises. */
  readonly actionable: number;
  /** Moves the API offered that this build cannot compose a body for. Explained, not offered. */
  readonly explained: number;
  /** The line under the status. Never null — a terminal order still gets told it is terminal. */
  readonly nextTh: string;
}

export function orderFocus(
  availableTransitions: readonly { readonly payloadKind: PayloadKind }[],
): OrderFocus {
  let actionable = 0;
  let explained = 0;

  for (const available of availableTransitions) {
    if (transitionForm(available.payloadKind).offered) actionable += 1;
    else explained += 1;
  }

  if (actionable === 0 && explained === 0) {
    return { actionable, explained, nextTh: 'เป็นสถานะปลายทาง — ออเดอร์นี้เดินต่อไม่ได้แล้ว' };
  }

  if (actionable === 0) {
    /*
     * The API offered moves and none of them can be posted from this build. Saying "ทำต่อได้ 0
     * อย่าง" would read as terminal, which is the one thing this state is not — the reasons are
     * on the rail and a reader has to be sent to them rather than told the order is finished.
     */
    return {
      actionable,
      explained,
      nextTh: `มี ${explained} ทางที่ API เปิดไว้ แต่แดชบอร์ดรุ่นนี้ยังทำให้ไม่ได้ — เหตุผลอยู่ที่ปลายเส้นด้านล่าง`,
    };
  }

  const tail =
    explained === 0 ? '' : ` และอีก ${explained} ทางที่แดชบอร์ดรุ่นนี้ยังทำให้ไม่ได้`;

  return {
    actionable,
    explained,
    nextTh: `ทำต่อได้ ${actionable} อย่าง — ปุ่มอยู่ที่ปลายเส้นด้านล่าง${tail}`,
  };
}
