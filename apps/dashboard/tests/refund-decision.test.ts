import { describe, expect, it } from 'vitest';

import { decisionBody, decisionNeeds } from '../src/components/refunds/refund-decision';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ APPROVING A REFUND TO AN UNRECOGNISED ACCOUNT IS A SEPARATE ACT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan 7.12 asks for a second, explicit approval when the money is going somewhere other
 * than the account it came from, and `decideRefundSchema` implements it as
 * `acknowledgeDifferentAccount: z.literal(true).optional()` rather than as a second
 * permission — `rbac/permissions.ts` was not that round's file to extend.
 *
 * What the literal buys, in the contract's own words: *"approving a refund to an
 * unrecognised account cannot be done by the same click that approves an ordinary one, so it
 * cannot be done without reading the field that says the account is unrecognised."*
 *
 * That property is only real if the *screen* keeps it. A dialog that quietly attached the
 * acknowledgement to every approval would satisfy the schema, pass every integration test,
 * and give away exactly the control the field exists to be. This file is what stops that.
 *
 * The second rule is smaller and has the same shape: a rejection needs a note, because
 * `refunds_status_shape` demands one and because the person who asked for the refund is
 * owed a sentence.
 */

describe('⭐ what an approval needs', () => {
  it('needs nothing extra when the money is going back where it came from', () => {
    const needs = decisionNeeds({ decision: 'approved', payeeIsOriginalAccount: 'yes' });

    expect(needs.acknowledgement).toBe(false);
    expect(needs.note).toBe(false);
  });

  it('⚠️ demands the acknowledgement when the account is not the original', () => {
    /*
     * The case the field exists for. `payeeIsOriginalAccount` is *derived* — the service
     * compares the payee against the accepted slips rather than trusting the request — so a
     * `no` here is the system saying it could not match this account to any money that came
     * in, which is the moment somebody should have to look.
     */
    const needs = decisionNeeds({ decision: 'approved', payeeIsOriginalAccount: 'no' });

    expect(needs.acknowledgement).toBe(true);
  });

  it('⭐ never sends the acknowledgement on an ordinary approval', () => {
    /*
     * The mistake that would look like it worked. Attaching `acknowledgeDifferentAccount:
     * true` to every approval satisfies the schema — it is `.optional()` — and dissolves the
     * whole control: the second act stops being second, and nobody has to read the field
     * that says the account is unrecognised.
     */
    const body = decisionBody({
      decision: 'approved',
      payeeIsOriginalAccount: 'yes',
      acknowledged: true,
      noteTh: '',
    });

    expect(body).toStrictEqual({ decision: 'approved' });
    expect(body).not.toHaveProperty('acknowledgeDifferentAccount');
  });

  it('sends it exactly when the account is different and somebody ticked it', () => {
    expect(
      decisionBody({
        decision: 'approved',
        payeeIsOriginalAccount: 'no',
        acknowledged: true,
        noteTh: '',
      }),
    ).toStrictEqual({ decision: 'approved', acknowledgeDifferentAccount: true });
  });

  it('⚠️ is not ready while the different-account box is unticked', () => {
    /*
     * Disabled rather than sent-and-refused. The service enforces this too, and a screen that
     * leaned on the 422 would teach the rule through a failure message — which is the one
     * place a reviewer is least likely to read the words "unrecognised account".
     */
    expect(
      decisionNeeds({ decision: 'approved', payeeIsOriginalAccount: 'no' }).ready({
        acknowledged: false,
        noteTh: '',
      }),
    ).toBe(false);

    expect(
      decisionNeeds({ decision: 'approved', payeeIsOriginalAccount: 'no' }).ready({
        acknowledged: true,
        noteTh: '',
      }),
    ).toBe(true);
  });
});

describe('what a rejection needs', () => {
  it('demands a note, whatever the account', () => {
    for (const payee of ['yes', 'no'] as const) {
      const needs = decisionNeeds({ decision: 'rejected', payeeIsOriginalAccount: payee });

      expect(needs.note, `a rejection to a ${payee} account did not ask for a note`).toBe(true);
      expect(needs.ready({ acknowledged: false, noteTh: '   ' })).toBe(false);
      expect(needs.ready({ acknowledged: false, noteTh: 'บัญชีปลายทางไม่ตรงกับที่แจ้ง' })).toBe(true);
    }
  });

  it('⚠️ never asks a rejection to acknowledge anything', () => {
    /*
     * Refusing to send money somewhere does not need the approval that sending it would. The
     * acknowledgement is about a payment leaving for an unrecognised account; a rejection is
     * the payment not leaving at all.
     */
    const needs = decisionNeeds({ decision: 'rejected', payeeIsOriginalAccount: 'no' });

    expect(needs.acknowledgement).toBe(false);
    expect(
      decisionBody({
        decision: 'rejected',
        payeeIsOriginalAccount: 'no',
        acknowledged: true,
        noteTh: 'ไม่อนุมัติ',
      }),
    ).toStrictEqual({ decision: 'rejected', noteTh: 'ไม่อนุมัติ' });
  });

  it('trims the note and drops it when it is only whitespace', () => {
    expect(
      decisionBody({
        decision: 'approved',
        payeeIsOriginalAccount: 'yes',
        acknowledged: false,
        noteTh: '   ',
      }),
    ).toStrictEqual({ decision: 'approved' });
  });
});
