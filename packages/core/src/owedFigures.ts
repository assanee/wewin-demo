/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE FIGURE OR TWO, AND WHICH ONE LEADS — decided once, for every surface.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three places state `outstandingThbMinor` and `nextDueThbMinor` to a customer: `MyQuotations`
 * (through `quotationRowMoney.ts`), `PaymentIsland`, and — since the balance reminder — the
 * **email**, rendered by `apps/api`'s `order.balance_reminded.customer`. They must agree about
 * *which* figure is the prominent one, because a customer who reads ฿4,320.00 on the list and
 * then reads ฿14,400.00 as the headline of the screen the list sent them to concludes the price
 * went up.
 *
 * That is not hypothetical — it is the defect this module was extracted to close, twice. The
 * list was built to lead with the next instalment while the payment screen still led with the
 * outstanding, and nothing in the code held the two together. Then the reminder email was
 * written to name the outstanding alone while linking to a screen whose amount field opens on
 * the instalment, which is the same defect one surface further out.
 *
 * ── ⚠️ WHY THIS LIVES IN `@wewin/core` AND NOT IN `apps/web` ─────────────────
 *
 * Because `apps/api` cannot import `apps/web`, and the third surface is an email the API
 * renders. A rule restated in a second file is a rule that has already begun to drift — the
 * whole reason this module exists — so it moved down to the package both of them already
 * depend on rather than being copied into the one that could not reach it.
 *
 * ⚠️ **Total in, total out.** Both amounts are folded by Postgres
 * (`order_outstanding_thb_minor()`, `order_next_due_thb_minor()`) and arrive already decided.
 * Nothing here adds, subtracts or compares-then-derives an amount; the only arithmetic is the
 * ordering test that chooses between two shapes.
 *
 * ── Why the labels are keys and not text ─────────────────────────────────────
 *
 * `payment.outstanding` and `payment.dueNow` exist in all eight locales and are named here
 * rather than resolved, so the amounts stay `bigint` and each surface renders them with its own
 * formatter and its own tokens. `Emphasis` is a *role*, not a class: the list paints `lead` as
 * `text-body text-chalk`, the payment screen paints it `text-lead text-lime`, and the email —
 * which has no typography at all — paints it by printing it first.
 *
 * ⚠️ The two keys are `apps/web`'s catalogue keys, and `apps/web/src/lib/payment/owedFigures.ts`
 * re-exports this through a type that intersects them with `UiKey`. That re-export is not a
 * formality: it is the compile-time proof that both strings are still real catalogue entries,
 * which is a check this package cannot make for itself.
 */

/** How prominently one figure is printed. A caller renders at most one `lead`. */
export type Emphasis = 'lead' | 'quiet';

/**
 * The catalogue keys the two figures are labelled with, in `apps/web`'s namespace.
 *
 * Restated as a literal union rather than imported, because this package has no catalogue —
 * see the note above about where the proof that these are real keys actually lives.
 */
export type OwedLabelKey = 'payment.dueNow' | 'payment.outstanding';

export interface OwedFigure {
  readonly labelKey: OwedLabelKey;
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
 * `payment.settled` note, the payment screen's box, the reminder's refusal to be sent at
 * all — decide that themselves; this only ever answers "which amounts, which labels, in
 * which order".
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
   * leads, on every surface — that is the owner's decision, and now it is one decision.
   */
  return [
    { labelKey: 'payment.dueNow', amountMinor: nextDueMinor, emphasis: 'lead' },
    { labelKey: 'payment.outstanding', amountMinor: outstandingMinor, emphasis: 'quiet' },
  ];
}
