import type { OrderStatus } from '@wewin/db/schema';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHICH ORDERS CAN STILL RECEIVE A PAYMENT — the service-side mirror of the trigger.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `payment_slips_live_orders_only` (`packages/db/drizzle/0011_payment_guards.sql`, widened by
 * `0046_slips_after_delivery.sql`) is the definition: it fires on the INSERT, so it is the
 * only copy a customer's money can actually be refused by. This list is the *service-side*
 * mirror of it, and it has to exist separately because `SlipsService.assertSlipAttachable`
 * runs **before** the bytes are uploaded, where there is no row for a trigger to fire on.
 *
 * ── ⚠️ Why this is its own file, and not a `const` inside `slips.service.ts` ──
 *
 * The reason has changed and the file has not. It was extracted because
 * `OrdersService.paymentInstructions` had become a second reader, answering an
 * `acceptsPayment` boolean on `PaymentInstructionsWire`. **That field is gone** — see below —
 * so the second reader is now `apps/web/tests/payment-entry.test.ts`, which parses this
 * literal out of this source because `apps/web` may not import `apps/api`. A `const` buried in
 * a service is a poor thing to parse and a worse thing to import: pulling `SlipsService` into
 * `src/orders` is exactly the require cycle `orders/index.ts` and `organisation.module.ts`
 * both warn about. The list stays in a file whose only dependency is the status type.
 *
 * ── ⚠️ THIS LIST AND `NON_LIVE_ORDER_STATUSES` NOW SELECT THE SAME SET ──────
 *
 * The header here used to insist, at length, that they were *not* the same list and disagreed
 * about `delivered` on purpose. That gap was the defect: a delivered order that owed a balance
 * was live (the money card chased it) and closed to slips (this list refused it), so the debt
 * was real, visible, and uncollectable through the software. `0046` closed it, and with
 * `delivered` on this list the two predicates agree on all nine statuses —
 * `tests/payments/slips/attachable.test.ts` enumerates `ORDER_STATUSES` and asserts exactly
 * that, rather than inviting anybody to compare two arrays by eye.
 *
 * ⚠️ **They agree; they are still two lists, and merging them would be the wrong repair.**
 * This one is a *mirror* — it exists to say what a Postgres trigger says, and
 * `attachable-drift.pg.test.ts` reads the trigger out of the live catalogue to hold it there.
 * `NON_LIVE_ORDER_STATUSES` is mirrored too, since 0049 gave it `order_status_is_live()` and a
 * drift test of its own — this sentence claimed it "mirrors nothing … with no database
 * counterpart to drift from" for exactly as long as that was true, and pointed at a header that
 * by then said the reverse. Pointing the upload guard at the
 * live-order list would leave the trigger with no mirror at all, and the next widening of
 * either question would move a list that two unrelated readers share. The duplication worth
 * removing was the one on the **wire**, where a client was handed two booleans for one
 * question; that one has been removed.
 */

/**
 * The statuses a slip may be attached to, in the migration's own order.
 *
 * 0007 predicted this list would be `'{awaiting_payment}'` and the prediction is wrong the
 * moment there is a deposit: the balance slip is transferred while the order is already in
 * production. What must be refused is a slip against a **dead** contract — `cancelled` and
 * `superseded` — where money arriving is a reconciliation exception rather than a payment,
 * and on the cancelled row may be owed the other way entirely.
 *
 * `delivered` is on the list, and 0046's header carries the argument: a delivered job is a
 * contract *fulfilled*, not a contract abandoned. The customer has the goods, and if the
 * balance was not collected on the day they owe it — an ordinary payment arriving late, with
 * no direction to be uncertain about. Refusing it stranded the money, because `delivered` has
 * no transition out.
 *
 * `draft` is absent for a third reason again: a cart has no document, no number and no total,
 * so there is nothing to pay against yet.
 *
 * ⚠️ The declaration's *shape* is load-bearing beyond this file.
 * `apps/web/tests/payment-entry.test.ts` parses this literal out of this source — `apps/web`
 * does not depend on `apps/api` and must not start — and compares it, character for
 * character, against `apps/web/src/lib/payment/payable.ts`'s list-only mirror. Rewriting it
 * as a `satisfies` clause or a computed value is a legitimate change that has to update that
 * regex with it.
 */
export const SLIP_ATTACHABLE_STATUSES: readonly OrderStatus[] = [
  'awaiting_payment',
  'production_confirmed',
  'in_production',
  'awaiting_installation',
  'delivered',
  'redesign',
];

/**
 * Whether this order can still receive a payment through the storefront.
 *
 * The question behind the 409 (`order_not_accepting_slips`) and behind the trigger under it.
 * It no longer answers a wire field: the payment screen reads `orderIsLive`, which since 0046
 * gives the same answer on every status and is the one of the two the customer's screen has
 * always actually meant.
 */
export function acceptsPayment(status: OrderStatus): boolean {
  return SLIP_ATTACHABLE_STATUSES.includes(status);
}
