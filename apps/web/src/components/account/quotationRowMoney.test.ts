import { describe, expect, it } from 'vitest';

import { describeRowMoney, type RowFigures } from './quotationRowMoney';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE FIVE ROWS A CUSTOMER CAN ACTUALLY HAVE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The figures below are one real order carried through its life — WW-1038's ฿14,400.00 on a
 * 30/70 schedule, the same numbers `payment-entry.test.ts` walks the payment screen with —
 * so the four owing/settled cases are the *same* order at four moments rather than four
 * invented ones. A test that changes the amount between cases cannot show that the pair
 * moves together.
 *
 * ⚠️ This is a `.test.ts` and the module under it is a `.ts` on purpose: this app's vitest
 * runs `environment: 'node'` and a `.test.tsx` is never collected — it would report as
 * coverage while asserting nothing. The markup renders what this returns; the decision is
 * here, where a test can reach it.
 */

const TOTAL = 1_440_000n; // ฿14,400.00
const DEPOSIT = 432_000n; // ฿4,320.00 — 30%
const BALANCE = 1_008_000n; // ฿10,080.00 — 70%

const row = (figures: Partial<RowFigures>): RowFigures => ({
  totalMinor: TOTAL,
  outstandingMinor: TOTAL,
  nextDueMinor: DEPOSIT,
  ...figures,
});

describe('nothing owed — a delivered order that has been paid for', () => {
  const money = describeRowMoney(row({ outstandingMinor: 0n, nextDueMinor: 0n }));

  it('asks for nothing, and says so in the payment screen’s own words', () => {
    expect(money.noteKey).toBe('payment.settled');
    expect(money.owes).toBe(false);
  });

  it('still prints what the order came to, unlabelled, as this list always did', () => {
    /* The row must keep reading as a record of the order — a list of past jobs with no
     * amounts on it is worth less than the one this replaces. */
    expect(money.figures).toStrictEqual([
      { labelKey: null, amountMinor: TOTAL, emphasis: 'quiet' },
    ]);
  });

  it('treats an overpayment as settled rather than as an error', () => {
    /* `order_outstanding_thb_minor()` has no floor at zero and the slip-review screen models
     * an excess. `PaymentIsland` reads `<= 0n`; so does this. */
    const overpaid = describeRowMoney(row({ outstandingMinor: -15_000n, nextDueMinor: 0n }));
    expect(overpaid.noteKey).toBe('payment.settled');
    expect(overpaid.owes).toBe(false);
  });
});

describe('a deposit is due — the 30/70 order nobody has paid yet', () => {
  const money = describeRowMoney(row({ outstandingMinor: TOTAL, nextDueMinor: DEPOSIT }));

  it('⭐ leads with what to pay now and keeps the whole debt beneath it', () => {
    /*
     * ⚠️ THE ASSERTION THE TASK TURNS ON. ฿4,320.00 prominent, ฿14,400.00 supporting — the
     * two figures a 30/70 order has, in the order the owner asked for. Swapping them shows a
     * customer a number the payment field will not open on, which is the original bug.
     */
    expect(money.figures).toStrictEqual([
      { labelKey: 'payment.dueNow', amountMinor: DEPOSIT, emphasis: 'lead' },
      { labelKey: 'payment.outstanding', amountMinor: TOTAL, emphasis: 'quiet' },
    ]);
    expect(money.noteKey).toBeNull();
    expect(money.owes).toBe(true);
  });

  it('the prominent figure is the one the payment screen prefills', () => {
    /* `PaymentIsland` opens its amount field on `nextDueThbMinor`. If the lead figure here
     * were the outstanding, the list and the screen one click away would disagree again. */
    expect(money.figures[0]?.amountMinor).toBe(DEPOSIT);
  });
});

