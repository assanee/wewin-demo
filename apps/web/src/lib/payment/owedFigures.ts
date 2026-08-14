import type { UiKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE FIGURE OR TWO, AND WHICH ONE LEADS — decided once, for both screens.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two places print `outstandingThbMinor` and `nextDueThbMinor` to a customer, one click
 * apart: `MyQuotations` (through `quotationRowMoney.ts`) and `PaymentIsland`. They must
 * agree about *which* figure is the prominent one, because a customer who reads ฿4,320.00
 * on the list and then reads ฿14,400.00 as the headline of the screen the list sent them
 * to concludes the price went up.
 *
 * That is not hypothetical — it is the defect this module was extracted to close. The list
 * was built to lead with the next instalment while the payment screen still led with the
 * outstanding, and nothing in the code held the two together: the rule ("two figures only
 * when they are genuinely two numbers, and the one being asked for comes first") lived in
 * `quotationRowMoney.ts` alone, where the payment screen could not reach it.
 *
 * ⚠️ **Total in, total out.** Both amounts are folded by Postgres
 * (`order_outstanding_thb_minor()`, `order_next_due_thb_minor()`) and arrive already
 * decided. Nothing here adds, subtracts or compares-then-derives an amount; the only
 * arithmetic is the ordering test that chooses between two shapes.
 *
 * ── Why the labels are keys and not text ─────────────────────────────────────
 *
 * `payment.outstanding` and `payment.dueNow` exist in all eight locales and are named here
 * rather than resolved, so the amounts stay `bigint` and each screen renders them with its
 * own formatter and its own tokens. `Emphasis` is a *role*, not a class: the list paints
 * `lead` as `text-body text-chalk` and the payment screen paints it `text-lead text-lime`.
 */

/** How prominently one figure is printed. A caller renders at most one `lead`. */
export type Emphasis = 'lead' | 'quiet';

export interface OwedFigure {
  readonly labelKey: Extract<UiKey, 'payment.dueNow' | 'payment.outstanding'>;
  readonly amountMinor: bigint;
  readonly emphasis: Emphasis;
}

/**
 * What to print for an order that has an outstanding balance, in reading order.
 *
 * ── ⚠️ EQUAL FIGURES PRINT ONCE, UNDER THE OUTSTANDING LABEL ─────────────────
 *
 * A pay-in-full order has `nextDue === outstanding`, and so does a 30/70 once the deposit
 * has been accepted — the balance is both the whole remaining debt and the next instalment.
 * Printing that number twice under two labels *manufactures* the confusion this exists to
 * remove: two labels side by side assert a distinction, and a reader who sees the same
 * amount under both concludes they misread one of them.
 *
 * Read the other way round: **the "pay now" label appears only when it differs from the
 * outstanding**, which is the only time a label whose whole job is to distinguish two
 * figures has one to distinguish.
 *
 * ── The two guards ───────────────────────────────────────────────────────────
 *
 * `nextDue <= 0` is a guard rather than a case: an order that owes something must have a
 * first unsettled instalment with a remainder, and if the two folds ever disagreed about
 * that, printing "pay now ฿0.00" beside a real debt is the worst of the available outputs.
 *
 * A settled order (`outstanding <= 0`, `<=` because an overpayment is modelled and not an
 * error) also lands in the single-figure branch, since its `nextDue` of `0n` is not less
 * than it. Callers that say something *else* about a settled order — the list's
 * `payment.settled` note, the payment screen's box — decide that themselves; this only
 * ever answers "which amounts, which labels, in which order".
 */
export function describeOwedFigures(
  outstandingMinor: bigint,
  nextDueMinor: bigint,
): readonly OwedFigure[] {
  if (nextDueMinor >= outstandingMinor || nextDueMinor <= 0n) {
    return [{ labelKey: 'payment.outstanding', amountMinor: outstandingMinor, emphasis: 'lead' }];
  }

  /*
   * Two figures: an instalment is due and there is more behind it. The one being asked for
   * leads, on both screens — that is the owner's decision, and now it is one decision.
   */
  return [
    { labelKey: 'payment.dueNow', amountMinor: nextDueMinor, emphasis: 'lead' },
    { labelKey: 'payment.outstanding', amountMinor: outstandingMinor, emphasis: 'quiet' },
  ];
}
