import type { OrderStatus } from '@/components/orders/order-language';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ Turning ยอดค้างชำระ from a number into a call list — and saying what it leaves out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The เงิน card carried one figure: how much the company was owed, company-wide. Nobody can
 * act on that. `GET /overview` now sends `money.outstandingOrders` beside it — the biggest
 * debts, itemised — and this decides what the card may honestly claim about the pair.
 *
 * No React, because `apps/dashboard`'s vitest is `environment: 'node'` and a `.test.tsx` is
 * **silently never collected**.
 *
 * ── ⚠️ THE LIST IS CAPPED AND THE TOTAL IS NOT THE SUM OF IT ─────────────────
 *
 * The API returns the top 8 by amount (`OUTSTANDING_ORDERS_CAP`), over the same live-order
 * predicate the aggregate folds. So on a company with nine unpaid orders,
 * `sum(outstandingOrders) < outstanding` **and there is nothing in the rows that says so** —
 * eight plausible orders that simply do not add up to the figure above them. A reader who
 * tries to reconcile them concludes one of the two is broken.
 *
 * That is what `noteTh` is for, and it is not decoration: it is the qualifier that makes the
 * card true. It is the same failure `order-list.tsx` says out loud when a page is full
 * ("แสดง 100 รายการแรกเท่านั้น") and the same one `slipQueueFocus` marks with `capped`.
 *
 * ⚠️ **This does not truncate, sort, or add anything up on the API's behalf.** The cap and the
 * ordering are the query's — amount descending, oldest submission breaking a tie — and
 * re-deriving either here would be a second implementation of an ordering that already exists.
 *
 * ── ⚠️ AND IT NO LONGER ADDS THE ROWS UP AT ALL, WHICH IS THE FIX ────────────
 *
 * It used to. `sum(rows) === total` was taken as "nothing was truncated", and the two numbers
 * are folded **over different predicates**: the aggregate sums `order_outstanding_thb_minor()`
 * over every live order, while the row query keeps only the ones where that fold is `> 0`. The
 * fold is `grand_total − settled` (`0011_payment_guards.sql`) and goes **negative** on an
 * overpaid order, which is a modelled state and not an error — so one live order that was
 * overpaid by ฿5 pulls the total below the sum of the rows, and the card announced
 * "แสดง 3 ออเดอร์ที่ค้างมากที่สุด" with all three of them on the screen and nothing hidden.
 * The two sums were never meant to match; a test built on their matching was reporting on
 * something else entirely.
 *
 * The question actually being asked is **"was the list cut short?"**, and a capped query
 * answers that by how many rows came back, not by what they add up to. Hence
 * `OUTSTANDING_ORDERS_CAP`.
 */

/**
 * How many rows `GET /overview` will return at most — a **mirror** of
 * `OUTSTANDING_ORDERS_CAP` in `apps/api/src/overview/overview.repository.ts`, which is the
 * definition and applies the `limit`.
 *
 * ⚠️ Restated rather than imported because `apps/dashboard` does not depend on `apps/api` and
 * must not start; `outstanding-breakdown.test.ts` reads the API's constant out of its own
 * source and fails if the two ever disagree — the same arrangement `apps/web`'s
 * `payment-entry.test.ts` uses for `SLIP_ATTACHABLE_STATUSES`.
 *
 * ⚠️ And note which direction drift is dangerous in. A cap **raised** on the server only makes
 * this bundle call a full page truncated when it might not be, which is the sentence it would
 * have printed anyway. A cap **lowered** would make a genuinely truncated list read as
 * complete, and that is the one the mirror test exists to catch.
 *
 * The count in the copy below is still the rows' own, never this number: an API that returned
 * six would otherwise be described as showing eight.
 */
export const OUTSTANDING_ORDERS_CAP = 8;

/** One owing order. `overview-api.ts`'s decoded shape satisfies this. */
export interface OwingOrder {
  readonly id: string;
  /** Unreachable-null: `order_no` is stamped at submit and every status this list admits is post-submit. */
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly outstandingThbMinor: bigint;
}

