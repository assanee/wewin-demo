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
 * The first fix tested "can this be paid?" alone, and measuring the six real wire payloads
 * showed that one boolean was answering for three states that need three sentences:
 *
 *   cancelled / superseded   not live, outstanding ฿10,354.18 — owed the OTHER way
 *   delivered, fully paid    live,     outstanding ฿0
 *   delivered, still owing   live,     outstanding ฿10,354.18 — owed by the customer
 *
 * It told the finished customer their order was closed instead of paid, and told the owing one
 * nothing at all — no amount, on the last screen where that debt is ever put in front of them.
 *
 * ── ⚠️ And then the third row stopped being a special case ───────────────────
 *
 * That fix stated the delivered balance and still withheld the form, because
 * `SLIP_ATTACHABLE_STATUSES` would have refused the upload: the customer read what they owed
 * with no way to pay it — the owner's *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"*.
 * `0046_slips_after_delivery.sql` opened `delivered` to slips, so it is now an ordinary live
 * order and the second boolean this module read has gone with the branch it fed. The delivered
 * cases below therefore assert the *paying* path, and they are the mutation target for it.
 */

const panel = (over: Partial<PanelInput>): ReturnType<typeof describePaymentPanel> =>
  describePaymentPanel({
    /* Live unless a case says otherwise — only cancelled and superseded are not. */
    orderIsLive: true,
    outstandingMinor: 1_035_418n,
    nextDueMinor: 1_035_418n,
    /*
     * ⚠️ Nothing forgiven, unless a case says otherwise — which is the state of every order in
     * this system except the handful somebody has written off. Keeping it in the shared fixture
     * rather than defaulting it inside `describePaymentPanel` is deliberate: a default there would
     * be the branch quietly switching itself off on a caller that forgot the field.
     */
    writtenOffMinor: 0n,
    accountCount: 2,
    ...over,
  });

