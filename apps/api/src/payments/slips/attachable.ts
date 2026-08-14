import type { OrderStatus } from '@wewin/db/schema';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHICH ORDERS CAN STILL RECEIVE A PAYMENT — one list, read by the guard and by the screen.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `payment_slips_live_orders_only` (`packages/db/drizzle/0011_payment_guards.sql`) is the
 * definition: it fires on the INSERT, so it is the only copy a customer's money can actually
 * be refused by. This list is the *service-side* mirror of it, and it has to exist separately
 * because `SlipsService.assertSlipAttachable` runs **before** the bytes are uploaded, where
 * there is no row for a trigger to fire on.
 *
 * ── ⚠️ Why this is its own file, and not a `const` inside `slips.service.ts` ──
 *
 * Because there is now a second reader inside this API, and it is not a slip route.
 * `OrdersService.paymentInstructions` answers `acceptsPayment` on
 * `PaymentInstructionsWire` — the boolean the customer's payment screen renders its owed
 * figures and its upload form from. That screen and this guard have to agree by
 * construction: the whole defect the field was added for is a screen that printed
 * "ยอดคงค้างทั้งหมด ฿10,354.18" and an upload form on a **cancelled** order, over an endpoint
 * that would have answered the upload with a 409 from this very list.
 *
 * A `const` in a service is not importable without importing the service, and importing
 * `SlipsService` from `src/orders` is exactly the require cycle `orders/index.ts` and
 * `organisation.module.ts` both warn about (and would hand a feature module a second way to
 * decide when money has arrived). So the *list* moves to a file with no dependencies but the
 * status type, `slips.service.ts` imports it, and `orders.service.ts` imports it — the same
 * arrangement `src/orders/live-order.ts` reached, for the same reason, one round earlier.
 *
 * ⚠️ It is emphatically **not** the same list as `NON_LIVE_ORDER_STATUSES`, and the two
 * disagree about `delivered` on purpose. A delivered job whose balance was never transferred
 * still *owes* the money (`isLiveOrder('delivered') === true` — the money card exists to
 * chase exactly that), and it still cannot receive another slip through this door: collecting
 * it is a phone call and a reconciliation, not a customer pressing "ส่งสลิป". Two questions,
 * two lists, and a screen that conflated them would either bill a cancelled customer or hide
 * a real debt.
 */

/**
 * The statuses a slip may be attached to, in the migration's own order.
 *
 * 0007 predicted this list would be `'{awaiting_payment}'` and the prediction is wrong the
 * moment there is a deposit: the balance slip is transferred while the order is already in
 * production. What must be refused is a slip against a *finished* contract — `delivered`,
 * `cancelled`, `superseded` — because money arriving on one of those is a reconciliation
 * exception and not a payment. `draft` is absent for a different reason: a cart has no
 * document, no number and no total, so there is nothing to pay against yet.
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
  'redesign',
];

/**
 * Whether this order can still receive a payment through the storefront.
 *
 * The one question behind both the 409 (`order_not_accepting_slips`) and the wire field the
 * payment screen gates on, so the screen cannot offer what the endpoint would refuse.
 */
export function acceptsPayment(status: OrderStatus): boolean {
  return SLIP_ATTACHABLE_STATUSES.includes(status);
}
