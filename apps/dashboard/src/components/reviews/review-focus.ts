/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The moderation queue's one primary statement: what is about to happen by itself.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Doing nothing is a decision here, and it is the default one.** A review goes public when
 * its window elapses, so this is not a list of things waiting for approval — it is a list of
 * things about to happen. `review-queue.tsx`'s header has said exactly that since it was
 * written, and the screen did not agree with it: the clock rendered as a `text-xs` span pushed
 * into the **top-right corner** of each card, quieter than the product name beside it, while the
 * page's loudest elements were N identical Card borders. The code's stated intent was not true
 * of its output.
 *
 * So the countdown leads each row now, and this derives the sentence above the list. Both halves
 * of the same correction.
 *
 * Pure, and in a `.ts`, because `apps/dashboard`'s vitest is `environment: 'node'` and a
 * `.test.tsx` is **silently never collected**.
 */

/** Just enough of a queued review to summarise it. `review-api.ts`'s `QueueItem` satisfies this. */
export interface CountedReview {
  readonly hoursRemaining: number;
}

/** The window inside which "later today" stops being a fair description. */
export const URGENT_HOURS = 12;

/**
 * Hours as the screen says them, and **the one place that rounding is decided**.
 *
 * ⚠️ `Math.max(0, …)` because `hoursRemaining` goes negative: the window elapses on a clock and
 * the row leaves this queue on the next read, so between those two moments the API really does
 * report `-0.3`. "อีก -0 ชม." is a rendering of a race condition; "อีก 0 ชม." is the truth, which
 * is that it is going out now.
 *
 * The row and the headline both call this, so a review the summary counts as urgent can never
 * print a different number from the one beside it.
 */
export const hoursLeft = (hoursRemaining: number): number => Math.max(0, Math.round(hoursRemaining));

export interface ReviewFocus {
  readonly waiting: number;
  /** Hours until the next one publishes itself, already rounded. `null` when the queue is empty. */
  readonly soonestHours: number | null;
  readonly urgent: number;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is the whole answer. */
  readonly detailTh: string | null;
}

export function reviewFocus(items: readonly CountedReview[]): ReviewFocus {
  const urgent = items.filter((item) => item.hoursRemaining <= URGENT_HOURS).length;
  const soonestHours = items.reduce<number | null>(
    (soonest, item) =>
      soonest === null || item.hoursRemaining < soonest ? item.hoursRemaining : soonest,
    null,
  );

  if (items.length === 0 || soonestHours === null) {
    return {
      waiting: 0,
      soonestHours: null,
      urgent: 0,
      headlineTh: 'ไม่มีรีวิวที่กำลังจะเผยแพร่เอง',
      detailTh: null,
    };
  }

  return {
    waiting: items.length,
    soonestHours: hoursLeft(soonestHours),
    urgent,
    /*
     * "กำลังจะขึ้นหน้าเว็บเอง", not "รอกลั่นกรอง". The second is what a queue screen normally
     * says and it is the wrong verb here: nobody is waiting for the moderator, the clock is
     * running and the moderator is who may stop it.
     */
    headlineTh: `${String(items.length)} รีวิวกำลังจะขึ้นหน้าเว็บเอง`,
    detailTh: [
      `เร็วที่สุดอีก ${String(hoursLeft(soonestHours))} ชม.`,
      ...(urgent === 0
        ? []
        : [`ภายใน ${String(URGENT_HOURS)} ชม. ${String(urgent)} รายการ`]),
    ].join(' · '),
  };
}
