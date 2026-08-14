/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHEN THERE IS STILL SOMETHING TO PAY — the rule the two LINK SITES read.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two screens offer a way to the payment page — the quotation itself and the list on
 * `/account` — and the worst outcome is not a missing button but a present one: "ชำระเงิน"
 * on a job that was delivered last month reads as a bill the customer has already settled,
 * and the screen behind it refuses the slip anyway.
 *
 * ── ⚠️ THE LIST-ONLY MIRROR. THE SERVER'S ANSWER GOVERNS THE PAYMENT SCREEN ──
 *
 * `PaymentInstructionsWire.acceptsPayment` is now the authority on whether an order can
 * still be paid, computed by the API from `SLIP_ATTACHABLE_STATUSES` — the very list that
 * raises the 409. `PaymentIsland` reads that boolean and nothing in this file: it prints no
 * owed figure and no upload form when the server says the order is closed. **This module
 * must never be used to decide what the payment screen renders.** It answers a smaller
 * question, for two screens that cannot ask the server:
 *
 *   `MyQuotations` renders fifty rows of `GET /orders`, whose wire carries no instructions —
 *   asking per row is the fifty-one-queries cost this file was written to refuse — and
 *   `QuotationIsland` renders a quotation, which for the token half deliberately carries no
 *   order id at all. Both draw a *link*; neither states a figure the server did not send.
 *
 * The consequence of getting this copy wrong is therefore bounded and one-directional: a
 * missing door (the customer goes to sales) or a door onto a screen that now says, in one
 * clear sentence, that the order is closed. Before `acceptsPayment` existed, that same
 * screen printed "ยอดคงค้างทั้งหมด ฿10,354.18" and an upload form on a cancelled order.
 *
 * ── ⚠️ It is still a MIRROR, and the migration is still the definition ───────
 *
 * `SLIP_ATTACHABLE_STATUSES` in `apps/api/src/payments/slips/attachable.ts`, which is
 * itself a mirror of the `payment_slips_live_orders_only` trigger in
 * `packages/db/drizzle/0011_payment_guards.sql`. The migration is the definition; there are
 * three copies of the list and this is the furthest from it, so it is the one most likely to
 * drift. `tests/payment-entry.test.ts` reads the API's constant out of its own source and
 * asserts the two lists agree, character for character.
 *
 * The copy that would actually delete this one is `acceptsPayment` on `OrderSummaryWire`,
 * so a row could be asked as cheaply as it is listed. That is a change to a shape
 * `apps/dashboard` reads too, and it is not this round's.
 *
 * The list is not "awaiting_payment" and the reason is the deposit: the balance is
 * transferred while the order is already `in_production`, so a rule naming only the first
 * status would hide the button from every customer paying the second half. What has to be
 * refused is a slip against a *finished* contract — `delivered`, `cancelled`, `superseded`
 * — where money arriving is a reconciliation exception rather than a payment.
 *
 * `draft` is absent from the server's list too, and means something different from the other
 * three: not "finished" but "not started". A draft is a cart the API happens to be holding.
 * It has no order number, no pinned document and no total, so there is no figure to pay
 * against — `MyQuotations` already filters it out by `submittedAt`, and this agrees.
 *
 * ── ⚠️ What this rule STILL cannot see, and who now can ──────────────────────
 *
 * This function answers from the status and nothing else, so it cannot tell a fully paid
 * order from an unpaid one — both are `in_production`. That is not a gap to be closed here:
 * a status list that also knew about money would stop being comparable, character for
 * character, with the server's own list and the trigger underneath it, which is the one
 * property `tests/payment-entry.test.ts` exists to keep.
 *
 * ⭐ **The fact is available now, and the callers hold it.** `outstandingThbMinor` (and
 * `nextDueThbMinor` beside it) are columns of `OrderSummaryWire`, folded by Postgres inside
 * the same statement `GET /orders` already ran — one query for fifty rows, not fifty-one.
 * `MyQuotations` therefore draws its action on `acceptsPayment(row.status) && money.owes`,
 * with the money half decided by `components/account/quotationRowMoney.ts`.
 *
 * This header used to say the opposite — that the fold was served by exactly one endpoint,
 * that a paid order was still offered the action, and that closing it "turns one query into
 * fifty-one". All three sentences were true when they were written and none of them is now.
 * `QuotationIsland` still gates on the status alone: it reads one order and could ask, and
 * whether it should is a question for that screen rather than for this list.
 */

/**
 * The statuses a slip may be attached to, in the server's own order.
 *
 * Kept as a `readonly string[]` rather than a union of literals on purpose: the value being
 * tested arrives as `string` off the wire (`decodeQuotation` defaults it to `'unknown'`), and
 * a caller should not have to narrow an untrusted string before asking this question.
 */
export const PAYABLE_ORDER_STATUSES: readonly string[] = [
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'redesign',
];

/**
 * Whether an order in this status can still receive a transfer slip.
 *
 * ⚠️ Unknown statuses answer `false`. A status this bundle does not recognise is either a
 * decode failure (`'unknown'`) or a status added to the API after this bundle was built, and
 * in both cases the safe answer is to show nothing: a missing button sends the customer to
 * sales, a wrongly-shown one sends them to a screen that refuses them.
 */
export function acceptsPayment(status: string): boolean {
  return PAYABLE_ORDER_STATUSES.includes(status);
}
