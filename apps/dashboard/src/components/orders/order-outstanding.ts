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
 *     ⓷ ⭐ and a **third**, which is this state being used as a refusal rather than as news: a
 *        balance of ฿0.00 with **no write-off figure stated beside it**. Nothing is owed and this
 *        screen cannot tell whether that is because the money arrived or because the company
 *        forgave it, so it claims neither. See `readOutstanding`.
 *
 *   **writtenOff** — ⭐ nothing owed, and the reason is that the company **forgave** it: an
 *   approved ขออนุมัติตัดยอดค้างทิ้ง (`order_written_off_thb_minor()`, 0048) drove the outstanding
 *   to ฿0.00. `SETTLED_TH` — *"ชำระครบแล้ว"* — is a false sentence about such an order and it is
 *   the sentence this branch exists to stop: staff reading a queue must be able to tell a customer
 *   who paid from one whose debt was given up on, because the two are different facts about the
 *   *company* as well as about the customer. It reads as quietly as `settled` does, because a debt
 *   that is gone is not money to chase either way — what changes is the word.
 *
 *   ⚠️ It needs **both** terms: a *partial* write-off (the settlement-at-half case) leaves a real
 *   balance and must keep reading as `owing`, weight and all. Branching on the write-off alone
 *   would style a live debt as quiet news.
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
  /**
   * ⭐ `order_written_off_thb_minor()` — how much of this balance was forgiven rather than paid.
   *
   * ⛔ `outstandingThbMinor` is already net of it. Nothing here subtracts anything.
   *
   * ⚠️ `null` means **the figure was not stated**, and it is not a zero. On the API's own wire it
   * arrives null on exactly the fact that nulls the balance beside it (no contract, or a cancelled
   * order), so the two travel together; a null here with a *stated* balance is a shape the wire
   * cannot produce, and `readOutstanding` answers it with a dash rather than with "ชำระครบแล้ว".
   */
  readonly writtenOffThbMinor: bigint | null;
}

export type OutstandingReading =
  /** The API stated no figure: a cart, or a cancelled/superseded order. Neither owes. */
  | { readonly kind: 'noFigure' }
  /** A real, live contract with nothing left on it. */
  | { readonly kind: 'settled' }
  /**
   * ⭐ Nothing left on it **because the company forgave what was left**. Carries the figure, so a
   * screen can name what was given up rather than only that something was.
   */
  | { readonly kind: 'writtenOff'; readonly writtenOffThbMinor: bigint }
  | {
      readonly kind: 'owing';
      readonly outstandingThbMinor: bigint;
      readonly nextDueThbMinor: bigint;
      /** `true` when what is due now *is* the whole debt — a second row would repeat it. */
      readonly nextDueIsWholeDebt: boolean;
    };

/** Taken from `apps/web`'s `payment.settled`, so staff and customer say it the same way. */
export const SETTLED_TH = 'ชำระครบแล้ว';

/**
 * ⭐ What a written-off balance reads as in a money cell.
 *
 * ⚠️ Built from words this app already has — `ยอดคงค้าง` is the phrase the API, the filter heading
 * and the approval inbox all use for a balance, and `ตัดยอด` is the owner's own verb from
 * *"ขออนุมัติตัดยอดค้างทิ้ง"*. No new vocabulary for money, which is `apps/dashboard/README.md`'s
 * rule and the reason `SETTLED_TH` above was borrowed from `apps/web` rather than written twice.
 *
 * ⚠️ And it is deliberately **not** a form of `ชำระ` — *paid*. That is `SETTLED_TH`'s word and
 * using it here is the falsehood this constant exists to replace.
 */
export const WRITTEN_OFF_TH = 'ตัดยอดค้างทิ้งแล้ว';

/** The dash `order-list.tsx` already renders wherever a money cell has no figure to state. */
export const NO_FIGURE_TH = '—';

export function readOutstanding(order: OwedFigures): OutstandingReading {
  const outstanding = order.outstandingThbMinor;
  const writtenOff = order.writtenOffThbMinor;

  /* Both reasons the API withholds a figure, and the same dash for each — see the header. */
  if (outstanding === null) return { kind: 'noFigure' };

  /*
   * `<= 0n` rather than `=== 0n`. The fold cannot go negative — money past the last instalment
   * is held as an advance rather than subtracted — but if a credit ever reached this line, the
   * true sentence about the order is still that nothing is owed on it, and "-฿500 ค้างชำระ" is
   * not a sentence anybody should be shown on a queue.
   */
  /*
   * ⭐ Nothing is owed. Which of the three sentences that is depends entirely on the write-off
   * figure, so this is the one place the two ฿0.00s are told apart — and the order of the three
   * arms is the order of how much the screen is entitled to claim.
   *
   * ⚠️ A **missing** write-off figure beside a stated balance says *nothing*, not "paid".
   *
   * It used to read `writtenOffThbMinor ?? 0n`, called that the fail-closed direction, and it was
   * not: ฿0.00 forgiven is a positive claim — *the customer paid this off* — assembled out of a
   * field the API never sent, and it is exactly the sentence 0048 exists to stop printing. The
   * dash is the fail-closed answer here, the same one a cancelled order gets: this screen does not
   * know, and "—" is how it says so. `order-api.ts` now refuses the decode outright when the key
   * is absent (`asStatedSatangOrNull`), so on a matched API this arm is unreachable; it is kept
   * because `OwedFigures` is a structural type that anything on this screen may satisfy, and the
   * cost of being wrong here is a lie about somebody's money.
   *
   * ⚠️ And both terms are still required on the arm below — a *partial* write-off leaves a real
   * balance and falls through to `owing`, with the weight a live debt earns.
   */
  if (outstanding <= 0n) {
    if (writtenOff === null) return { kind: 'noFigure' };
    if (writtenOff > 0n) return { kind: 'writtenOff', writtenOffThbMinor: writtenOff };
    return { kind: 'settled' };
  }

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
    /*
     * ⭐ Quiet, like `settled` — there is no money to chase — but a different word. The figure is
     * left to the caller: the *list* has one narrow cell and the sentence is what fits, while the
     * order's money card has room to name what was given up and reads `reading.writtenOffThbMinor`
     * for its own row.
     */
    case 'writtenOff':
      return { textTh: WRITTEN_OFF_TH, emphasis: 'quiet' };
    default:
      return { textTh: formatBaht(reading.outstandingThbMinor), emphasis: 'debt' };
  }
}
