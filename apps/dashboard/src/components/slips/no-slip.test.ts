import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIN_REASON_LENGTH,
  evidenceLabelTh,
  recordFormBody,
  selfReviewState,
  slipEvidence,
} from './no-slip';

/**
 * ⚠️ `.test.ts`, not `.test.tsx`. `apps/dashboard`'s vitest is `environment: 'node'` and the
 * include list is `tests/**` plus `src/**\/*.test.ts` — a `.tsx` beside a component is silently
 * never collected, and a suite that cannot run is not evidence. Everything asserted below is
 * therefore deliberately outside the React component that renders it.
 */

const NOW = new Date('2026-08-14T10:00:00.000Z');

const form = (over: Partial<Parameters<typeof recordFormBody>[0]> = {}) => ({
  orderId: '11111111-1111-4111-8111-111111111111',
  amount: '5,529.60',
  transferredAtLocal: '2026-08-14T09:30',
  noSlipReasonTh: 'ลูกค้าโอนแล้วแจ้งทางโทรศัพท์ ไม่ได้ส่งสลิป',
  bankReference: '',
  payerName: '',
  payerAccountLast4: '',
  ...over,
});

describe('which of the three kinds of evidence a slip carries', () => {
  /*
   * ⭐ THE DISTINCTION THIS MODULE EXISTS FOR. Two of the three have no image, and a screen that
   * keyed off `hasImage` would put the "staff recorded this" marker on a customer's slip whose
   * picture a PDPA erasure destroyed — a marker meaning the opposite of the truth.
   */
  it('separates a PDPA erasure from a payment nobody photographed', () => {
    expect(
      slipEvidence({ hasImage: true, imageErasedAt: null, noSlipReasonTh: null }),
    ).toBe('image');

    expect(
      slipEvidence({
        hasImage: false,
        imageErasedAt: '2026-08-01T00:00:00.000Z',
        noSlipReasonTh: null,
      }),
    ).toBe('erased');

    expect(
      slipEvidence({ hasImage: false, imageErasedAt: null, noSlipReasonTh: 'โอนแล้วไม่ได้แนบ' }),
    ).toBe('recorded');
  });

  it('says a staff entry is a staff entry even beside an erasure stamp', () => {
    /* When the two columns disagree, what matters to an auditor is that a person entered it. */
    expect(
      slipEvidence({
        hasImage: false,
        imageErasedAt: '2026-08-01T00:00:00.000Z',
        noSlipReasonTh: 'โอนแล้วไม่ได้แนบ',
      }),
    ).toBe('recorded');
  });

  it('labels each state in words that already exist on these screens', () => {
    expect(
      evidenceLabelTh({ hasImage: false, imageErasedAt: null, noSlipReasonTh: 'x' }),
    ).toContain('ไม่มีสลิป');
    expect(evidenceLabelTh({ hasImage: true, imageErasedAt: null, noSlipReasonTh: null })).toContain(
      'สลิป',
    );
  });
});

