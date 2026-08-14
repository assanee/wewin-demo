import { formatBaht } from '@wewin/core/format';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * How an order's debt reads: nothing owed, something owed, or nothing to owe yet.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `outstandingThbMinor` and `nextDueThbMinor` arrive on every row of `GET /orders` and on the
 * single-order read. They are `order_outstanding_thb_minor()` and `order_next_due_thb_minor()`
 * — Postgres's own answers, carried as columns on the select that fetched the row. **Nothing
 * in this file computes money.** It decides how three states should *read*, and every baht
 * figure it emits is the one the API sent, through `formatBaht`.
 *
 * No React here on purpose: `apps/dashboard`'s vitest is `environment: 'node'` and a
 * `.test.tsx` is **silently never collected**, so logic in a `.tsx` is logic nobody can prove.
 * Same reason `order-focus.ts` and `overview-focus.ts` exist.
 *
 * ── ⚠️ ฿0.00 IS NOT THE SAME NEWS AS ฿0.00 ───────────────────────────────────
 *
 * Three states, and two of them would render as "฿0" if this file did not exist:
 *
 *   **no figure at all** — `outstandingThbMinor` is `null`. The contract says why the API
 *   withholds it rather than sending the fold's honest ฿0.00 — *"ค้างชำระ ฿0.00 is how a
 *   screen says settled"* — and it withholds it for **two** different orders that share one
 *   sentence: *this order's remainder is not a debt anybody owes.*
 *
 *     ⓵ a **cart**, which has not agreed to owe anything, so `grandTotalThbMinor` is null
 *        beside it and there is nothing to have settled;
 *     ⓶ a **cancelled or superseded** order, which has a grand total and a real remainder,
 *        and still owes nobody: money held on a cancellation is a *refund* question, and
 *        money on a superseded order was carried to the order that replaced it.
 *
 *   The cell cannot tell them apart and does not need to — the true sentence is the same one,
 *   and it is neither "฿14,791.68" nor "ชำระครบแล้ว". ⓶ is why this state is not called
 *   `uncontracted`: a cancelled order was very much contracted, and a branch named for drafts
 *   is a branch somebody will one day "fix" by printing the total.
 *
 *   **settled** — a real contract, paid off. Good news, and good news is quiet. Rendering it
 *   as `฿0` in the same weight as a real debt is what makes a forty-row list unscannable: the
 *   eye is looking for money, and forty zeroes at the money's weight are forty false hits.
 *   So it becomes a word, muted — the same argument `overview-focus.ts` makes for
 *   ไม่มีงานค้าง over "0 รายการ", and `QueueRow` for styling zero *down*.
 *
 *   **owing** — the figure, and the only state that gets weight.
 *
 * ── ⚠️ Why `nextDueIsWholeDebt` exists, and what it is for ───────────────────
 *
 * The two figures are **equal on a pay-in-full order** and differ by the balance on a 30/70.
 * `apps/dashboard/README.md`'s rule is that a number already on the screen is not worth a
 * second place on it — so when they are equal, a detail screen that printed both would print
 * one baht figure twice under two different labels, which reads as two debts. The screen asks
 * this flag and shows the second row only when it says something new.
 *
 * ⚠️ It is `>=` and not `===`. A next-due larger than the whole outstanding is not
 * representable — 0042's fold is a remainder of one instalment — but if it ever arrives, the
 * honest render is the whole debt on its own rather than a "pay now" figure that exceeds it.
 */

/**
 * Just enough of an order to read its debt. `order-api.ts`'s `OrderSummary` (and `OrderDetail`,
 * which extends it) structurally satisfies this — the same arrangement `CountedQueue` uses.
 */
export interface OwedFigures {
  readonly outstandingThbMinor: bigint | null;
  readonly nextDueThbMinor: bigint | null;
}

export type OutstandingReading =
  /** The API stated no figure: a cart, or a cancelled/superseded order. Neither owes. */
  | { readonly kind: 'noFigure' }
  /** A real, live contract with nothing left on it. */
  | { readonly kind: 'settled' }
  | {
      readonly kind: 'owing';
      readonly outstandingThbMinor: bigint;
      readonly nextDueThbMinor: bigint;
      /** `true` when what is due now *is* the whole debt — a second row would repeat it. */
      readonly nextDueIsWholeDebt: boolean;
    };

/** Taken from `apps/web`'s `payment.settled`, so staff and customer say it the same way. */
export const SETTLED_TH = 'ชำระครบแล้ว';

/** The dash `order-list.tsx` already renders wherever a money cell has no figure to state. */
export const NO_FIGURE_TH = '—';

export function readOutstanding(order: OwedFigures): OutstandingReading {
  const outstanding = order.outstandingThbMinor;

  /* Both reasons the API withholds a figure, and the same dash for each — see the header. */
  if (outstanding === null) return { kind: 'noFigure' };

  /*
   * `<= 0n` rather than `=== 0n`. The fold cannot go negative — money past the last instalment
   * is held as an advance rather than subtracted — but if a credit ever reached this line, the
   * true sentence about the order is still that nothing is owed on it, and "-฿500 ค้างชำระ" is
   * not a sentence anybody should be shown on a queue.
   */
  if (outstanding <= 0n) return { kind: 'settled' };

  /*
   * ⚠️ A missing next-due on an order that owes money is half a contract — the API sends both
   * or neither. Degrading to the whole outstanding is the safe direction: it collapses the
   * detail screen to one row and can only ever *overstate* what is due now, where defaulting
   * to zero would tell somebody a live debt needs no payment today.
   */
  const nextDue = order.nextDueThbMinor ?? outstanding;

  return {
    kind: 'owing',
    outstandingThbMinor: outstanding,
    nextDueThbMinor: nextDue,
    nextDueIsWholeDebt: nextDue >= outstanding,
  };
}

export interface OutstandingDisplay {
  readonly textTh: string;
  /** `debt` is the only value that earns weight on a screen. `quiet` is muted. */
  readonly emphasis: 'debt' | 'quiet';
}

/**
 * One reading, as a cell.
 *
 * Both the list and the order's ยอดเงิน card render debt through this, so the word for settled
 * is written once. `formatBaht` is the app's own formatter — the same one the grand total in
 * the next column goes through — and there is deliberately no second one here.
 */
export function outstandingDisplay(reading: OutstandingReading): OutstandingDisplay {
  switch (reading.kind) {
    case 'noFigure':
      return { textTh: NO_FIGURE_TH, emphasis: 'quiet' };
    case 'settled':
      return { textTh: SETTLED_TH, emphasis: 'quiet' };
    default:
      return { textTh: formatBaht(reading.outstandingThbMinor), emphasis: 'debt' };
  }
}