describe('the balance is due — the same order once the deposit has been accepted', () => {
  /*
   * Both folds now answer ฿10,080.00: it is the whole remaining debt *and* the remainder of
   * the only unsettled instalment. This is the "both figures equal" case arrived at by
   * paying, rather than by having a one-instalment schedule.
   */
  const money = describeRowMoney(row({ outstandingMinor: BALANCE, nextDueMinor: BALANCE }));

  it('⭐ prints the number once, not twice under two labels', () => {
    expect(money.figures).toHaveLength(1);
    expect(money.figures).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: BALANCE, emphasis: 'lead' },
    ]);
  });

  it('and never prints the deposit that was already paid', () => {
    const printed = money.figures.map((figure) => figure.amountMinor);
    expect(printed).not.toContain(DEPOSIT);
    expect(printed).not.toContain(TOTAL);
    expect(money.owes).toBe(true);
  });
});

describe('a pay-in-full order — one instalment, so one figure from the start', () => {
  const money = describeRowMoney(row({ outstandingMinor: TOTAL, nextDueMinor: TOTAL }));

  it('⭐ says it once, under the label the payment screen uses', () => {
    /*
     * `order_next_due_thb_minor()` answers the full amount when no deposit is scheduled, so
     * this row's two folds are equal from the moment it is submitted. "ยอดที่ต้องชำระตอนนี้"
     * would be true here and would still be wrong: a second label asserts a distinction, and
     * there is none to assert.
     */
    expect(money.figures).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: TOTAL, emphasis: 'lead' },
    ]);
    expect(money.owes).toBe(true);
  });

  it('the dueNow label is reached only by a row that has two different figures', () => {
    /* Stated as a property over all four owing shapes, because it is the rule the header
     * argues for and not a fact about one of them. */
    const labelled = (figures: RowFigures): readonly (string | null)[] =>
      describeRowMoney(figures).figures.map((figure) => figure.labelKey);

    expect(labelled(row({ outstandingMinor: TOTAL, nextDueMinor: TOTAL }))).not.toContain(
      'payment.dueNow',
    );
    expect(labelled(row({ outstandingMinor: BALANCE, nextDueMinor: BALANCE }))).not.toContain(
      'payment.dueNow',
    );
    expect(labelled(row({ outstandingMinor: 0n, nextDueMinor: 0n }))).not.toContain(
      'payment.dueNow',
    );
    expect(labelled(row({ outstandingMinor: TOTAL, nextDueMinor: DEPOSIT }))).toContain(
      'payment.dueNow',
    );
  });
});

describe('the figures the wire can withhold', () => {
  it('a cart carries no money at all, and the row prints none', () => {
    /* All three null together — `encodeOrderSummary` decides it once per row. `MyQuotations`
     * filters these out by `submittedAt` before rendering; this is the shape, not a screen. */
    const money = describeRowMoney({
      totalMinor: null,
      outstandingMinor: null,
      nextDueMinor: null,
    });

    expect(money.figures).toStrictEqual([]);
    expect(money.noteKey).toBeNull();
  });

  it('⚠️ an API without the two folds falls back to the total, and to the status rule', () => {
    /*
     * A bundle newer than the API it is talking to: `grandTotalThbMinor` is there and the two
     * new fields are not. The row must degrade to what this list printed before this task —
     * the total, unlabelled — rather than to a confident "฿0.00 outstanding", which would read
     * as settled and hide the payment action from somebody who owes ฿14,400.
     */
    const money = describeRowMoney({
      totalMinor: TOTAL,
      outstandingMinor: null,
      nextDueMinor: null,
    });

    expect(money.figures).toStrictEqual([
      { labelKey: null, amountMinor: TOTAL, emphasis: 'quiet' },
    ]);
    expect(money.noteKey).toBeNull();
    expect(money.owes, 'the action stays on the status rule alone, as it was').toBe(true);
  });

  it('a next-due of zero beside a real debt shows the debt, not ฿0.00', () => {
    /* Not a state the two SQL folds should produce together. If they ever do, the row says
     * the true thing rather than inviting a transfer of nothing. */
    const money = describeRowMoney(row({ outstandingMinor: BALANCE, nextDueMinor: 0n }));

    expect(money.figures).toStrictEqual([
      { labelKey: 'payment.outstanding', amountMinor: BALANCE, emphasis: 'lead' },
    ]);
    expect(money.owes).toBe(true);
  });
});
