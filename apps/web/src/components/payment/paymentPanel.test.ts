import { describe, expect, it } from 'vitest';

import { describePaymentPanel, type PanelInput } from './paymentPanel';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE SCREEN MUST NOT BILL AN ORDER NOBODY CAN PAY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Executed against the real database, one cancelled order answered
 * `GET /orders/:id/payment-instructions` with `outstandingThbMinor 1035418`, and the payment
 * screen — whose only test was `outstandingThbMinor <= 0n` — printed
 * "ยอดคงค้างทั้งหมด ฿10,354.18" in `text-lead text-lime` with the upload form beneath it. The
 * customer had cancelled the order; the company owed *them* ฿4,437.50 of deposit.
 *
 * The first fix tested `acceptsPayment` alone, and measuring the six real wire payloads showed
 * that one boolean was answering for three states that need three sentences:
 *
 *   cancelled / superseded   acceptsPayment false, orderIsLive false, outstanding ฿10,354.18
 *   delivered, fully paid    acceptsPayment false, orderIsLive TRUE,  outstanding ฿0
 *   delivered, still owing   acceptsPayment false, orderIsLive TRUE,  outstanding ฿10,354.18
 *
 * It told the finished customer their order was closed instead of paid, and told the owing one
 * nothing at all — no amount, on the last screen where that debt is ever put in front of them.
 * Every `acceptsPayment: false` case below therefore has to say which of the three it is, and
 * the ones that do not name `orderIsLive` are asserting the default, which is a live order.
 */

const panel = (over: Partial<PanelInput>): ReturnType<typeof describePaymentPanel> =>
  describePaymentPanel({
    acceptsPayment: true,
    /* Live unless a case says otherwise — only cancelled and superseded are not. */
    orderIsLive: true,
    outstandingMinor: 1_035_418n,
    nextDueMinor: 1_035_418n,
    accountCount: 2,
    ...over,
  });

/** Cancelled and superseded: money may be owed the other way, so no figure at any value. */
describe('⭐ an order that is no longer a live commitment', () => {
  const dead = { acceptsPayment: false, orderIsLive: false } as const;

  it('states no owed figure at all, and offers no form', () => {
    /*
     * ⚠️ The figures are *empty*, not zeroed. The residue is real — a refund is priced from it
     * — but a number under "ยอดคงค้างทั้งหมด" is a demand whatever its value, and this is the
     * exact figure the browser was found printing on a cancelled order.
     */
    const closed = panel(dead);

    expect(closed.figures).toStrictEqual([]);
    expect(closed.showsForm).toBe(false);
    expect(closed.noteKey).toBe('payment.closed');
  });

  it('⭐ does not say "paid in full", even when nothing is outstanding', () => {
    /*
     * THE ASSERTION THE ORDERING OF THE BRANCHES TURNS ON.
     *
     * A customer who paid in full and then cancelled has `outstanding === 0` and no live order,
     * and the company is holding the whole contract as a refund. `payment.settled` reads
     * "ออเดอร์นี้ชำระครบแล้ว" — the cruellest available sentence to put in front of somebody owed
     * all of their money back. Hence the not-live test runs before the settled one.
     */
    const closedAndPaid = panel({ ...dead, outstandingMinor: 0n, nextDueMinor: 0n });

    expect(closedAndPaid.noteKey).toBe('payment.closed');
    expect(closedAndPaid.noteKey).not.toBe('payment.settled');
    expect(closedAndPaid.figures).toStrictEqual([]);
    expect(closedAndPaid.showsForm).toBe(false);
  });

  it('stays closed even where the organisation has accounts to transfer to', () => {
    /* The account list is about where money *could* go, not about whether it may. */
    expect(panel({ ...dead, accountCount: 0 }).noteKey).toBe('payment.closed');
    expect(panel({ ...dead, accountCount: 5 }).noteKey).toBe('payment.closed');
  });
});

/**
 * `delivered` — the one status where the two booleans disagree, and the two states the
 * single-boolean version got wrong.
 */
