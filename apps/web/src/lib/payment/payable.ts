/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHEN THERE IS STILL SOMETHING TO PAY — the one rule both entry points read.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two screens now offer a way to the payment page — the quotation itself and the list on
 * `/account` — and the worst outcome is not a missing button but a present one: "ชำระเงิน"
 * on a job that was delivered last month reads as a bill the customer has already settled,
 * and the screen behind it refuses the slip anyway.
 *
 * ── ⚠️ This is a MIRROR, and the server is the definition ────────────────────
 *
 * `SLIP_ATTACHABLE_STATUSES` in `apps/api/src/payments/slips/slips.service.ts`, which is
 * itself a mirror of the `payment_slips_live_orders_only` trigger in
 * `packages/db/drizzle/0011_payment_guards.sql`. The migration is the definition; there are
 * now three copies of the list and this is the furthest from it, so it is the one most
 * likely to drift. `tests/payment-entry.test.ts` reads the API's constant out of its own
 * source and asserts the two lists agree, character for character.
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
 * ── ⚠️ What this rule CANNOT see: an order that is already fully paid ────────
 *
 * Deliberately not covered, because neither caller has the fact. `outstandingThbMinor` is
 * `grand_total − order_settled_thb_minor()`, folded per-order by the API, and it is served
 * by exactly one endpoint: `GET /orders/:id/payment-instructions`. Neither `GET /orders`
 * (the account list) nor `GET /orders/:id` (the quotation heading) carries it — `encodeOrder`
 * ships `net`, `vat`, `grandTotal` and `scheduledDeposit` and stops there.
 *
 * So a customer who has paid in full, on an order still `in_production`, is still offered the
 * action. That is the honest failure of the two: they arrive at the payment screen, which
 * *does* know, and it says `payment.settled` and renders no form. A wrong "nothing to pay
 * here" on the list would be the expensive direction, and hiding the action would need this
 * layer to guess at money it cannot read.
 *
 * Closing it properly is one field — `outstandingThbMinor` on `OrderSummaryWire` — and that
 * is an API change with a cost this task was not asked to spend: the fold is a per-order SQL
 * call, and putting it on a 50-row list turns one query into fifty-one.
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
