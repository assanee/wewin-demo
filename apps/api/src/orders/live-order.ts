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
 * ⚠️ NOT a mirror of a database function. Unlike `POST_FREEZE_STATUSES` (which mirrors
 * `order_status_is_post_freeze()`) there is no `order_status_is_live()` in Postgres to drift
 * from — this list *is* the definition, in one file, and that is why it may be held in
 * TypeScript at all under the "money is computed in Postgres" rule. Nothing here computes,
 * adjusts or compares an amount; it decides only whether the amount Postgres already computed
 * describes a live obligation.
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
 * trigger and this one is a definition with no database counterpart — and that file's header
 * carries the argument. What was collapsed instead is the pair of booleans the customer's
 * payment screen was reading; `PaymentInstructionsWire` now carries `orderIsLive` alone.
 */
export const NON_LIVE_ORDER_STATUSES = [
  'draft',
  'cancelled',
  'superseded',
] as const satisfies readonly OrderStatus[];

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
