import type { UiKey } from '../../i18n/keys';
import { describeOwedFigures, type Emphasis, type OwedFigure } from '../../lib/payment/owedFigures';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHICH FIGURE, WHICH LABEL, AND WHEN — the account list's money, decided once.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `GET /orders` now carries two folds per row (`outstandingThbMinor`, `nextDueThbMinor`),
 * and the owner's decision is that a customer sees **both**: what to pay now, prominently,
 * and what the order still comes to underneath it. On a 30/70 those differ, and a customer
 * shown one number and asked for another is the exact confusion this exists to remove —
 * the same one `PaymentIsland`'s ⭐ note at its prefill records, from the other side.
 *
 * ── Why this is a module and not four ternaries in the JSX ───────────────────
 *
 * There are five cases and three of them are the quiet ones (nothing owed, one figure that
 * answers both questions, an API that did not send the fields). `apps/web`'s vitest runs
 * `environment: 'node'`, so a `.test.tsx` is silently never collected — a decision left in
 * the markup is a decision no test in this repo can reach. It is here so it can be pinned.
 *
 * ── The two labels, and why neither is new prose ─────────────────────────────
 *
 * `payment.outstanding` is the *same key* `PaymentIsland` states above its form, so the
 * list and the screen it links to name the total still owed with one string in all eight
 * languages and cannot drift apart. `payment.dueNow` is the one key added, for the figure
 * that screen's amount field opens on.
 *
 * ── ⚠️ WHICH FIGURES, AND WHICH ONE LEADS, IS NOT DECIDED HERE ───────────────
 *
 * `lib/payment/owedFigures.ts` answers that, and `PaymentIsland` asks it the same question
 * one click later. It used to be answered here alone, which is exactly how the list came to
 * lead with the next instalment while the payment screen still led with the outstanding —
 * a customer reading ฿4,320.00 here and ฿14,400.00 as the headline of the screen this row
 * links to. Read that module's header for the rule and its reasons; what stays in this file
 * is only what the *list* has and the payment screen does not: a grand total, a row with no
 * contract yet, and a sentence for an order that owes nothing.
 *
 * ── ⚠️ Nothing owed ─────────────────────────────────────────────────────────
 *
 * `outstanding <= 0` is `PaymentIsland`'s own test (`settled = data.outstandingThbMinor <= 0n`,
 * `<=` because an overpayment is modelled, not an error). Such a row states the order's total
 * quietly, as this list always did, and says `payment.settled` instead of asking for money —
 * and `owes` goes false, which is what finally closes the gap `lib/payment/payable.ts`
 * documented: `acceptsPayment` answers from the status alone and cannot see a paid order.
 *
 * ── ⚠️ ⓸ AND NOTHING OWED **BECAUSE IT WAS FORGIVEN** IS A DIFFERENT SENTENCE ─
 *
 * Since `0048_write_off_approval.sql` the outstanding fold subtracts an approved
 * ขออนุมัติตัดยอดค้างทิ้ง, so a written-off row reaches the branch above and said *"ชำระครบแล้ว"* —
 * paid in full — to a customer who did not pay. That is the same falsehood `PaymentIsland` was
 * fixed for, one click earlier and on the screen the customer sees first, so it is fixed here
 * too: `writtenOffThbMinor` arrives on the same row and `payment.writtenOff` is the sentence.
 * `paymentPanel.ts` owns the full argument and this file follows it rather than restating it.
 */

/** The three money fields of one row, exactly as `OrderSummaryWire` nulls them. */
export interface RowFigures {
  /** `grandTotalThbMinor`. `null` before submit — see `encodeOrderSummary`. */
  readonly totalMinor: bigint | null;
  /** `outstandingThbMinor`: everything still owed. `null` exactly where the total is. */
  readonly outstandingMinor: bigint | null;
  /** `nextDueThbMinor`: the remainder of the first unsettled instalment. ฿0.00, not null, once settled. */
  readonly nextDueMinor: bigint | null;
  /**
   * ⭐ `writtenOffThbMinor`: how much of this balance the company forgave — 0048's third fold.
   *
   * `null` exactly where the other two are (a cart, a cancelled order, or a bundle newer than its
   * API), and ฿0.00 — the real answer *nothing was forgiven* — on every other row.
   *
   * ⛔ `outstandingMinor` is already net of this. Nothing here subtracts it again.
   */
  readonly writtenOffMinor: bigint | null;
}

