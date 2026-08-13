/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The overview's one primary statement: what is waiting for a person.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The screen used to open with four section headings of identical size and ten bordered
 * cards, so the loudest things on it were the two money figures at `text-3xl` — which are
 * *reference*, not work. A reader could not tell at a glance whether the company owed anybody
 * an afternoon. This derives the sentence that now sits at the top at `type-focal`, and it
 * lives in a `.ts` with no React in it because `apps/dashboard`'s vitest is
 * `environment: 'node'` and a `.test.tsx` is **silently never collected** — logic in a `.tsx`
 * here is logic that cannot be proved.
 *
 * ── ⚠️ The two honesty rules of the overview apply to this sentence too ───────
 *
 * A queue the reader may not see never reaches this function: `overview-screen.tsx` builds
 * its list from the keys the API chose to send, so an absent card is absent here rather than
 * counted as zero. That is why `pressing` is derived from the list handed in and never from a
 * fixed roster of five — a reader holding two permissions gets a sentence about two queues,
 * not a sentence claiming three others are empty.
 *
 * ── Why zero gets a sentence of its own rather than "0 รายการ" ───────────────
 *
 * An empty queue is good news and has to read as calm — the same argument `QueueTile` already
 * makes for styling zero *down*. "0 รายการรอดำเนินการ" is a number a reader still has to
 * parse before they can relax; ไม่มีงานค้าง is the answer itself.
 */

/** Just enough of a queue to summarise it. `overview-screen.tsx`'s `QueueCard` structurally satisfies this. */
export interface CountedQueue {
  readonly label: string;
  readonly count: number;
}

export interface OverviewFocus {
  /** Everything waiting, across every queue the reader can see. */
  readonly waiting: number;
  /** The non-empty queues, heaviest first — the ones the detail line names. */
  readonly pressing: readonly CountedQueue[];
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is already the whole answer. */
  readonly detailTh: string | null;
}

/**
 * ⚠️ Sorted by count descending and **ties keep the order they arrived in**, which is the
 * order of the working day that `overview-screen.tsx` builds its list in (slips, approvals,
 * refunds, reviews, notifications). `Array.prototype.sort` is required to be stable, so this
 * is a guarantee rather than an accident — and it matters, because five queues holding one
 * item each is a real state and shuffling it per render would be worse than any ordering.
 *
 * ⚠️ **`filter` before `sort`, and that ordering is what makes the sort safe** — not a spread.
 *
 * This was written as `[...queues].filter(…).sort(…)`, and a mutation test showed the spread was
 * dead code: removing it changed nothing, because `filter` already returns a fresh array and
 * `sort` therefore reorders *that* rather than the caller's. The spread was decoration implying
 * a protection it was not providing, so it is gone.
 *
 * What would genuinely mutate is `queues.sort(…).filter(…)` — sorting first, in place, on the
 * very array `overview-screen.tsx` renders its tiles from. `overview-focus.test.ts`'s
 * "does not mutate" case was mutation-tested against exactly that shape and fails on it.
 */
export function overviewFocus(queues: readonly CountedQueue[]): OverviewFocus {
  const waiting = queues.reduce((total, queue) => total + queue.count, 0);
  const pressing = queues
    .filter((queue) => queue.count > 0)
    .sort((left, right) => right.count - left.count);

  if (waiting === 0) {
    return {
      waiting,
      pressing,
      headlineTh: 'ไม่มีงานค้างในคิวที่คุณดูได้',
      detailTh: queues.length === 0 ? null : 'ทุกคิวที่บัญชีนี้เห็นว่างอยู่',
    };
  }

  return {
    waiting,
    pressing,
    headlineTh: `${waiting} รายการรอดำเนินการ`,
    /*
     * Named rather than left to the reader to find below. The headline says how much work
     * there is; without this line they still have to scan five tiles to learn *where* it is,
     * which is the scanning the focal point exists to remove.
     */
    detailTh: pressing.map((queue) => `${queue.label} ${queue.count}`).join(' · '),
  };
}