/** Cancelled and superseded: money may be owed the other way, so no figure at any value. */
describe('⭐ an order that is no longer a live commitment', () => {
  const dead = { orderIsLive: false } as const;

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
 * `delivered` — the status this round changed, and the two states the screen used to get wrong.
 */
describe('⭐ a delivered order: live, and payable like any other', () => {
  /*
   * ⚠️ No override at all, and that is the assertion. A delivered order arrives on this module
   * as `orderIsLive: true` and nothing else — exactly what an `in_production` order looks like
   * — because the wire no longer carries a second boolean to tell them apart. The cases below
   * are what a delivered order now renders as.
   */
  const delivered = { orderIsLive: true } as const;

  it('⭐ names the balance AND offers the form to settle it', () => {
    /*
     * THE OWNER'S DEFECT, ASSERTED. `delivered` has no transition out, so before 0046 this was
     * the last screen the money was ever mentioned on and it carried no way to pay: the figure
     * was printed under `payment.closedOwing` and `showsForm` was false. Both halves are
     * checked here — a fix that stated the amount and still withheld the form would pass the
     * first expectation and fail the third.
     */
    const owing = panel(delivered);

    expect(owing.figures.map((f) => f.amountMinor)).toContain(1_035_418n);
    expect(owing.noteKey).toBeNull();
    expect(owing.showsForm).toBe(true);
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

  it('withholds the form when the organisation has nowhere for the money to go', () => {
    /*
     * ⚠️ The reasoning INVERTED here, and it is worth stating. It used to read "accounts say
     * where money could go, not whether it may" — true while the form was withheld from a
     * delivered order on status grounds. Now that the form is offered, the account list is the
     * only thing left that can withhold it, exactly as on any other live order.
     */
    expect(panel({ ...delivered, accountCount: 0 }).noteKey).toBe('payment.account.none');
    expect(panel({ ...delivered, accountCount: 5 }).showsForm).toBe(true);
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ⓸ AND THE ORDER WHOSE BALANCE WAS FORGIVEN — WHICH IS NOT "PAID IN FULL".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `0048_write_off_approval.sql` subtracts an approved ขออนุมัติตัดยอดค้างทิ้ง from
 * `order_outstanding_thb_minor()`. That is the feature — the debt is meant to disappear from the
 * order list, the ค้างชำระ filter and the overview's money card — and it means a forgiven order
 * reaches `outstandingMinor <= 0n` and, before this branch existed, printed *"ออเดอร์นี้ชำระครบ
 * แล้ว"* at the person whose money the company gave up on.
 *
 * These are the assertions that stop that sentence coming back.
 */
describe('⭐ ⓸ an order whose remaining balance was written off', () => {
  it('⭐ does NOT say "paid in full" — it says the balance was written off', () => {
    /*
     * THE WHOLE POINT OF THE ROUND, ASSERTED. ฿10,354.18 owed, all of it forgiven, so the fold
     * answers ฿0.00 and the settled test below it is satisfied. Deleting the write-off branch from
     * `describePaymentPanel` makes this read `payment.settled` — a falsehood told to the one reader
     * who knows better — and this expectation is what fails.
     */
    const forgiven = panel({
      outstandingMinor: 0n,
      nextDueMinor: 0n,
      writtenOffMinor: 1_035_418n,
    });

    expect(forgiven.noteKey).toBe('payment.writtenOff');
    expect(forgiven.noteKey).not.toBe('payment.settled');
  });

  it('states no owed figure and offers no form', () => {
    /*
     * ⚠️ Figures *empty*, not ฿0.00 — the same call the cancelled case makes at the top of this
     * file. A "ยอดคงค้างทั้งหมด" label is a demand whatever number sits beside it, and there is
     * nothing here for the customer to act on.
     */
    const forgiven = panel({ outstandingMinor: 0n, nextDueMinor: 0n, writtenOffMinor: 1_035_418n });

    expect(forgiven.figures).toStrictEqual([]);
    expect(forgiven.showsForm).toBe(false);
  });

  it('⚠️ keeps the figures and the FORM when only part of the balance was written off', () => {
    /*
     * THE SETTLEMENT CASE, AND IT IS THE COMMON ONE. ฿14,400.00 was owed, ฿7,200.00 forgiven as a
     * negotiated settlement, ฿7,200.00 still to pay. Branching on `writtenOffMinor > 0n` alone
     * would take the payment form away from a customer who is about to use it — so both terms are
     * required, and this is the assertion that holds the second one.
     */
    const halfSettled = panel({
      outstandingMinor: 720_000n,
      nextDueMinor: 720_000n,
      writtenOffMinor: 720_000n,
    });

    expect(halfSettled.noteKey).toBeNull();
    expect(halfSettled.showsForm).toBe(true);
    expect(halfSettled.figures.map((figure) => figure.amountMinor)).toContain(720_000n);
  });

  it('⚠️ a cancelled order that was written off still reads as closed, not as written off', () => {
    /*
     * The order of the branches, and it is a decision rather than an accident: `orderIsLive` is
     * tested first, so an order that was forgiven and *then* cancelled says `payment.closed`. Money
     * held on a cancelled order is a refund question — the company may owe the customer — and a
     * sentence about a debt being cancelled is not the news on that screen.
     */
    const dead = panel({
      orderIsLive: false,
      outstandingMinor: 0n,
      nextDueMinor: 0n,
      writtenOffMinor: 1_035_418n,
    });

    expect(dead.noteKey).toBe('payment.closed');
  });

  it('⚠️ an ordinary paid-off order is untouched — the sentence is still "paid in full"', () => {
    /*
     * The other direction, and the regression that would be worse than the bug: a branch that read
     * *any* zero balance as forgiven would tell every customer who actually paid that the company
     * had written their order off.
     */
    const paid = panel({ outstandingMinor: 0n, nextDueMinor: 0n, writtenOffMinor: 0n });

    expect(paid.noteKey).toBe('payment.settled');
  });
});
