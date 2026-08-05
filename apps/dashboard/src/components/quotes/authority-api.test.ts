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
 *   **a null ceiling stays null.** It means *no `authority_limits` row*, which is fail-closed:
 *   this role may concede nothing at all. Widening it to `0n` would render as "a ceiling of
 *   zero", which is a different sentence — a role that may record concessions and approve none
 *   of its own. Plan 13 exists to keep exactly this kind of placeholder from being mistaken
 *   for an answer.
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
  ceilingThbMinor: null,
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
    ceilingThbMinor: '0',
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

  it('keeps “no authority row” distinct from “a ceiling of zero” — plan 13', () => {
    const assessment = decodeAssessment(ASSESSMENT);

    expect(assessment.margin.ceilingThbMinor).toBeNull();
    expect(assessment.cashflow.ceilingThbMinor).toBe(0n);
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