describe('the recording form', () => {
  it('turns a filled form into a request in satang', () => {
    const result = recordFormBody(form(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /* ⛔ `bigint` satang, never a float. `5,529.60` is 552960 and the comma is not a decimal. */
    expect(result.body.amountThbMinor).toEqual({ unit: 'THB.satang', digits: '552960' });
    expect(result.body.transferredAt).toBe(new Date('2026-08-14T09:30').toISOString());
    expect(result.body.noSlipReasonTh).toContain('ไม่ได้ส่งสลิป');
    /* Absent rather than empty: the schema is a `strictObject` and `''` is not a bank reference. */
    expect(result.body.bankReference).toBeUndefined();
    expect(result.body.payerName).toBeUndefined();
  });

  /*
   * ⭐ THE ASSERTION THE OWNER'S "แต่ต้องระบุเหตุผล" RESTS ON at this layer. Delete the length
   * check in `recordFormBody` and this is what goes red — the server still refuses, but the
   * person finds out after a round trip instead of under the box.
   */
  it('refuses a reason too thin to audit, and one made of spaces', () => {
    const thin = recordFormBody(form({ noSlipReasonTh: 'ไม่มี' }), NOW);
    expect(thin.ok).toBe(false);
    if (thin.ok) return;
    expect(thin.problemsTh.join(' ')).toContain(String(MIN_REASON_LENGTH));

    const blank = recordFormBody(form({ noSlipReasonTh: '                    ' }), NOW);
    expect(blank.ok).toBe(false);
  });

  it('refuses a transfer time in the future, and one that is not a time at all', () => {
    const future = recordFormBody(form({ transferredAtLocal: '2027-01-01T09:00' }), NOW);
    expect(future.ok).toBe(false);
    if (future.ok) return;
    expect(future.problemsTh.join(' ')).toContain('อนาคต');

    expect(recordFormBody(form({ transferredAtLocal: '' }), NOW).ok).toBe(false);
    expect(recordFormBody(form({ transferredAtLocal: 'เมื่อวาน' }), NOW).ok).toBe(false);
  });

  it('refuses an amount that is not money, and zero', () => {
    expect(recordFormBody(form({ amount: 'ห้าพัน' }), NOW).ok).toBe(false);
    expect(recordFormBody(form({ amount: '0' }), NOW).ok).toBe(false);
    expect(recordFormBody(form({ amount: '-100' }), NOW).ok).toBe(false);
  });

  it('reports every problem at once, not the first one', () => {
    /*
     * A person keying a telephoned transfer has four boxes to get right; a form that reveals one
     * mistake per submission is a form they will send four times.
     */
    const result = recordFormBody(
      form({ amount: 'x', noSlipReasonTh: 'สั้น', payerAccountLast4: '12' }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problemsTh.length).toBe(3);
  });

  it('sends four digits or nothing, never two', () => {
    expect(recordFormBody(form({ payerAccountLast4: '12' }), NOW).ok).toBe(false);

    const good = recordFormBody(form({ payerAccountLast4: '4321' }), NOW);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.body.payerAccountLast4).toBe('4321');
  });
});

describe('🔒 what the review screen says before one person does both halves', () => {
  it('says nothing at all about a slip somebody else entered', () => {
    expect(selfReviewState({ viewerIsSubmitter: false, holdsBypass: true })).toEqual({
      kind: 'not_mine',
    });
  });

  it('blocks the reviewer who entered it and holds no bypass, and names the remedy', () => {
    const state = selfReviewState({ viewerIsSubmitter: true, holdsBypass: false });

    expect(state.kind).toBe('blocked');
    /* `รับรอง` is the word these screens already use. No new vocabulary. */
    if (state.kind === 'blocked') expect(state.messageTh).toContain('รับรอง');
  });

  /*
   * ⭐ The bypass the owner chose, and the price of it. Holding the permission is not enough —
   * the screen asks for the sentence, and the API and the trigger both refuse without it.
   */
  it('asks the holder of the bypass for a reason rather than letting them straight through', () => {
    const state = selfReviewState({ viewerIsSubmitter: true, holdsBypass: true });

    expect(state.kind).toBe('must_declare');
    if (state.kind === 'must_declare') expect(state.messageTh).toContain('เหตุผล');
  });

  /*
   * ⭐ THE GUEST CART, ON THE SCREEN — the dashboard half of the walk `viewer-is-submitter.pg.test.ts`
   * runs over HTTP.
   *
   * A slip uploaded from an anonymous cart that this reviewer later signed into carries
   * `submitted_by_user_id = NULL`; `slip_submitter_user_ids()` resolves it to them anyway, so the
   * wire says `viewerIsSubmitter: true` with no user id in sight. This function must ask for the
   * declaration on exactly that input — the old comparison saw the null, answered `not_mine`,
   * rendered no textarea, and the 403 that followed named a field the screen did not have.
   */
  it('⭐ asks for the declaration on a guest-cart slip the reviewer later claimed', () => {
    expect(selfReviewState({ viewerIsSubmitter: true, holdsBypass: true }).kind).toBe(
      'must_declare',
    );
    expect(selfReviewState({ viewerIsSubmitter: true, holdsBypass: false }).kind).toBe('blocked');
  });

  it('claims nothing while the review has not loaded', () => {
    /*
     * The dialog passes `review?.viewerIsSubmitter ?? false` — there is no slip on the screen yet
     * and no buttons to warn about. It reads as "not mine" for the same reason it now reads as
     * anything at all: the fact is the server's, and before the response there is no fact.
     */
    expect(selfReviewState({ viewerIsSubmitter: false, holdsBypass: false })).toEqual({
      kind: 'not_mine',
    });
  });
});

/**
 * ⚠️ THE INFERENCE ITSELF, PINNED SHUT.
 *
 * The bug was not a wrong comparison so much as a client holding the ingredients to make one. Both
 * of these read source text, which is exactly what the assertion is about — a screen that computes
 * "is this mine?" from an id it decoded, whatever the arithmetic, is the same dead end again.
 */
describe('⚠️ no dashboard screen re-derives whose slip this is', () => {
  const read = (path: string): string => readFileSync(path, 'utf8');

  it('does not decode `submittedByUserId` into the client shape at all', () => {
    const source = read('src/components/slips/slip-api.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

    /* The comment explaining the absence stays; the field and its decode do not. */
    expect(source).toContain('submittedByUserId');
    expect(code).not.toContain('submittedByUserId');

    /* And the fact that replaced it is decoded strictly, never `=== true`. */
    expect(code).toContain("asBoolean(review['viewerIsSubmitter'], 'review.viewerIsSubmitter')");
  });

  it('feeds the review dialog the wire’s boolean rather than the session', () => {
    const code = read('src/components/slips/slip-review-dialog.tsx')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');

    expect(code).toContain('viewerIsSubmitter: review?.viewerIsSubmitter ?? false');
    expect(code).not.toContain('submittedByUserId');
    /* The session still answers the permission question, and only that one. */
    expect(code).not.toContain('session.principal.userId');
  });
});
