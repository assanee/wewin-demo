/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ How long a thing sat between two entries — the one label every history needs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This was written for the order spine and lives here because it is not about orders. Two
 * adjacent rows of any history carry two timestamps and leave the subtraction to whoever is
 * looking, and **the subtraction is the story** — identically so for a lifecycle and for a
 * settings log:
 *
 *   an order       seq 2→3 is six and a half hours (how long the customer took to pay) and
 *                  3→4→5 is under a minute (one staff member clicking through three steps in
 *                  one sitting). A screen that prints both pairs the same way has hidden the
 *                  only fact that distinguishes them.
 *
 *   a setting      "this bank account has not changed in four months" and "somebody changed
 *                  this destination three times in ten minutes" are the two things an auditor
 *                  is actually scanning for, and neither is legible from a column of
 *                  minute-precision timestamps.
 *
 * ⚠️ **It lives in `components/history/` and not in either caller**, for the reason
 * `authority-limits.ts` writes down about `ChangedFieldView`: a shared shape parked inside one
 * feature's folder makes that feature the de-facto owner of something several depend on, and the
 * first change one of them needs becomes a change to all of them. `order-timeline.ts` re-exports
 * these two names so nothing on the order page had to move to make this available here.
 */

/**
 * ⚠️ Below this, no label at all — and the number is a judgement, so it is written down.
 *
 * **Two minutes.** Under it, the two entries were one person's consecutive clicks rather than a
 * wait, and "32 วินาที" on the rail is noise in the one column that exists to make waits
 * visible. The displayed timestamps are minute-precision (`timeStyle: 'short'`), so a gap this
 * small is already indistinguishable there — printing it would be the rail claiming a precision
 * the rest of the row does not have.
 *
 * It is a floor on the *label*, never on the row: every entry still gets its marker, its
 * timestamp and its record. Nothing is hidden by this, only left unannotated.
 *
 * ⚠️ It is also **not** a claim that two entries under two minutes apart are one act. The dev
 * database has three tax-country edits inside 35 seconds and three more inside two minutes; each
 * one is a separate append-only row with its own actor and its own before/after, and each one
 * still renders. The floor suppresses a *label*, and the entries either side of it are what say
 * somebody was clicking fast.
 */
export const GAP_FLOOR_MS = 120_000;

const MINUTE_MS = 60_000;

/**
 * How long the subject sat between two entries, in Thai — or `null` when saying so would mislead.
 *
 * ⚠️ **Label only. There is deliberately no proportional-height counterpart to this function**,
 * and no caller may derive one from it. A production step is routinely three weeks and an
 * installation slot two months out; a bank account can go unedited for a year. A rail whose
 * segments scaled with elapsed time would push everything below it kilometres down the page, and
 * a log scale that fixed the geometry would be a chart nobody can read a duration off.
 *
 * ⚠️ **Truncated, never rounded.** 59 minutes 59 seconds is `59 นาที` and not `1 ชม.`: the two
 * timestamps either side of the label are on screen, and a label that rounds *up* past an hour
 * boundary the visible clock times contradict is a label the reader learns to distrust.
 *
 * ⚠️⭐ **`null` when `later` precedes `earlier`, and this is load-bearing rather than defensive.**
 *
 * The list's own order is the authority — `seq` on an order spine, the API's `ORDER BY` on a
 * settings history — and **not** the clock. `changed_at` on all four `*_changes` tables is
 * written with `clock_timestamp()` for exactly this reason (see migration `0039_history_clock`):
 * `now()` is the transaction's start time, so under a row lock an earlier-starting transaction
 * can commit later and a clock-sorted read comes out in an order that never happened. That fix
 * makes the hazard rare; it does not make it impossible for a row written before it landed. So a
 * clock that appears to have gone backwards between two list-adjacent entries is possible, and it
 * is **not** a negative duration — it is the absence of one. Returning `null` prints no label and
 * leaves both timestamps visible, which is the honest rendering. Same for an unparseable
 * timestamp: nothing, rather than `NaN นาที`.
 *
 * ⚠️ A corollary for every caller: this function *reads* two entries the list already ordered.
 * Nothing may use it, or the timestamps it parses, to **decide** that order.
 *
 * Units stop at วัน. No สัปดาห์, no เดือน — lead times in this business are quoted in days
 * ("ผลิต 21 วัน" on the quotation), so `21 วัน` is the figure a reader compares against a
 * contract, and `3 สัปดาห์` would make them convert it back.
 */
export function gapLabelTh(earlierIso: string, laterIso: string): string | null {
  const from = Date.parse(earlierIso);
  const to = Date.parse(laterIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  const elapsed = to - from;
  if (elapsed < GAP_FLOOR_MS) return null;

  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) return `${minutes} นาที`;

  const hours = Math.floor(minutes / 60);
  const minutesOver = minutes % 60;
  if (hours < 24) {
    return minutesOver === 0 ? `${hours} ชม.` : `${hours} ชม. ${minutesOver} นาที`;
  }

  const days = Math.floor(hours / 24);
  const hoursOver = hours % 24;
  if (days < 7) return hoursOver === 0 ? `${days} วัน` : `${days} วัน ${hoursOver} ชม.`;

  return `${days} วัน`;
}
