import { describe, expect, it } from 'vitest';

import {
  ceilingTh,
  decisionBody,
  decisionNeeds,
  pendingTotal,
  REASON_TH,
} from '@/components/approvals/approval-decision';
import {
  APPROVAL_RIGHT_REASONS_WIRE,
  type ApprovalRightsView,
} from '@/components/approvals/approvals-api';

/**
 * What the approver's screen may send, and what it must be told.
 *
 * `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is silently never
 * collected, so every rule worth pinning lives in `approval-decision.ts` rather than in the
 * component — the same split `refund-decision.ts` makes and for the same reason.
 *
 * The rule that is deliberately **absent** from that file, and therefore from this one: whether a
 * ceiling covers a concession. That is `rights`, decided server-side by the same function the
 * decision endpoint enforces. A test here that compared two amounts would be evidence that the
 * client had grown its own copy of the control.
 */

const rights = (over: Partial<ApprovalRightsView> = {}): ApprovalRightsView => ({
  mayApprove: true,
  mayRefuse: true,
  because: 'may_decide',
  ceiling: { known: true, thbMinor: 500_000n },
  ...over,
});

describe('what a decision needs before it may be sent', () => {
  it('requires a reason to refuse and not to approve', () => {
    expect(decisionNeeds('rejected', rights()).note).toBe(true);
    expect(decisionNeeds('approved', rights()).note).toBe(false);
  });

  it('⭐ will not send a refusal with a blank reason, whitespace included', () => {
    /*
     * `ApprovalsController.decide` answers 422 without a note, and `decideApprovalSchema` trims
     * before `min(1)` — so `'   '` is a 400 rather than a note. The button is what should stop it:
     * a person who typed spaces and got a red toast has learned nothing about what to write.
     */
    const needs = decisionNeeds('rejected', rights());

    expect(needs.ready({ noteTh: '' })).toBe(false);
    expect(needs.ready({ noteTh: '   \n\t ' })).toBe(false);
    expect(needs.ready({ noteTh: 'ลดมากเกินไป' })).toBe(true);
  });

  it('approves with no note at all', () => {
    expect(decisionNeeds('approved', rights()).ready({ noteTh: '' })).toBe(true);
  });

  /**
   * ⭐⭐ The asymmetry that keeps a queue from producing approvals.
   *
   * An approver whose ceiling does not cover the figure may still **refuse** it — saying no is not
   * an exercise of authority, and `AuthorityService.decide` needs no ceiling to reject. A screen
   * that read one `mayDecide` flag for both answers would leave such a request unanswerable, and
   * the only working button in the building would be the one that says yes.
   */
  it('⭐ lets an approver refuse what they may not approve', () => {
    const beyond = rights({ mayApprove: false, mayRefuse: true, because: 'above_ceiling' });

    expect(decisionNeeds('approved', beyond).permitted).toBe(false);
    expect(decisionNeeds('approved', beyond).ready({ noteTh: 'อนุมัติเลย' })).toBe(false);

    expect(decisionNeeds('rejected', beyond).permitted).toBe(true);
    expect(decisionNeeds('rejected', beyond).ready({ noteTh: 'เกินอำนาจผม' })).toBe(true);
  });

  it('refuses both answers on a request that is already decided or is the reader’s own', () => {
    for (const because of ['already_decided', 'own_request', 'not_an_approver'] as const) {
      const blocked = rights({ mayApprove: false, mayRefuse: false, because });

      expect(decisionNeeds('approved', blocked).ready({ noteTh: 'x' }), because).toBe(false);
      expect(decisionNeeds('rejected', blocked).ready({ noteTh: 'x' }), because).toBe(false);
    }
  });

  it('⚠️ never lets a note substitute for permission', () => {
    /*
     * `ready` is `permitted && …`, not `… || permitted`. The mistake this pins is the one that
     * looks harmless in a component: enabling the button once the form is "valid".
     */
    const blocked = rights({ mayApprove: false, mayRefuse: false, because: 'already_decided' });

    expect(decisionNeeds('rejected', blocked).ready({ noteTh: 'เหตุผลครบถ้วน' })).toBe(false);
  });
});

describe('the body that is posted', () => {
  it('sends the decision and trims the note', () => {
    expect(decisionBody('rejected', { noteTh: '  ลดมากเกินไป  ' })).toStrictEqual({
      decision: 'rejected',
      noteTh: 'ลดมากเกินไป',
    });
  });

  it('⭐ omits the note entirely rather than sending an empty string', () => {
    /*
     * `noteTh` is `z.string().trim().min(1).optional()`: `''` is a 400, absent is the honest "no
     * note". `toStrictEqual` and not `toMatchObject`, because the assertion is about the key being
     * *gone* — the same shape `refund-decision.test.ts` insists on for its acknowledgement.
     */
    expect(decisionBody('approved', { noteTh: '   ' })).toStrictEqual({ decision: 'approved' });
    expect(Object.keys(decisionBody('approved', { noteTh: '' }))).toStrictEqual(['decision']);
  });
});

describe('what the screen tells the reader', () => {
  it('⭐ has a Thai sentence for every reason the wire can send', () => {
    /*
     * The type makes this exhaustive at compile time; this asserts it at run time as well, because
     * the failure mode of a missing entry is a *blank space* beside a dead button — the reader is
     * told nothing about why they cannot act, which is the state this whole screen exists to end.
     */
    for (const reason of APPROVAL_RIGHT_REASONS_WIRE) {
      expect(REASON_TH[reason], reason).toMatch(/\S/u);
    }

    expect(Object.keys(REASON_TH).sort()).toStrictEqual([...APPROVAL_RIGHT_REASONS_WIRE].sort());
  });

  it('⭐ says "no ceiling" and "over your ceiling" differently', () => {
    /*
     * Plan 13's distinction, carried all the way to the sentence: no live row is somebody having to
     * *grant* authority, a row that is too small is somebody having to *raise* it. Collapsing them
     * sends the approver to the wrong person.
     */
    expect(REASON_TH.no_ceiling).not.toBe(REASON_TH.above_ceiling);
  });

  it('⭐ reconciles with the overview’s pending count', () => {
    /*
     * The card counts every pending row in the company; the queue lists what this reader may
     * decide. Two of five with no explanation reads as a broken screen — so the withheld figures
     * are added back and shown.
     */
    expect(
      pendingTotal({
        approvals: [1, 2],
        withheld: { beyondYourAuthority: 2, yourOwnRequests: 1 },
      }),
    ).toBe(5);
  });

  it('⭐ prints a ceiling of zero as a real grant, not as the absence of one', () => {
    /*
     * `authority_limits`' own note: `0` is a role that may record a concession and approve none of
     * its own; **no row** is a role with no authority at all. Two states, two sentences, and the
     * one that must never be printed for the other is "ยังไม่มีเพดานอำนาจ".
     */
    const money = (minor: bigint): string => `฿${minor / 100n}`;

    expect(ceilingTh({ known: true, thbMinor: 0n }, money)).toBe('฿0');
    expect(ceilingTh({ known: true, thbMinor: null }, money)).toBe('ยังไม่มีเพดานอำนาจ');
    /* `known: false` cannot occur on these endpoints, and is still not rendered as "you have none". */
    expect(ceilingTh({ known: false }, money)).not.toBe('ยังไม่มีเพดานอำนาจ');
  });
});
