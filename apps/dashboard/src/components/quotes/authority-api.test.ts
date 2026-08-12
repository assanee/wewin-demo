import { describe, expect, it } from 'vitest';

import { decodeAssessment } from './authority-api';

/**
 * The hand-narrowed assessment, tested where hand-narrowing goes wrong.
 *
 * These shapes are not in `@wewin/contract` yet — `authority.contract.ts` says they move there
 * when somebody builds the approver's screen — so there is no schema doing this checking for
 * us, and "narrow, never cast" is only true if something proves the narrowing runs.
 *
 * Two of the assertions below are about a decision that has legal weight rather than a shape:
 *
 *   **the three ceiling answers stay three.** `{ known: false }` is "this response says
 *   nothing about your ceiling"; `{ known: true, thbMinor: null }` is *no `authority_limits`
 *   row*, fail-closed, this role may concede nothing at all; `{ known: true, thbMinor: 0n }`
 *   is a row saying "may record concessions, may approve none of its own". Collapsing any two
 *   of them is how a placeholder gets mistaken for an answer, which is what plan 13 exists to
 *   stop — and the first two *were* collapsed until the wire grew `known`.
 *
 *   **money arrives as a bare digit string.** These endpoints do not use the `{unit, digits}`
 *   envelope the rest of the system does, so nothing in the payload says "satang". The regex
 *   is all that stands between a malformed amount and a `BigInt` throw three components deep.
 */

const DIMENSION = {
  dimension: 'margin',
  concessionThbMinor: '29100',
  sources: [
    {
      kind: 'line_override',
      amountThbMinor: '29100',
      quoteLineId: '00000000-0000-4000-8000-0000000000b1',
      overrideId: '00000000-0000-4000-8000-0000000000d1',
      reasonCode: 'price_match',
    },
  ],
  outcome: 'needs_approval',
  ceiling: { known: true, thbMinor: null },
  approvalId: null,
} as const;

const ASSESSMENT = {
  orderId: '00000000-0000-4000-8000-000000000001',
  orderNo: 'ORD-0001',
  margin: DIMENSION,
  cashflow: {
    dimension: 'cashflow',
    concessionThbMinor: '0',
    sources: [],
    outcome: 'nothing_conceded',
    ceiling: { known: false },
    approvalId: null,
  },
  allowed: false,
} as const;

describe('decoding an assessment', () => {
  it('widens the digit strings into satang and keeps the sources', () => {
    const assessment = decodeAssessment(ASSESSMENT);

    expect(assessment.margin.concessionThbMinor).toBe(29_100n);
    expect(assessment.margin.sources[0]?.amountThbMinor).toBe(29_100n);
    expect(assessment.margin.sources[0]?.reasonCode).toBe('price_match');
    expect(assessment.allowed).toBe(false);
  });

  /**
   * ⭐ Three answers, and the decoder keeps all three apart.
   *
   * `{ known: false }` is *"this response says nothing about your ceiling"*, and it is the one
   * that used to be indistinguishable — the wire flattened it into the same `null` as "no row",
   * and the panel printed the fail-closed sentence on both. `known` is read from the payload
   * and never inferred, so a response that dropped it is malformed rather than permissive.
   */
  it('keeps “did not say”, “no authority row” and “a ceiling of zero” apart — plan 13', () => {
    const assessment = decodeAssessment(ASSESSMENT);

    expect(assessment.margin.ceiling).toEqual({ known: true, thbMinor: null });
    expect(assessment.cashflow.ceiling).toEqual({ known: false });

    const zero = decodeAssessment({
      ...ASSESSMENT,
      margin: { ...DIMENSION, ceiling: { known: true, thbMinor: '0' } },
    });
    expect(zero.margin.ceiling).toEqual({ known: true, thbMinor: 0n });
  });

  /** An absent or non-boolean `known` is a decode failure, never a quiet `{ known: false }`. */
  it('refuses a ceiling whose known flag is missing rather than assuming silence', () => {
    expect(() =>
      decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, ceiling: { thbMinor: null } } }),
    ).toThrow(/known/u);

    expect(() =>
      decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, ceiling: { known: true } } }),
    ).toThrow(/thbMinor/u);
  });

  it('refuses an amount that is not canonical digits rather than throwing later', () => {
    for (const bad of ['', ' 29100 ', '029100', '29,100', '29100.00', 'lots', 29_100]) {
      expect(() =>
        decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, concessionThbMinor: bad } }),
      ).toThrow(/concessionThbMinor/);
    }
  });

  it('refuses an outcome this build has not been taught, naming the offender', () => {
    expect(() =>
      decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, outcome: 'escalated' } }),
    ).toThrow(/escalated/);
  });

  it('refuses a verdict that is not a boolean rather than reading it as false', () => {
    /*
     * The dangerous coercion: `allowed: 'false'` is truthy and `allowed: undefined` is not, so
     * a missing field read loosely would silently unblock or silently block a send. Neither is
     * a state anybody chose.
     */
    expect(() => decodeAssessment({ ...ASSESSMENT, allowed: 'false' })).toThrow(/allowed/);
    expect(() => decodeAssessment({ ...ASSESSMENT, allowed: undefined })).toThrow(/allowed/);
  });

  it('refuses a sources list that is not a list', () => {
    expect(() =>
      decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, sources: null } }),
    ).toThrow(/sources/);
  });

  it('refuses an unknown dimension, so a third one cannot arrive unannounced', () => {
    expect(() =>
      decodeAssessment({ ...ASSESSMENT, margin: { ...DIMENSION, dimension: 'lead_time' } }),
    ).toThrow(/lead_time/);
  });
});
