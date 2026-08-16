/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHEN THERE IS STILL SOMETHING TO PAY — the rule the two LINK SITES read.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two screens offer a way to the payment page — the quotation itself and the list on
 * `/account` — and the worst outcome is not a missing button but a present one: "ชำระเงิน"
 * on an order the customer **cancelled** reads as a bill, on a contract where the company may
 * owe *them* the deposit back, and the screen behind it refuses the slip anyway.
 *
 * ⚠️ That sentence used to be about a job delivered last month, and it was wrong about which
 * kind of finished order is the danger. A delivered order still owes what it owes; a cancelled
 * one owes nothing, or owes backwards. See the ⭐ note further down.
 *
 * ── ⚠️ THE LIST-ONLY MIRROR. THE SERVER'S ANSWER GOVERNS THE PAYMENT SCREEN ──
 *
 * `PaymentInstructionsWire.orderIsLive` is the authority on whether an order can still be
 * paid, computed by the API from the same predicate the staff money card reads.
 * `PaymentIsland` reads that boolean and nothing in this file: it prints no owed figure and
 * no upload form when the server says the order is dead. **This module must never be used to
 * decide what the payment screen renders.** It answers a smaller question, for two screens
 * that cannot ask the server:
 *
 *   `MyQuotations` renders fifty rows of `GET /orders`, whose wire carries no instructions —
 *   asking per row is the fifty-one-queries cost this file was written to refuse — and
 *   `QuotationIsland` renders a quotation, which for the token half deliberately carries no
 *   order id at all. Both draw a *link*; neither states a figure the server did not send.
 *
 * The consequence of getting this copy wrong is therefore bounded and one-directional: a
 * missing door (the customer goes to sales) or a door onto a screen that now says, in one
 * clear sentence, that the order is dead. Before the server's boolean existed, that same
 * screen printed "ยอดคงค้างทั้งหมด ฿10,354.18" and an upload form on a cancelled order.
 *
 * ── ⚠️ It is still a MIRROR, and the migration is still the definition ───────
 *
 * `SLIP_ATTACHABLE_STATUSES` in `apps/api/src/payments/slips/attachable.ts`, which is
 * itself a mirror of the `payment_slips_live_orders_only` trigger — written by
 * `packages/db/drizzle/0011_payment_guards.sql` and widened by
 * `0046_slips_after_delivery.sql`. The migrations are the definition; there are three copies
 * of the list and this is the furthest from it, so it is the one most likely to drift.
 * `tests/payment-entry.test.ts` reads the API's constant out of its own source and asserts
 * the two lists agree, character for character.
 *
 * ── ⚠️ SHOULD THIS FILE STILL EXIST? RE-ASKED THIS ROUND, AND YES ───────────
 *
 * `delivered` joining the list makes it select exactly the six statuses `isLiveOrder`
 * selects, and the payment screen's two booleans collapsed into one on the strength of that.
 * The obvious next step is to delete this mirror and let the row's money answer alone —
 * `MyQuotations` already writes `acceptsPayment(row.status) && money.owes`, and
 * `encodeOrderSummary` nulls the folds on precisely the orders nobody owes anything on.
 *
 * **It does not work, and the reason is in `quotationRowMoney.ts`.** A row whose folds are
 * null answers `owes: true`, deliberately: null also means *a bundle newer than the API it is
 * talking to*, where the fields are simply absent and the row must fall back to what this
 * list printed before the folds existed. So `money.owes` is `true` on a cancelled order, and
 * the status half is the only thing refusing the button on it. Dropping this file would put
 * "ชำระเงิน" back on a cancelled order — the exact defect the whole sequence began with.
 *
 * The copy that would actually delete this one is still `orderIsLive` on `OrderSummaryWire`,
 * so a row could be asked as cheaply as it is listed. That is a change to a shape
 * `apps/dashboard` reads too, and it is not this round's either.
 *
 * The list is not "awaiting_payment" and the reason is the deposit: the balance is
 * transferred while the order is already `in_production`, so a rule naming only the first
 * status would hide the button from every customer paying the second half. What has to be
 * refused is a slip against a *dead* contract — `cancelled` and `superseded` — where money
 * arriving is a reconciliation exception rather than a payment, and on the cancelled row may
 * be owed the other way entirely.
 *
 * ⭐ `delivered` is on the list and used not to be, which is this round's change. The owner
 * reported it as *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"* — hand the job over before the
 * balance is collected and the money can never be taken through the software. A delivered
 * order is a contract *fulfilled*, not abandoned: the customer has the goods and genuinely
 * owes the balance, so the door belongs on that row. `0046_slips_after_delivery.sql` carries
 * the argument for separating it from the two dead statuses.
 *
 * `draft` is absent from the server's list too, and means something different again: not
 * "finished" but "not started". A draft is a cart the API happens to be holding. It has no
 * order number, no pinned document and no total, so there is no figure to pay against —
 * `MyQuotations` already filters it out by `submittedAt`, and this agrees.
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
  'delivered',
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

/**
 * ⭐ Whether the figures on a quotation are still an estimate — the owner's "ราคาประมาณ".
 *
 * A quotation the customer has asked for and staff have not yet agreed carries a real total,
 * pinned to a real document: they may read it, print it and think about it. What it is not is a
 * number anybody has committed to, and the owner's decision was that the customer should see it
 * *labelled as such* rather than not see it at all.
 *
 * ⚠️ Deliberately NOT the negation of `acceptsPayment`. Cancelled and superseded orders are also
 * unpayable and their figures are not estimates — they are what was agreed, and the order ended.
 * One list answers "may they pay?", this answers "is this final?", and the day those two
 * questions get one implementation between them is the day a cancelled order starts telling a
 * customer its total was a guess.
 */
export function isApproximatePrice(status: string): boolean {
  return status === 'awaiting_confirmation';
}