/** How prominently one figure is printed. The row has at most one `lead`. */
export type { Emphasis };

export interface RowFigure {
  /** `null` prints the amount unlabelled, which is what this list did before it had two. */
  readonly labelKey: OwedFigure['labelKey'] | null;
  readonly amountMinor: bigint;
  readonly emphasis: Emphasis;
}

export interface RowMoney {
  /** In reading order. Empty when the row has no figure at all to print. */
  readonly figures: readonly RowFigure[];
  /** A sentence in place of a demand, or `null`. */
  readonly noteKey: Extract<UiKey, 'payment.settled' | 'payment.writtenOff'> | null;
  /**
   * Whether there is still money to collect on this order.
   *
   * ⚠️ Half of the payment action's condition, not all of it: the status half stays in
   * `acceptsPayment`, which is a character-for-character mirror of the server's list
   * (`tests/payment-entry.test.ts` reads the API's own source and compares them). Folding
   * the two into one function here would put a copy of that list on the wrong side of the
   * mirror. The component writes `acceptsPayment(row.status) && money.owes`.
   */
  readonly owes: boolean;
}

/**
 * What one row of `MyQuotations` prints, from the three figures the wire carries.
 *
 * ⚠️ Total in, total out: this never subtracts one figure from another. Both folds are
 * computed by Postgres (`order_outstanding_thb_minor`, `order_next_due_thb_minor`) and
 * arrive already decided; all that happens here is choosing which of them to show.
 */
export function describeRowMoney(row: RowFigures): RowMoney {
  const { totalMinor, outstandingMinor, nextDueMinor, writtenOffMinor } = row;

  /*
   * ⚠️ No contract yet — or an API that predates the two folds.
   *
   * The wire nulls all three together (`const contracted = row.grandTotalThbMinor !== null`
   * in `encode.ts`), so this is a cart, which `MyQuotations` already filters out by
   * `submittedAt`. It is still handled rather than asserted away, because the *other* way to
   * reach it is a bundle newer than the API it is talking to: the fields are simply absent,
   * `satang()` answers `null`, and the row falls back to exactly what this list printed
   * before this task — the total, unlabelled, with the action left to the status alone.
   */
  if (outstandingMinor === null || nextDueMinor === null) {
    return { figures: unlabelledTotal(totalMinor), noteKey: null, owes: true };
  }

  /*
   * ⭐ ⓸ Nothing owed because the company **forgave** it. Before the settled test — see the header.
   *
   * ⚠️ Both terms, and the second is what keeps the payment action on a **partial** write-off: a
   * settlement at half leaves a real balance the customer is about to pay, and a branch on the
   * write-off alone would take the "ชำระเงิน" link off their row.
   *
   * `writtenOffMinor` is `null` only where the other two are, so the branch above has already
   * returned by here; the `?? 0n` is the honest reading of a fold that could not be consulted and
   * it is the fail-closed direction — an unread write-off says nothing rather than saying forgiven.
   */
  if (outstandingMinor <= 0n && (writtenOffMinor ?? 0n) > 0n) {
    return { figures: unlabelledTotal(totalMinor), noteKey: 'payment.writtenOff', owes: false };
  }

  /* Nothing owed. `<=`, because an overpayment is a modelled state and not an error. */
  if (outstandingMinor <= 0n) {
    return { figures: unlabelledTotal(totalMinor), noteKey: 'payment.settled', owes: false };
  }

  /*
   * A live debt, so the shared rule decides: one figure when there is only one number to
   * say, and otherwise the instalment being asked for leading the outstanding.
   *
   * ⚠️ The grand total is deliberately not a third line. It is on the quotation one click
   * away, and on an untouched order it is *already here* — `outstanding` equals it until the
   * first slip is accepted. Once one has been, the total is the least useful of the three,
   * and a row with three numbers on it is the confusion this task was asked to remove.
   */
  return {
    figures: describeOwedFigures(outstandingMinor, nextDueMinor),
    noteKey: null,
    owes: true,
  };
}

/** The order's own total, quietly and without a label — this list's long-standing figure. */
const unlabelledTotal = (totalMinor: bigint | null): readonly RowFigure[] =>
  totalMinor === null ? [] : [{ labelKey: null, amountMinor: totalMinor, emphasis: 'quiet' }];
