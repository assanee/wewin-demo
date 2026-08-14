import { describe, expect, it } from 'vitest';

import { describeOwedFigures } from './owedFigures';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE LIST AND THE PAYMENT SCREEN, ON THE SAME NUMBER.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WW-1038's ฿14,400.00 on a 30/70 schedule — the same order `quotationRowMoney.test.ts`
 * and `payment-entry.test.ts` walk, at the same four moments, so this file's cases are one
 * order through its life rather than four invented ones.
 *
 * ⚠️ A `.test.ts` beside a `.ts`, on purpose: this app's vitest runs `environment: 'node'`
 * and a `.test.tsx` is silently never collected. The markup renders what this returns; the
 * decision is here, where a test can reach it.
 */

const TOTAL = 1_440_000n; // ฿14,400.00
const DEPOSIT = 432_000n; // ฿4,320.00 — 30%
const BALANCE = 1_008_000n; // ฿10,080.00 — 70%

describe('a deposit is due — the 30/70 order nobody has paid yet', () => {
  const figures = describeOwedFigures(TOTAL, DEPOSIT);

  it('⭐ leads with what is being asked for and keeps the whole debt beneath it', () => {
    /*
     * ⚠️ THE ASSERTION BOTH SCREENS TURN ON. ฿4,320.00 prominent, ฿14,400.00 supporting.
     * Swapping them shows a customer a number the payment field will not open on, which was
     * the original bug on the payment screen and is the one this module exists to prevent
     * from coming back on either side of the click.
     */
    expect(figures).toStrictEqual([
      { labelKey: 'payment.dueNow', amountMinor: DEPOSIT, emphasis: 'lead' },
      { labelKey: 'payment.outstanding', amountMinor: TOTAL, emphasis: 'quiet' },
    ]);
  });

  it('names the outstanding as well, so the lead figure is never read as the whole bill', () => {
    /* The pairing is the point. A screen that showed only ฿4,320.00 would be the mirror of
     * the bug: a customer would think the order cost ฿4,320.00. */
    expect(figures.map((figure) => figure.amountMinor)).toStrictEqual([DEPOSIT, TOTAL]);
  });

  it('gives exactly one figure the lead', () => {
    expect(figures.filter((figure) => figure.emphasis === 'lead')).toHaveLength(1);
  });
});

describe('the balance is due — the same order once the deposit has been accepted', () => {
  /* Both folds now answer ฿10,080.00: it is the whole remaining debt *and* the remainder of
   * the only unsettled instalment. */
  it('⭐ prints the number once, not twice under two labels', () => {
    expect(describeOwedFigures(BALANCE, BALANCE)).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: BALANCE, emphasis: 'lead' },
    ]);
  });
});

describe('a pay-in-full order — one instalment, so one figure from the start', () => {
  it('⭐ says it once, under the outstanding label', () => {
    /* `order_next_due_thb_minor()` answers the full amount when no deposit is scheduled, so
     * the two folds are equal from the moment the order is submitted. "ยอดที่ต้องชำระตอนนี้"
     * would be true here and would still be wrong: a second label asserts a distinction, and
     * there is none to assert. */
    expect(describeOwedFigures(TOTAL, TOTAL)).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: TOTAL, emphasis: 'lead' },
    ]);
  });

  it('the dueNow label is reached only when the two figures genuinely differ', () => {
    /* Stated as a property over every shape an order can be in, because it is the rule the
     * module argues for and not a fact about one case. */
    const labels = (outstanding: bigint, nextDue: bigint): readonly string[] =>
      describeOwedFigures(outstanding, nextDue).map((figure) => figure.labelKey);

    expect(labels(TOTAL, TOTAL)).not.toContain('payment.dueNow');
    expect(labels(BALANCE, BALANCE)).not.toContain('payment.dueNow');
    expect(labels(0n, 0n)).not.toContain('payment.dueNow');
    expect(labels(-15_000n, 0n)).not.toContain('payment.dueNow');
    expect(labels(TOTAL, DEPOSIT)).toContain('payment.dueNow');
  });
});

describe('the shapes that are not a live debt', () => {
  it('a settled order states ฿0.00 outstanding, as the payment screen always did', () => {
    /* `PaymentIsland` keeps a figure on screen beside its "paid in full" box; a screen that
     * dropped the amount entirely would read as one that failed to load. The caller decides
     * to add that sentence — this only says which amount is on the line above it. */
    expect(describeOwedFigures(0n, 0n)).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: 0n, emphasis: 'lead' },
    ]);
  });

  it('an overpayment is a modelled state and keeps its negative figure', () => {
    /* `order_outstanding_thb_minor()` has no floor at zero and the slip-review screen models
     * an excess. Clamping it here would hide a real one from the customer it happened to. */
    expect(describeOwedFigures(-15_000n, 0n)).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: -15_000n, emphasis: 'lead' },
    ]);
  });

  it('⚠️ a next-due of zero beside a real debt shows the debt, not ฿0.00', () => {
    /* Not a state the two SQL folds should produce together. If they ever do, the screen says
     * the true thing rather than inviting a transfer of nothing. */
    expect(describeOwedFigures(BALANCE, 0n)).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: BALANCE, emphasis: 'lead' },
    ]);
  });
});