describe('⭐ a delivered order: live, but this screen takes no more slips', () => {
  const delivered = { acceptsPayment: false, orderIsLive: true } as const;

  it('⭐ says the balance is still owing, and names it', () => {
    /*
     * THE REGRESSION THIS BRANCH EXISTS FOR. `delivered` is absent from
     * `SLIP_ATTACHABLE_STATUSES` and has no transition out, so this is the last screen on which
     * this money is ever mentioned to the person who owes it. The single-boolean version printed
     * no figure here — the company's receivable, removed from the only surface its debtor has.
     */
    const owing = panel(delivered);

    expect(owing.noteKey).toBe('payment.closedOwing');
    expect(owing.figures.length).toBeGreaterThan(0);
    expect(owing.figures.map((f) => f.amountMinor)).toContain(1_035_418n);
    /* Named, but not collectable here: the upload route would answer 409 either way. */
    expect(owing.showsForm).toBe(false);
  });

  it('⭐ says "paid in full" once nothing is outstanding', () => {
    /*
     * The ordinary happy ending, and the more common of the two. The single-boolean version
     * replaced "ชำระครบแล้ว" with an administrative sentence about payment being closed — the
     * last thing the software said to a customer who had just completed their purchase.
     */
    const finished = panel({ ...delivered, outstandingMinor: 0n, nextDueMinor: 0n });

    expect(finished.noteKey).toBe('payment.settled');
    expect(finished.showsForm).toBe(false);
  });

  it('is not affected by whether the organisation has accounts', () => {
    /* Same reasoning as the dead case: accounts say where money could go, not whether it may. */
    expect(panel({ ...delivered, accountCount: 0 }).noteKey).toBe('payment.closedOwing');
    expect(panel({ ...delivered, accountCount: 5 }).noteKey).toBe('payment.closedOwing');
  });
});

describe('an order that can still be paid', () => {
  it('leads with the instalment being asked for and keeps the total behind it', () => {
    /*
     * The 30/70 case, unchanged by this round and asserted here so a gate added above it
     * cannot swallow it: `owedFigures.ts` owns the ordering, this module only passes it on.
     */
    const open = panel({ outstandingMinor: 1_440_000n, nextDueMinor: 432_000n });

    expect(open.figures.map((figure) => figure.labelKey)).toStrictEqual([
      'payment.dueNow',
      'payment.outstanding',
    ]);
    expect(open.figures[0]?.emphasis).toBe('lead');
    expect(open.noteKey).toBeNull();
    expect(open.showsForm).toBe(true);
  });

  it('⭐ still says "paid in full" when it is true — an open order that owes nothing', () => {
    /*
     * `in_production` with the balance accepted: the order is not finished, so payment stays
     * open, and there is genuinely nothing left to send. This is where a customer looks to
     * check that their transfer landed, and `payment.settled` is exactly the sentence for it —
     * so the key is not dead, it has been narrowed to the state it is true of.
     */
    const paid = panel({ outstandingMinor: 0n, nextDueMinor: 0n });

    expect(paid.noteKey).toBe('payment.settled');
    expect(paid.showsForm).toBe(false);
    /* And the ฿0.00 is still stated, which is the reassurance this branch exists to give. */
    expect(paid.figures.map((figure) => figure.amountMinor)).toStrictEqual([0n]);
  });

  it('says an overpaid order is settled rather than owing a negative', () => {
    const over = panel({ outstandingMinor: -150n, nextDueMinor: 0n });

    expect(over.noteKey).toBe('payment.settled');
    expect(over.showsForm).toBe(false);
  });

  it('withholds the form when there is nowhere for the money to go, and still states the debt', () => {
    /*
     * A fresh database seeds no bank accounts. The customer is told why there is no form
     * rather than shown one that cannot name a destination — and the figure stays, because
     * this order *is* owed and the sentence is about the channel, not about the debt.
     */
    const nowhere = panel({ accountCount: 0 });

    expect(nowhere.noteKey).toBe('payment.account.none');
    expect(nowhere.showsForm).toBe(false);
    expect(nowhere.figures.length).toBeGreaterThan(0);
  });
});
