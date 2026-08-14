import type { ApprovalRightReasonWire, ApprovalRightsView } from './approvals-api';
import type { CeilingView } from '@/components/quotes/authority-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT A CONCESSION DECISION NEEDS BEFORE IT MAY BE SENT — and what it must never invent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No React here, for the reason `refunds/refund-decision.ts` gives about its own rules: every
 * property below is about what the API accepts and what the person is being told, and both should
 * be provable without rendering anything. `apps/dashboard`'s vitest runs in `environment: 'node'`
 * — a `.test.tsx` here is silently never collected — so a rule that lives in a component is a
 * rule with no test.
 *
 * ── ⚠️ THE ONE THING THIS FILE MUST NOT DO ───────────────────────────────────────
 *
 * **It never compares a concession against a ceiling.** Whether this person may approve this
 * request is `rights.mayApprove`, decided by `approval-rights.ts` in apps/api and enforced by the
 * same function the decision endpoint calls. A `concession <= ceiling` written here would be a
 * second implementation of the only control this system has over what a customer is charged —
 * plan 7.13's opening finding (one rule, six copies, five of them holed) arriving again in
 * TypeScript. So `rights` arrives decided, and this file's job is the *other* half: making sure a
 * refusal carries a reason, and that both answers are equally reachable.
 *
 * ── Refusing must be as easy as approving ────────────────────────────────────────
 *
 * `mayRefuse` is deliberately wider than `mayApprove` on the wire: saying no is not an exercise
 * of authority, so it needs no ceiling. A screen that offered only the button the ceiling allows
 * would make approval the path of least resistance, and a queue where approving is the only thing
 * that works produces approvals. Hence `ready` treats the two symmetrically apart from the one
 * asymmetry that is real: a refusal owes the requester a sentence.
 */

export type Decision = 'approved' | 'rejected';

export interface DecisionAnswers {
  readonly noteTh: string;
}

export interface DecisionNeeds {
  /** Whether the note is required — true on a refusal, and the API answers 422 without it. */
  readonly note: boolean;
  /** Whether the server said this caller may take *this* answer. Never derived from a ceiling. */
  readonly permitted: boolean;
  readonly ready: (answers: DecisionAnswers) => boolean;
}

export function decisionNeeds(decision: Decision, rights: ApprovalRightsView): DecisionNeeds {
  /*
   * ⚠️ Required on a refusal, and the reason is not validation for its own sake: a rejection
   * without a sentence is a request that comes back with nothing to act on, and the requester's
   * only move is to ask again. `ApprovalsController.decide` refuses it with a 422 — this stops the
   * round trip, it does not replace the rule.
   */
  const note = decision === 'rejected';
  const permitted = decision === 'approved' ? rights.mayApprove : rights.mayRefuse;

  return {
    note,
    permitted,
    ready: (answers) => permitted && (!note || answers.noteTh.trim() !== ''),
  };
}

/**
 * The body to POST.
 *
 * `noteTh` is omitted when blank rather than sent as `''`: the schema is
 * `z.string().trim().min(1).optional()`, so an empty string is a 400 where absence is the honest
 * "no note". On a refusal `ready` has already required one — this function does not invent one,
 * because a note the approver did not write is worse than none.
 */
export function decisionBody(decision: Decision, answers: DecisionAnswers): Record<string, unknown> {
  const note = answers.noteTh.trim();
  return { decision, ...(note === '' ? {} : { noteTh: note }) };
}

