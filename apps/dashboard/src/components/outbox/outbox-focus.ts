/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The outbox's one primary statement: what the company thinks it told a customer, and did not.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"A dead-lettered notification that nobody sees is worse than none, because the company
 * believes the customer was told."* That sentence is the reason `/outbox` exists, and until now
 * it appeared nowhere on the screen: the number it is about (`summary.dead`) was one of six
 * equal `text-2xl` figures in a grid, beside `ส่งแล้ว` — a running total nobody acts on, at the
 * same size and weight. Six numbers of equal loudness is no ranking at all.
 *
 * This derives the sentence that now sits at the top at `type-focal`. It lives in a `.ts` with no
 * React in it because `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is
 * **silently never collected** — logic in a `.tsx` here is logic that cannot be proved.
 *
 * ── ⚠️ Three counts, and only two of them belong in the headline ─────────────
 *
 *   `dead`          tried to the end of its retries and failed. The customer did not get it,
 *                   and the row will sit there for ever unless somebody presses ส่งซ้ำ.
 *   `stuckSending`  claimed by a worker that then died. **Nothing retries these on a timer**,
 *                   so the number does not come down on its own either.
 *   `suppressed`    closed without being sent, and **not** a failure. Also undelivered, and
 *                   deliberately **not** in the headline count: retrying is not the fix, so
 *                   folding it into one total would suggest one action for two different jobs.
 *                   It gets a clause of its own in the detail line instead.
 *
 * ── ⚠️ `suppressed` is one number over two unrelated facts ───────────────────
 *
 * It used to be worded here as *"ไม่มีที่อยู่ให้ส่งมาตั้งแต่แรก … ต้องไปหาเบอร์หรืออีเมลของลูกค้ามาก่อน"*,
 * which was true while every suppression reason meant "there was nobody to write to". It is not
 * any more: `balance_settled` is a customer who paid before the worker drained the reminder, and
 * that clause sent staff hunting for the contact details of somebody who had already settled up.
 *
 * ⛔ **The fix is not to pass the reasons in here.** This function is handed *counts*, and the
 * API sends `summary.suppressed` as a single total with no breakdown — the per-reason facts exist
 * only on the row list, which arrives capped at `limit`. A clause splitting the total by a
 * truncated list would state a number the screen cannot stand behind. So the clause says what is
 * true of **every** suppressed row and points at the sections that can answer which; the split
 * itself lives in `outbox-suppression.ts`, where it is done on rows rather than on a count.
 *
 * ── ⚠️ `dead` and `stuckSending` do not mean the same thing, so they get different sentences ──
 *
 * A dead row is a *known* non-delivery: every attempt was made and every one failed. A stuck row
 * is an *unknown* one — the worker may have died before the provider was called or after it
 * answered, and nothing here can tell which. So the two-branch wording exists to avoid the one
 * overclaim available here: a combined headline saying `ลูกค้าไม่ได้รับ` about a stuck row asserts
 * something this screen does not know. The shared arm says what is true of both — that the system
 * has stopped working on them — and the per-count clauses say the rest.
 */

/** Just enough of `outbox-api.ts`'s `Summary` to word it. That interface structurally satisfies this. */
export interface OutboxCounts {
  readonly dead: number;
  readonly suppressed: number;
  readonly stuckSending: number;
}

export interface OutboxFocus {
  /** `dead + stuckSending` — the rows nothing will move on its own. Not `suppressed`; see above. */
  readonly stalled: number;
  /** The `type-focal` line. A statement, not a label. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is already the whole answer. */
  readonly detailTh: string | null;
}

export function outboxFocus(counts: OutboxCounts): OutboxFocus {
  const { dead, stuckSending, suppressed } = counts;
  const stalled = dead + stuckSending;

  /*
   * The clause about messages that were never sent is appended in every branch, including the
   * calm one. It is the count that never changes on its own and that no button on this screen can
   * fix, so the only thing that ever surfaces it is a sentence — and a version that spoke only
   * during an incident would stay silent for exactly as long as nothing else was wrong.
   *
   * ⚠️ It states the count and the one thing true of all of them — nothing was sent, and no
   * button will change that — and then hands the *why* to the tables, because the why differs per
   * row and this function was given no rows. `เหตุผลของแต่ละฉบับ` is doing real work: it tells the
   * reader these are not one kind of problem, which is precisely what the old wording denied.
   *
   * ⚠️ One number, and only one. `apps/dashboard/README.md`'s rule is that a figure already on
   * the screen is not a focal point, and `summary.suppressed` is a Figure directly below this
   * line; the clause earns its place by being the only sentence about it, not by counting it
   * twice over in two halves.
   */
  const suppressedTh =
    suppressed === 0
      ? null
      : `อีก ${String(suppressed)} ฉบับระบบไม่ได้ส่ง และส่งซ้ำไม่ได้ — เหตุผลของแต่ละฉบับอยู่ในตารางด้านล่าง`;

  if (stalled === 0) {
    return {
      stalled,
      headlineTh: 'ไม่มีข้อความที่ค้างส่งไม่ถึงลูกค้า',
      detailTh: suppressedTh,
    };
  }

  /*
   * ⚠️ The stuck sentence says out loud that no timer is coming. The instinct on seeing a row in
   * "กำลังส่ง" is to wait for it to finish, and waiting is the one response that never resolves
   * this state — the worker that owned the row is gone.
   */
  const STUCK_CAUSE = 'ตัวส่งหยุดกลางคัน ไม่มีตัวจับเวลาใดมาลองใหม่ให้ และหน้านี้บอกไม่ได้ว่าฉบับไหนออกไปแล้วบ้าง';
  const DEAD_CAUSE = 'ลองส่งครบทุกครั้งที่ตั้งไว้แล้วและไม่ถึง กดส่งซ้ำได้ที่รายการด้านล่าง';

  /*
   * Three headlines rather than one with a count substituted in, because the reader's next move
   * differs: a dead row has a button, a stuck row has a process to go and look at, and the pair
   * is the case where neither sentence alone would be the whole truth. The detail line never
   * restates its own headline — when only one kind is present the headline has already counted
   * it, so the clause under it is the cause and the remedy rather than the number again.
   */
  const headlineTh =
    stuckSending === 0
      ? `${String(dead)} ข้อความที่ลูกค้าไม่ได้รับ และระบบเลิกส่งไปแล้ว`
      : dead === 0
        ? `${String(stuckSending)} ข้อความค้างอยู่กลางทาง และไม่มีอะไรมาสะสางให้เอง`
        : `${String(stalled)} ข้อความที่ระบบหยุดส่งไปแล้ว โดยที่ยังไม่ถึงลูกค้า`;

  const cause =
    stuckSending === 0
      ? DEAD_CAUSE
      : dead === 0
        ? STUCK_CAUSE
        : `ส่งไม่สำเร็จ ${String(dead)} ฉบับ — ${DEAD_CAUSE} · ค้างในสถานะกำลังส่ง ${String(stuckSending)} ฉบับ — ${STUCK_CAUSE}`;

  return {
    stalled,
    headlineTh,
    detailTh: suppressedTh === null ? cause : `${cause} · ${suppressedTh}`,
  };
}