export interface OutstandingBreakdown {
  /** The rows to render, in the order the API chose. Never re-sorted here. */
  readonly shown: readonly OwingOrder[];
  /**
   * `true` when every owing order is on the screen — nothing is hiding behind the cap.
   *
   * ⚠️ Not "the rows add up to the total". They need not, and the difference is the whole of
   * this file's fix: a live order that has been overpaid folds negative and nets the total
   * down without appearing in the list, which it should not — an order that owes nothing is
   * not a debt to call about.
   */
  readonly coversAll: boolean;
  /**
   * The sentence under the list. Always present, in every state, because in every state the
   * rows and the total need a sentence explaining how they relate.
   */
  readonly noteTh: string;
}

export function outstandingBreakdown(
  totalThbMinor: bigint,
  orders: readonly OwingOrder[],
): OutstandingBreakdown {
  if (orders.length === 0) {
    /*
     * ⚠️ `<= 0n` and not `=== 0n`. The total is folded over every live order including the
     * overpaid ones, so a company whose only unsettled order has been overpaid reports a
     * *negative* figure with no owing rows behind it — and nothing was withheld from it.
     * Under `=== 0n` that fell into the branch below and told a reader the breakdown had
     * failed to arrive.
     */
    const nothingOwed = totalThbMinor <= 0n;

    return {
      shown: orders,
      coversAll: nothingOwed,
      /*
       * Two genuinely different states, and the second is not hypothetical: `outstandingOrders`
       * is a newer key than `outstanding`, so an older API paired with this bundle sends the
       * total and no rows. Printing ไม่มีออเดอร์ที่ค้างชำระ under a figure of ฿120,000 is the
       * card calling itself a liar; saying the breakdown did not arrive is the honest version.
       *
       * ⚠️ And a positive total with no rows really can only be that. The total sums the same
       * fold the row query filters on `> 0`, so if it comes out above zero at least one order
       * is above zero, and at least one row should have been returned.
       */
      noteTh: nothingOwed ? 'ไม่มีออเดอร์ที่ค้างชำระ' : 'ยอดข้างบนยังไม่มีรายการแยกรายออเดอร์',
    };
  }

  /*
   * ⭐ WAS THE LIST CUT SHORT? A capped query answers that with its row count.
   *
   * `>= ` and not `===` so that a server whose cap has been *raised* past this mirror still
   * reads as truncated rather than as complete — the conservative direction, and the note it
   * prints is the one a full page would have printed anyway.
   *
   * ⚠️ The one case this cannot distinguish, stated rather than hidden: a company with exactly
   * `OUTSTANDING_ORDERS_CAP` owing orders gets the "top N" sentence when in fact those N are
   * all of them. Separating the two needs the server to fetch a row it will not show, and the
   * cost of being wrong here is a qualifier that is merely redundant — against a `coversAll`
   * that wrongly claimed completeness, which is a card asserting that a debt it is not showing
   * does not exist.
   */
  if (orders.length >= OUTSTANDING_ORDERS_CAP) {
    /*
     * The count is stated rather than the cap, because the rows are what the reader can see —
     * an API that returned six when its cap is eight must not be described as showing eight.
     */
    return {
      shown: orders,
      coversAll: false,
      noteTh: `แสดง ${String(orders.length)} ออเดอร์ที่ค้างมากที่สุด — ยอดข้างบนนับทุกออเดอร์ที่ค้าง`,
    };
  }

  /*
   * Short of the cap, so the query returned every order that owes anything.
   *
   * ⚠️ Note what is *not* claimed: that these rows add up to the figure above them. They need
   * not — the total nets in the live orders that owe nothing or have been overpaid, and those
   * are deliberately absent from a call list. What the sentence says is where the debt comes
   * from, and every order it comes from is on the screen.
   */
  return {
    shown: orders,
    coversAll: true,
    noteTh: `ยอดค้างชำระทั้งหมดมาจาก ${String(orders.length)} ออเดอร์นี้`,
  };
}
