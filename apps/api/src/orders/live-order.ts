import type { OrderStatus } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { sql, type SQL } from '@wewin/db/sql';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHOSE DEBT IS A DEBT — one list, read by SQL and by TypeScript.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `order_outstanding_thb_minor()` answers *"how much of this contract is unsettled?"* and it
 * answers it about any order, in any status. That is the right question for the function to
 * answer and the wrong one to print in a ค้างชำระ column: a cancelled order still has a
 * remainder, and the remainder is not owed to anybody. Money the company is holding on an
 * order it cancelled is a **refund** question, which `src/payments/refunds` owns; money on a
 * `superseded` order is *carried* to its replacement (`refunds.service.ts` says so at length)
 * and is therefore already counted, once, on the order that replaced it. Printing either as a
 * live balance asks a customer for money they do not owe, or — worse on the cancelled row —
 * for money the company may owe *them*.
 *
 * ── ⚠️ Why this is a shared list and not a predicate written twice ────────────
 *
 * There were two readers of this sentence before this file existed and they were in different
 * languages: `overview.repository.ts`'s `LIVE_ORDERS`, in SQL, filtering the money card; and
 * nothing at all on the per-row folds `GET /orders` had just started sending — which is
 * precisely the bug. The obvious repair is a second predicate beside the encoder, and a second
 * predicate is how the overview total and the order list come to disagree about the same order
 * on two screens a click apart. `overview.repository.ts`'s own header already names that
 * failure mode ("two `WHERE` clauses that mean the same thing today are still two clauses").
 *
 * So the *list* is the definition and lives here once. The two readers each turn it into the
 * expression their language needs — a `not in (…)` fragment for a WHERE clause, an `includes`
 * for a row already in memory — and neither of them restates which statuses are in it.
 *
 * ── Why the list and not a `LIVE_ORDERS` fragment exported wholesale ──────────
 *
 * Because a SQL fragment carries an alias. `LIVE_ORDERS` names `o`, so every statement using it
 * must `from orders o`; that is a fine contract for one repository to hold with itself and a
 * poor one to publish. The overview keeps its own fragment, and its alias, and gets the
 * membership from here.
 *
 * ── ⚠️ It IS a mirror now, and it did not used to be ─────────────────────────
 *
 * This header said *"NOT a mirror of a database function … there is no `order_status_is_live()`
 * in Postgres to drift from"*, and that was true until `0049_write_off_live_order.sql`. A
 * write-off may not be recorded against a cancelled or superseded order, and that guard belongs
 * in the database as well as in the service — the same argument 0048 makes about the balance,
 * that the service is not the only writer — so the notion had to exist in SQL. The alternative
 * was a fifth, unnamed copy of the list inlined in a trigger body.
 *
 * So the arrangement is now exactly `POST_FREEZE_STATUSES`'s: **one list here, one function
 * there, and a test that fails when they disagree** —
 * `tests/orders/contract-drift.pg.test.ts` asks Postgres about all nine statuses and compares
 * every answer against `isLiveOrder`. Which of the two is "the definition" is a question this
 * file no longer needs to answer, because a mirror with a drift test cannot silently be wrong.
 *
 * ⛔ Still not money, either here or there. Nothing computes, adjusts or compares an amount; it
 * decides only whether the amount Postgres already computed describes a live obligation, which
 * is why it may be held in TypeScript at all under the "money is computed in Postgres" rule.
 */

/**
 * The three statuses in which an order is nobody's live obligation.
 *
 * `draft` is a cart — nothing has been agreed, so nothing can be owed. `cancelled` and
 * `superseded` are finished contracts, and they are the two this list was widened to catch:
 * both are reachable from either side of the freeze, so a residue on one is a refund or a
 * carry-forward rather than a bill.
 *
 * `delivered` is deliberately absent. A delivered job whose balance was never transferred is
 * exactly the debt the money card exists to chase — and since `0046_slips_after_delivery.sql`
 * it is a debt the customer can still settle through the storefront, so the sentence this
 * paragraph used to end on ("it makes it a phone call") is no longer true and has gone.
 *
 * ⚠️ That change means `isLiveOrder` and `acceptsPayment`
 * (`src/payments/slips/attachable.ts`) now answer identically for all nine statuses;
 * `tests/payments/slips/attachable.test.ts` enumerates them and asserts it. The two lists stay
 * separate because they are pinned to different things — that one is a mirror of a Postgres
 * trigger and this one, since 0049, is mirrored by `order_status_is_live()` and pinned by a
 * drift test over all nine statuses in `tests/orders/contract-drift.pg.test.ts` — and that
 * file's header carries the argument.
 *
 * ⚠️ This paragraph said "a definition with no database counterpart" until 0049 gave it one, and
 * was left standing twenty lines under a header that had already been corrected. One file
 * asserting both halves of a contradiction is worse than either half alone: whichever a reader
 * finds first, they stop looking. What was collapsed instead is the pair of booleans the customer's
 * payment screen was reading; `PaymentInstructionsWire` now carries `orderIsLive` alone.
 */
export const NON_LIVE_ORDER_STATUSES = [
  'draft',
  'cancelled',
  'superseded',
] as const satisfies readonly OrderStatus[];

/**
 * ⭐ Whether money the company is holding on this order is **free to send back**.
 *
 * The refund question, and the exact inverse of the one above rather than a second copy of a
 * status literal. `refunds.service.ts` answers 409 for every other status —
 * *"คืนเงินได้เฉพาะออร์เดอร์ที่ถูกยกเลิกแล้วเท่านั้น"* — so this is the one place the notion is
 * spelled, and `encode.ts` asks it rather than typing `'cancelled'` a second time.
 * `tests/orders/live-order.test.ts` fails on that literal appearing in the encoder, which is
 * how this function came to exist.
 *
 * ⚠️ `superseded` is not included, and the distinction is the whole reason this is not simply
 * `!isLiveOrder(status)`: a superseded order's money was carried to the order that replaced it
 * and is already counted there. Offering to refund it would offer to pay it twice. `draft` is
 * excluded for the ordinary reason — nothing was ever taken.
 */
export function holdsRefundableMoney(status: OrderStatus): boolean {
  return status === 'cancelled';
}

/** Whether this order's unsettled remainder is a debt somebody still owes. */
export function isLiveOrder(status: OrderStatus): boolean {
  return !(NON_LIVE_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

/**
 * The same three statuses as a SQL list, for a predicate that has to be written in SQL.
 *
 * `sql.join` over one bound parameter per status rather than a hand-typed `('draft', …)`: the
 * statuses reach Postgres as parameters, and — the point — the list they come from is the
 * array above, so a fourth status added there arrives in the WHERE clause without anybody
 * editing a string. Interpolated into `not in (…)` by the caller, which owns its own alias.
 */
export const NON_LIVE_ORDER_STATUSES_SQL: SQL = sql.join(
  NON_LIVE_ORDER_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);
