/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT A REFUND DECISION NEEDS BEFORE IT MAY BE MADE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two rules, and one of them is a control rather than a validation.
 *
 * ── ⚠️ The different-account acknowledgement ─────────────────────────────────
 *
 * Plan 7.12 asks for a *second, explicit approval* when money is going somewhere other than
 * the account it came from. `decideRefundSchema` spells it
 * `acknowledgeDifferentAccount: z.literal(true).optional()` — a literal rather than a
 * boolean, and a field rather than a second permission, because `rbac/permissions.ts` was
 * not that round's file to extend.
 *
 * What it buys, in the contract's words: *"approving a refund to an unrecognised account
 * cannot be done by the same click that approves an ordinary one, so it cannot be done
 * without reading the field that says the account is unrecognised."*
 *
 * **That property lives or dies here.** A dialog that attached the acknowledgement to every
 * approval would satisfy the schema, pass every integration test, and quietly delete the
 * control — the second act stops being second. So `decisionBody` sends the field only when
 * the derived flag says the account is different, and `refund-decision.test.ts` asserts the
 * *absence* on an ordinary approval rather than only the presence on the flagged one.
 *
 * `payeeIsOriginalAccount` is derived by the service from the accepted slips, never taken
 * from the request. A `no` is the system saying it could not match this account to any money
 * that came in — which is precisely the moment a human should have to look.
 *
 * ── A rejection owes somebody a sentence ─────────────────────────────────────
 *
 * `refunds_status_shape` demands the note in Postgres, and the person who asked for the
 * refund is owed the reason regardless.
 *
 * No React in this file: both rules are about what the API accepts, and should be provable
 * without rendering anything.
 */

export type Decision = 'approved' | 'rejected';

export interface RefundFacts {
  readonly decision: Decision;
  /** Derived by the service from the accepted slips. Never echoed back from a request. */
  readonly payeeIsOriginalAccount: 'yes' | 'no';
}

export interface Answers {
  readonly acknowledged: boolean;
  readonly noteTh: string;
}

export interface DecisionNeeds {
  /** Whether the different-account box must be ticked before the button turns on. */
  readonly acknowledgement: boolean;
  /** Whether a note is required. */
  readonly note: boolean;
  readonly ready: (answers: Answers) => boolean;
}

export function decisionNeeds(facts: RefundFacts): DecisionNeeds {
  /*
   * ⚠️ Approvals only. Refusing to send money somewhere does not need the approval that
   * sending it would — the acknowledgement is about a payment leaving for an unrecognised
   * account, and a rejection is the payment not leaving at all.
   */
  const acknowledgement = facts.decision === 'approved' && facts.payeeIsOriginalAccount === 'no';
  const note = facts.decision === 'rejected';

  return {
    acknowledgement,
    note,
    ready: (answers) =>
      (!acknowledgement || answers.acknowledged) && (!note || answers.noteTh.trim() !== ''),
  };
}

/**
 * The body to POST.
 *
 * ⭐ `acknowledgeDifferentAccount` appears **only** when the derived flag calls for it — not
 * when the reviewer happens to have ticked a box that was not shown, and not as a harmless
 * always-true. See the block comment: an always-true is the exact shape of the mistake that
 * would leave every test green and the control gone.
 */
export function decisionBody(
  input: RefundFacts & Answers,
): Record<string, unknown> {
  const needs = decisionNeeds(input);
  const note = input.noteTh.trim();

  return {
    decision: input.decision,
    ...(note === '' ? {} : { noteTh: note }),
    ...(needs.acknowledgement && input.acknowledged ? { acknowledgeDifferentAccount: true } : {}),
  };
}
