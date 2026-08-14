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
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const ME = '33333333-3333-4333-8333-333333333333';

  it('says nothing at all about a slip somebody else entered', () => {
    expect(
      selfReviewState({ viewerUserId: ME, submittedByUserId: OTHER, holdsBypass: true }),
    ).toEqual({ kind: 'not_mine' });
  });

  it('blocks the reviewer who entered it and holds no bypass, and names the remedy', () => {
    const state = selfReviewState({
      viewerUserId: ME,
      submittedByUserId: ME,
      holdsBypass: false,
    });

    expect(state.kind).toBe('blocked');
    /* `รับรอง` is the word these screens already use. No new vocabulary. */
    if (state.kind === 'blocked') expect(state.messageTh).toContain('รับรอง');
  });

  /*
   * ⭐ The bypass the owner chose, and the price of it. Holding the permission is not enough —
   * the screen asks for the sentence, and the API and the trigger both refuse without it.
   */
  it('asks the holder of the bypass for a reason rather than letting them straight through', () => {
    const state = selfReviewState({ viewerUserId: ME, submittedByUserId: ME, holdsBypass: true });

    expect(state.kind).toBe('must_declare');
    if (state.kind === 'must_declare') expect(state.messageTh).toContain('เหตุผล');
  });

  it('claims nothing when the session or the submitter is unknown', () => {
    /*
     * A customer's copy of the wire carries `submittedByUserId: null` by design, and the session
     * is null for a beat on first paint. Both must read as "not mine" — this function is
     * presentation, and the API is the control, so guessing here can only produce a screen that
     * is wrong in the direction of offering a button the server then refuses.
     */
    expect(
      selfReviewState({ viewerUserId: null, submittedByUserId: ME, holdsBypass: true }),
    ).toEqual({ kind: 'not_mine' });
    expect(
      selfReviewState({ viewerUserId: ME, submittedByUserId: null, holdsBypass: true }),
    ).toEqual({ kind: 'not_mine' });
  });
});
