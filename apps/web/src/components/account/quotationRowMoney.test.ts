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
  /* Nothing forgiven unless a case says otherwise — the state of all but a handful of orders. */
  writtenOffMinor: 0n,
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
      writtenOffMinor: null,
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
      writtenOffMinor: null,
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

/**
 * ⭐ ⓸ A row whose remaining balance was **written off** — and it must not say "paid in full".
 *
 * The same falsehood `paymentPanel.ts` was fixed for, one click earlier: this list is the first
 * screen a customer sees, and `outstandingMinor <= 0n` reached `payment.settled` on an order the
 * company had forgiven rather than been paid for.
 */
describe('⭐ ⓸ a row whose balance was written off', () => {
  it('says the balance was written off, not that it was paid', () => {
    const money = describeRowMoney(
      row({ outstandingMinor: 0n, nextDueMinor: 0n, writtenOffMinor: TOTAL }),
    );

    expect(money.noteKey).toBe('payment.writtenOff');
    expect(money.noteKey).not.toBe('payment.settled');
    /* Quiet, and unlabelled: the order's own total, exactly as the settled row prints it. */
    expect(money.figures).toStrictEqual([
      { labelKey: null, amountMinor: TOTAL, emphasis: 'quiet' },
    ]);
    expect(money.owes).toBe(false);
  });

  it('⚠️ keeps the debt and the payment action when only part of it was written off', () => {
    /*
     * The settlement case, and the regression a one-term branch would ship: ฿4,320.00 forgiven,
     * ฿10,080.00 still to pay. This customer needs the figures and the "ชำระเงิน" link.
     */
    const money = describeRowMoney(
      row({ outstandingMinor: BALANCE, nextDueMinor: BALANCE, writtenOffMinor: DEPOSIT }),
    );

    expect(money.noteKey).toBeNull();
    expect(money.owes).toBe(true);
  });

  it('⚠️ an ordinary paid-off row still says "paid in full"', () => {
    const money = describeRowMoney(
      row({ outstandingMinor: 0n, nextDueMinor: 0n, writtenOffMinor: 0n }),
    );

    expect(money.noteKey).toBe('payment.settled');
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ AN ABSENT WRITE-OFF FIGURE MUST NOT BECOME "ชำระครบแล้ว".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This row read `(writtenOffMinor ?? 0n) > 0n`, and the comment defending it claimed the field
 * is null only where the total and the outstanding are null too — so the cart branch above would
 * already have returned. That was false, and running it proved so: a stated outstanding of ฿0.00
 * beside an absent write-off fell through to the settled branch and told a customer who had paid
 * nothing that their order was ชำระครบแล้ว.
 *
 * Reachable exactly when the storefront bundle is newer than the API, which is every deploy
 * between the two. `describePaymentPanel` and the staff order screens both refuse to guess here;
 * this row is the third reader of the same field and the one the customer reaches first.
 */
describe('⭐ a write-off figure the API did not send', () => {
  it('says nothing about the money rather than claiming it was paid', () => {
    const money = describeRowMoney({
      totalMinor: TOTAL,
      outstandingMinor: 0n,
      nextDueMinor: 0n,
      /* The API is a version behind: the fold exists, this bundle just cannot see it. */
      writtenOffMinor: null,
    });

    expect(money.noteKey).toBeNull();
    expect(money.noteKey).not.toBe('payment.settled');
    expect(money.noteKey).not.toBe('payment.writtenOff');
    /* The row still renders and still carries the total — it just makes no claim. */
    expect(money.figures.length).toBeGreaterThan(0);
    expect(money.owes).toBe(false);
  });

  it('still says paid when the figure is stated and is zero', () => {
    /* ⓵ The control. `0n` is an answer; `null` is the absence of one, and they must not merge. */
    const money = describeRowMoney({
      totalMinor: TOTAL,
      outstandingMinor: 0n,
      nextDueMinor: 0n,
      writtenOffMinor: 0n,
    });

    expect(money.noteKey).toBe('payment.settled');
  });

  it('still says forgiven when the figure is stated and positive', () => {
    const money = describeRowMoney({
      totalMinor: TOTAL,
      outstandingMinor: 0n,
      nextDueMinor: 0n,
      writtenOffMinor: TOTAL,
    });

    expect(money.noteKey).toBe('payment.writtenOff');
  });
});
