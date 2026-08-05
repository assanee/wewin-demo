import { describe, expect, it } from 'vitest';

import { QUOTE_REVISION_PATTERN } from '@wewin/contract/quote';

import { quoteRevision, type RevisionLine, type RevisionOverride } from '../../src/quotes/revision';

/**
 * The optimistic-concurrency token — plan 7.9(จ)'s `quoteRevision`.
 *
 * It is a digest over the live content rather than a counter, and the properties that makes it
 * usable are the ones below. The one that is easy to get wrong is the third: a token that
 * changed when nothing did would turn the 409 into noise, and a UI that meets a spurious
 * conflict twice learns to retry blindly — at which point the mechanism protects nothing.
 */

const line = (over: Partial<RevisionLine> = {}): RevisionLine => ({
  id: '11111111-1111-4111-8111-111111111111',
  seq: 1,
  kind: 'catalog',
  productVersionId: '22222222-2222-4222-8222-222222222222',
  skuCode: 'SLD-W-T6-STD',
  selections: { glass: 'T6' },
  measures: { width: '3200000' },
  qty: 2,
  computedTotalThbMinor: 879_100n,
  chargeTotalThbMinor: null,
  isVatApplicable: true,
  customerDescriptionTh: null,
  ...over,
});

const override = (over: Partial<RevisionOverride> = {}): RevisionOverride => ({
  id: '33333333-3333-4333-8333-333333333333',
  anchor: 'line_total',
  quoteLineId: '11111111-1111-4111-8111-111111111111',
  computedThbMinor: 879_100n,
  overrideThbMinor: 850_000n,
  computedDays: null,
  overrideDays: null,
  ...over,
});

describe('the token', () => {
  it('is the width the contract advertises', () => {
    expect(quoteRevision([line()], [])).toMatch(QUOTE_REVISION_PATTERN);
  });

  it('is the same for two identical quotes, however their rows arrived', () => {
    const a = quoteRevision([line(), line({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', seq: 2 })], []);
    const b = quoteRevision([line({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', seq: 2 }), line()], []);

    expect(a).toBe(b);
  });

  /*
   * ⭐ The property that keeps the 409 meaningful. If this went red — if a timestamp or a row
   * order leaked into the digest — every second editor would be told the quote had moved when
   * it had not.
   */
  it('does not change when nothing about the quote changed', () => {
    expect(quoteRevision([line()], [override()])).toBe(quoteRevision([line()], [override()]));
  });

  it.each([
    ['a quantity', line({ qty: 3 })],
    ['a computed figure', line({ computedTotalThbMinor: 900_000n })],
    ['a selection', line({ selections: { glass: 'T8' } })],
    ['a measurement', line({ measures: { width: '3200001' } })],
    ['taxability', line({ isVatApplicable: false })],
    ['the sentence the customer reads', line({ customerDescriptionTh: 'กระจกเทมเปอร์ 8 มม.' })],
  ])('changes when %s changes', (_label, changed) => {
    expect(quoteRevision([changed], [])).not.toBe(quoteRevision([line()], []));
  });

  it('changes when a promise is made, changed or withdrawn', () => {
    const none = quoteRevision([line()], []);
    const promised = quoteRevision([line()], [override()]);
    const changed = quoteRevision([line()], [override({ overrideThbMinor: 820_000n })]);

    expect(new Set([none, promised, changed]).size).toBe(3);
  });

  /*
   * The digest carries money as digits, never as a JSON number: `JSON.parse` on a large
   * integer loses precision, and a token that was stable across a satang would be silent about
   * exactly the change this feature exists to record.
   */
  it('distinguishes amounts a JSON number could not', () => {
    const big = 9_007_199_254_740_993n;
    expect(quoteRevision([line({ computedTotalThbMinor: big })], [])).not.toBe(
      quoteRevision([line({ computedTotalThbMinor: big - 1n })], []),
    );
  });
});
