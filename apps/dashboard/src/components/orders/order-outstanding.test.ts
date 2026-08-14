import { describe, expect, it } from 'vitest';

import {
  NO_FIGURE_TH,
  outstandingDisplay,
  readOutstanding,
  SETTLED_TH,
} from './order-outstanding';

/**
 * ⚠️ Whole strings with `toBe`, never `toContain` — the house rule, and the trap is live here:
 * `'฿4,200'` is a substring of `'฿14,200'`, so a containment assertion on a baht figure passes
 * for the wrong money.
 *
 * The cases are the four the API can actually produce (`list-outstanding.pg.test.ts` seeds the
 * same four against a real database), plus the two shapes that are not supposed to arrive and
 * would be silent if they did.
 */

describe('readOutstanding', () => {
  it('reads a withheld figure as no figure rather than as settled', () => {
    /*
     * The whole reason the API nulls these instead of sending the fold's honest ฿0.00. A cart
     * has settled nothing, and "ชำระครบแล้ว" on a draft would be a claim about money that was
     * never agreed.
     */
    expect(readOutstanding({ outstandingThbMinor: null, nextDueThbMinor: null })).toEqual({
      kind: 'noFigure',
    });
  });

  it('reads a cancelled order the same way, and never as settled or as owing', () => {
    /*
     * ⭐ The second reason the API withholds these, and the one this state was renamed for. A
     * cancelled order **has** a grand total and **has** an unpaid remainder — Postgres still
     * folds it, because a refund is priced from exactly that number — and owes nobody. The
     * wire therefore sends null while `grandTotalThbMinor` stays present, which is a shape a
     * cart can never produce.
     *
     * Both wrong answers are ruled out by name here: "฿14,791.68" would bill a customer for an
     * order they cancelled, and "ชำระครบแล้ว" would claim a contract was settled that was
     * abandoned, possibly with the company still holding their deposit.
     */
    const reading = readOutstanding({ outstandingThbMinor: null, nextDueThbMinor: null });

    expect(reading).toEqual({ kind: 'noFigure' });
    expect(outstandingDisplay(reading).textTh).toBe(NO_FIGURE_TH);
    expect(outstandingDisplay(reading).textTh).not.toBe(SETTLED_TH);
    expect(outstandingDisplay(reading).emphasis).toBe('quiet');
  });

  it('reads a paid-off order as settled, and settled is a word rather than ฿0', () => {
    const reading = readOutstanding({ outstandingThbMinor: 0n, nextDueThbMinor: 0n });

    expect(reading).toEqual({ kind: 'settled' });
    expect(outstandingDisplay(reading)).toEqual({ textTh: SETTLED_TH, emphasis: 'quiet' });
    expect(outstandingDisplay(reading).textTh).not.toBe('฿0');
  });

  it('gives an unpaid pay-in-full order one figure, not two copies of one figure', () => {
    /* `outstanding === nextDue` — the whole contract is due now. */
    const reading = readOutstanding({
      outstandingThbMinor: 1_420_000n,
      nextDueThbMinor: 1_420_000n,
    });

    expect(reading).toEqual({
      kind: 'owing',
      outstandingThbMinor: 1_420_000n,
      nextDueThbMinor: 1_420_000n,
      nextDueIsWholeDebt: true,
    });
  });

  it('separates the deposit from the balance on a 30/70', () => {
    /*
     * The case the two folds exist for: ฿14,200 owed on the order, ฿4,260 of it due now. A
     * screen with one field has to pick, and picking the outstanding asks the customer for the
     * whole contract where the quotation promised a deposit.
     */
    const reading = readOutstanding({
      outstandingThbMinor: 1_420_000n,
      nextDueThbMinor: 426_000n,
    });

    expect(reading).toEqual({
      kind: 'owing',
      outstandingThbMinor: 1_420_000n,
      nextDueThbMinor: 426_000n,
      nextDueIsWholeDebt: false,
    });
  });

  it('still owes the balance after the deposit is accepted', () => {
    /* Both figures are the balance now — neither ฿0 nor the deposit. */
    const reading = readOutstanding({ outstandingThbMinor: 994_000n, nextDueThbMinor: 994_000n });

    expect(reading).toEqual({
      kind: 'owing',
      outstandingThbMinor: 994_000n,
      nextDueThbMinor: 994_000n,
      nextDueIsWholeDebt: true,
    });
  });

  it('never invents a smaller amount due when the next-due figure is missing', () => {
    /*
     * Half a contract: the API sends both fields or neither, so this is a shape that should not
     * arrive. If it does, overstating what is due today is recoverable and understating it is
     * not — somebody reads "฿0 due" on a live debt and stops chasing it.
     */
    const reading = readOutstanding({ outstandingThbMinor: 1_420_000n, nextDueThbMinor: null });

    expect(reading).toEqual({
      kind: 'owing',
      outstandingThbMinor: 1_420_000n,
      nextDueThbMinor: 1_420_000n,
      nextDueIsWholeDebt: true,
    });
  });

  it('reads a credit as owing nothing rather than as a negative debt', () => {
    expect(readOutstanding({ outstandingThbMinor: -50_000n, nextDueThbMinor: 0n })).toEqual({
      kind: 'settled',
    });
  });

  it('compares the two figures as bigint, not as double', () => {
    /*
     * ⚠️ Load-bearing. `Number(9007199254740993n)` is `9007199254740992` — the same double as
     * the next-due below it — so a `Number()` anywhere on this comparison reports the balance as
     * "the whole debt" and the order's detail screen silently loses the row that says otherwise.
     * These are satang, and satang is why the contract carries them as bigint.
     */
    const reading = readOutstanding({
      outstandingThbMinor: 9_007_199_254_740_993n,
      nextDueThbMinor: 9_007_199_254_740_992n,
    });

    expect(reading).toEqual({
      kind: 'owing',
      outstandingThbMinor: 9_007_199_254_740_993n,
      nextDueThbMinor: 9_007_199_254_740_992n,
      nextDueIsWholeDebt: false,
    });
  });
});

describe('outstandingDisplay', () => {
  it('renders a debt through the app formatter, with weight', () => {
    expect(outstandingDisplay(readOutstanding({ outstandingThbMinor: 1_420_000n, nextDueThbMinor: 426_000n }))).toEqual(
      { textTh: '฿14,200', emphasis: 'debt' },
    );
  });

  it('renders the outstanding total and never the amount due now', () => {
    /*
     * The cell answers "who owes", which is the whole debt. The deposit is a different question
     * and lives on the order's own screen, where there is room to label it.
     */
    expect(
      outstandingDisplay(readOutstanding({ outstandingThbMinor: 1_420_000n, nextDueThbMinor: 426_000n })).textTh,
    ).not.toBe('฿4,260');
  });

  it('renders a withheld figure as the same dash the grand total uses', () => {
    expect(
      outstandingDisplay(readOutstanding({ outstandingThbMinor: null, nextDueThbMinor: null })),
    ).toEqual({ textTh: NO_FIGURE_TH, emphasis: 'quiet' });
  });

  it('keeps settled quiet — a paid order must not compete with a real debt', () => {
    expect(
      outstandingDisplay(readOutstanding({ outstandingThbMinor: 0n, nextDueThbMinor: 0n })).emphasis,
    ).toBe('quiet');
    expect(
      outstandingDisplay(readOutstanding({ outstandingThbMinor: 1n, nextDueThbMinor: 1n })).emphasis,
    ).toBe('debt');
  });
});