/**
 * ⭐ Why a decision is not available, in Thai.
 *
 * Exhaustive over `ApprovalRightReasonWire` by type, so a reason added to the API cannot arrive
 * here as a blank space next to a dead button — `pnpm -r run typecheck` fails until somebody
 * writes the sentence. (The decoder is the other half: an *unknown* reason is a decode failure,
 * not an empty string.)
 *
 * `no_ceiling` and `above_ceiling` are two different sentences on purpose, and it is the
 * distinction `authority_limits` exists to make: no live row is no authority at all — somebody
 * has to grant this role a ceiling, or withdraw the withdrawal — while a row that is too small is
 * a number the owner can raise. Collapsing them would send the approver to the wrong person.
 *
 * ⭐ The two write-off reasons follow the same rule and each sends the reader somewhere different:
 *
 *   `not_a_write_off_approver`  a permission the *owner* grants by hand (`payments.write_off`, held
 *                               by nobody at boot). ⚠️ Unlike every ceiling sentence, this one
 *                               blocks refusing as well — so the wording must not suggest waiting
 *                               for a bigger number.
 *   `above_balance`             nothing anybody can grant. The customer has paid part of the debt
 *                               since the request was raised, so the figure asked for no longer
 *                               exists and the only honest answer is ไม่อนุมัติ plus a note telling
 *                               the requester to ask again for what is left.
 */
export const REASON_TH: Readonly<Record<ApprovalRightReasonWire, string>> = {
  may_decide: 'คุณตัดสินคำขอนี้ได้',
  not_an_approver: 'บัญชีของคุณไม่มีสิทธิ์ตัดสินคำขออนุมัติ',
  already_decided: 'คำขอนี้ถูกตัดสินไปแล้ว',
  own_request: 'คุณเป็นผู้ยื่นคำขอนี้เอง ต้องให้คนอื่นตัดสิน',
  no_ceiling: 'บทบาทของคุณยังไม่ได้รับกำหนดเพดานอำนาจอนุมัติในมิตินี้',
  above_ceiling: 'ยอดที่ขอลดเกินเพดานอำนาจอนุมัติของคุณ',
  not_a_write_off_approver: 'บัญชีของคุณไม่มีสิทธิ์ตัดยอดค้างทิ้ง ต้องให้ผู้ที่ได้รับสิทธิ์นี้ตัดสิน',
  above_balance:
    'ยอดคงค้างของออเดอร์นี้ลดลงหลังจากยื่นคำขอ จึงอนุมัติตามจำนวนที่ขอไม่ได้ — ให้ไม่อนุมัติแล้วแจ้งผู้ขอยื่นใหม่ตามยอดคงค้างปัจจุบัน',
};

/**
 * How many pending requests there are in total, from the caller's point of view.
 *
 * ⭐ **This is what makes the screen agree with the dashboard.** The overview's
 * `ใบเสนอราคารออนุมัติ` card counts every pending row in the company, while the queue lists only
 * what this person may decide. A screen showing two while the card says five, with nothing to
 * explain the gap, is how somebody concludes one of the two is broken — so the withheld figures
 * are added back and shown as what they are.
 *
 * ⚠️ Only exact while `isTruncated` is false; the screen says so when it is not.
 */
export function pendingTotal(queue: {
  readonly approvals: readonly unknown[];
  readonly withheld: { readonly beyondYourAuthority: number; readonly yourOwnRequests: number };
}): number {
  return (
    queue.approvals.length + queue.withheld.beyondYourAuthority + queue.withheld.yourOwnRequests
  );
}

/**
 * A ceiling, said in words — and the three cases are three different sentences.
 *
 * `{ known: false }` cannot occur on these two endpoints (both read the ceiling unconditionally,
 * so the API always sends `known: true`), and it is handled rather than asserted away: a wire that
 * ever said "I did not look" must not be rendered as "you have none", which is the fail-open fold
 * that put *ยังไม่มีการกำหนดเพดาน* on every quote with no discount on it one screen away.
 */
export function ceilingTh(ceiling: CeilingView, formatBaht: (minor: bigint) => string): string {
  if (!ceiling.known) return 'ไม่ทราบเพดานอำนาจ';
  if (ceiling.thbMinor === null) return 'ยังไม่มีเพดานอำนาจ';
  /* ⚠️ `0` is a real grant, not the absence of one — so it prints as ฿0.00 and not as "none". */
  return formatBaht(ceiling.thbMinor);
}
