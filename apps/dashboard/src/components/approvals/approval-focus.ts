/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The approver's one primary statement: how much is waiting on **you**.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The inbox used to open with a bordered card holding two ceiling figures at `text-lg
 * font-semibold` — the loudest text on the screen — above an `h2` at `text-base` that named the
 * queue and a `text-sm` line that gave the company-wide total. So the biggest thing on a screen
 * whose entire purpose is *decide these* was a pair of numbers nobody decides anything about.
 * A ceiling is a precondition for reading the queue, not the reason anybody opened it.
 *
 * This derives the sentence that now sits at the top at `type-focal`, and it lives in a `.ts`
 * with no React in it because `apps/dashboard`'s vitest is `environment: 'node'` — a
 * `.test.tsx` is **silently never collected**, so a rule written into a component is a rule
 * with no test.
 *
 * ── ⚠️ "Waiting" here means waiting on *you*, and that is the whole point ─────
 *
 * `queue.approvals` is already filtered by the API to what this reader may decide
 * (`approval-rights.ts`), and the two withheld buckets — above your ceiling, and your own
 * requests — are counted rather than listed. The headline counts **only the rows you can act
 * on**, because a number that includes work you are structurally forbidden from touching is a
 * number that cannot be worked down to zero, and a queue figure that never reaches zero stops
 * being read.
 *
 * ── Why the detail line states the company-wide total ────────────────────────
 *
 * Same reconciliation `pendingTotal` exists for: the overview's ใบเสนอราคารออนุมัติ card counts
 * every pending row in the company. A screen saying 2 beside a dashboard saying 5, with nothing
 * accounting for the gap, is how somebody concludes one of the two is broken.
 *
 * ⚠️ The line is **dropped when the two figures agree**, rather than saying it anyway. With
 * nothing withheld and no truncation the total *is* the headline, and restating it one line
 * down in smaller type is the duplication this whole pass exists to remove — the same argument
 * `account-settings.tsx` makes for suppressing its ways-in caption when the Alert already
 * speaks. The `withheld > 0` Alert further down the screen keeps the breakdown of *why*, which
 * is a different sentence from *how many*.
 */

import { pendingTotal } from './approval-decision';

/** Just enough of the queue to summarise it. `ApprovalQueueView` structurally satisfies this. */
export interface CountedApprovalQueue {
  readonly approvals: readonly unknown[];
  readonly withheld: {
    readonly beyondYourAuthority: number;
    readonly yourOwnRequests: number;
  };
  /** True when more pending rows exist than one read covers — the totals are then a floor. */
  readonly isTruncated: boolean;
}

export interface ApprovalFocus {
  /** Rows this person may decide right now — the number the headline counts. */
  readonly yours: number;
  /** Pending rows deliberately not listed: above your ceiling, or asked for by you. */
  readonly withheld: number;
  /** Everything pending company-wide, from this caller's point of view. */
  readonly total: number;
  /** The `type-focal` line. A statement about your afternoon, not a label. */
  readonly headlineTh: string;
  /** The caption under it. `null` when the headline is already the whole answer. */
  readonly detailTh: string | null;
}

export function approvalFocus(queue: CountedApprovalQueue): ApprovalFocus {
  const yours = queue.approvals.length;
  const withheld = queue.withheld.beyondYourAuthority + queue.withheld.yourOwnRequests;
  /* ⚠️ `pendingTotal` and not `yours + withheld` written again here. It is the function whose
   * whole reason for existing is that this screen and the overview agree on one arithmetic; a
   * second copy a few lines away is how the two drift the day a third withheld bucket arrives. */
  const total = pendingTotal(queue);

  /*
   * Three headlines and not one with a number substituted in, because the three states mean
   * genuinely different things to the person reading. "0 คำขอรอคุณตัดสิน" beside a backlog of
   * four that are all above your ceiling would read as *nothing is happening*, when what is
   * true is *nothing is yours* — and that difference is what decides whether somebody goes and
   * finds a colleague with a bigger ceiling.
   */
  const headlineTh =
    yours > 0
      ? `${yours} คำขอรอคุณตัดสิน`
      : total === 0
        ? 'ไม่มีคำขออนุมัติค้างอยู่ในระบบ'
        : 'ไม่มีคำขอที่คุณตัดสินได้ตอนนี้';

  /*
   * ⚠️ Truncation is stated wherever it applies, including when nothing is withheld — the cap
   * makes `total` a floor, and a floor presented as a count is the failure `order-list.tsx`
   * warns about in its own "แสดง 100 รายการแรก" line.
   */
  const truncatedTh = queue.isTruncated ? ' — นับเฉพาะ 200 คำขอที่เก่าที่สุด' : '';
  const reconciles = withheld === 0 && !queue.isTruncated;

  return {
    yours,
    withheld,
    total,
    headlineTh,
    detailTh:
      total === 0 || reconciles ? null : `ทั้งระบบมี ${total} คำขอที่ยังไม่ถูกตัดสิน${truncatedTh}`,
  };
}
