import { orders } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { sql, type SQL } from '@wewin/db/sql';
import type { OrderStatus } from '@wewin/db/schema';

import { NON_LIVE_ORDER_STATUSES_SQL } from '../live-order';
import type { OrderIntent, OrderReach } from './order-reach';

/**
 * An order row that a scoped query returned — and a type nothing else can produce.
 *
 * ── The brand, and what it actually buys ────────────────────────────────────────
 *
 * Plan 7.4 trap 2 says ownership belongs in the query. That closes the hole for code
 * written today. What it does not close on its own is the *next* refactor: somebody adds
 * `db.select().from(orders).where(eq(orders.id, id))` in a service — for a debugging
 * endpoint, for a report, for a batch job — and hands the row to the same transition
 * handler the scoped path uses. Every type still lines up, because a row is a row.
 *
 * `OWNERSHIP_PROVEN` is a module-private `unique symbol`, so it does not line up. A plain
 * select produces an object without that key and the compiler refuses it wherever a
 * `ScopedOrder` is expected. There is no cast anywhere in this module that manufactures
 * one: `scopedOrder()` below is the sole constructor, it is not exported from `index.ts`,
 * and it takes the reach that produced the row as an argument it cannot invent.
 *
 * That is the strongest statement TypeScript can make about a runtime fact, and it is
 * worth being precise about its limits: it stops a row from *travelling*, not from being
 * *read*. A handler that selects an order and returns it straight to the client has not
 * touched this type. The end-to-end sweep in
 * `tests/orders/scope/cross-tenant-routes.pg.test.ts` is what covers that case, by asking
 * the live router for every order route and calling all of them as the wrong customer.
 *
 * ── Why every column ────────────────────────────────────────────────────────────
 *
 * The row carries the whole order rather than a projection each caller picks. A projection
 * would mean a second query — or a second query *builder* — the day the state machine
 * needs `frozen_at` and this returned only the id, and a second builder is a second place
 * for the ownership term to be missing from. One shape, one query, one filter.
 */

/**
 * A real runtime symbol, so the value below can be constructed without a cast.
 *
 * Not exported. A module that cannot name the key cannot write it, which is what makes
 * this a nominal type rather than a naming convention.
 */
const OWNERSHIP_PROVEN = Symbol('wewin.orders.ownershipProven');

export interface ScopedOrder {
  /**
   * Present only on a row that came back from a query carrying `ownershipFilter(reach)`.
   *
   * The value is prose because the value is never read. What is read is the *type*, by the
   * compiler, at every boundary that takes a `ScopedOrder`.
   */
  readonly [OWNERSHIP_PROVEN]: 'loaded by a query that filtered on ownership';

  readonly id: string;
  /** Null until submit — a draft is a cart and burning a number on browsing publishes the abandonment rate. */
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  /** The event that put this order in `status`. The composite deferrable FK's other half. */
  readonly statusEventId: string;

  readonly customerUserId: string | null;
  readonly guestId: string | null;

  readonly contactEmail: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactLocale: string;
  /** Chosen by the customer at submit; null on every cart and every order that predates it. */
  readonly destinationCountry: string | null;

  readonly supersedesOrderId: string | null;

  /**
   * The freeze point as a fact, not an inference (plan 7.5(ข)).
   *
   * Non-null means aluminium was committed at least once. It survives into `cancelled` and
   * `superseded`, which is why a caller must read *this* and not the status when deciding
   * anything about money.
   */
  readonly frozenAt: Date | null;
  readonly submittedAt: Date | null;
  /** The pinned document this order is contracted on — trap 3. Null before submit. */
  readonly documentId: string | null;

  readonly currency: string;
  readonly netThbMinor: bigint | null;
  readonly vatThbMinor: bigint | null;
  /** Always VAT-inclusive — plan 4.4, and the one number every other number derives from. */
  readonly grandTotalThbMinor: bigint | null;
  /** Pinned at submit because it is a term of the contract, not a value computed later (plan 7.13). */
  readonly scheduledDepositThbMinor: bigint | null;
  /**
   * The `cashflow` approval floor this contract was judged against, in basis points.
   *
   * Pinned at submit for the same reason the deposit above it is, and NULL on every order that
   * predates the column — see the schema note on `orders.deposit_floor_bp`. Selected here
   * because this row is the whole order and not a projection each caller picks; the measurement
   * itself reads it through `AuthorityRepository`, which has its own narrower select.
   */
  readonly depositFloorBp: number | null;

  /**
   * Still owed, and due now — computed by Postgres on this row, in this query.
   *
   * ── Why they are on the row and not fetched beside it ───────────────────────────
   *
   * Because the alternative is a query per order. `GET /orders` serves both front ends and
   * returns fifty rows, and the fold is per-order: a caller that asked
   * `PaymentLifecycleService.customerFigures` once per row would turn one statement into
   * fifty-one, which is the cost `apps/web/src/lib/payment/payable.ts` refused to pay and the
   * reason the field did not exist until now. As two more expressions in the target list it
   * costs the same one round trip, which is what `overview.repository.ts` already does with
   * `order_outstanding_thb_minor(o.id)` inside its own single statement.
   *
   * They are on `ORDER_COLUMNS` — the one shape — rather than on a second, wider select used
   * only by `list`. Two selects would be two places for the ownership term to go missing from,
   * which is the whole argument this file is built on, and `OrderWire` extends
   * `OrderSummaryWire` so a single-order read needs the same two numbers anyway. The write
   * path pays for them too, and gets something for it: `lock` reads them inside the
   * transaction, so the order a transition hands back reports the money as that transaction
   * left it rather than as it was before.
   *
   * ⚠️ Not columns of `orders` — derived, and derived *there*. `order_outstanding_thb_minor()`
   * (0011) and `order_next_due_thb_minor()` (0042) are the only definitions of these two
   * numbers in this system; nothing here subtracts, sums or coalesces its way to a second one.
   * Both are total: 0 rather than NULL for a cart with no schedule, which is the answer 0042
   * argues for at length. Whether a cart's ฿0.00 is *shown* is the encoder's decision, not
   * this row's — see `encodeOrderSummary`.
   */
  readonly outstandingThbMinor: bigint;
  readonly nextDueThbMinor: bigint;

  /**
   * ⭐ How much of this order's balance has been **forgiven** — `order_written_off_thb_minor()`
   * (0048), the third term inside the fold above.
   *
   * On the same row and not a query beside it, for the same reason the other two are: one
   * statement, fifty rows. And on this row rather than only where a write-off is displayed,
   * because it is what tells a ฿0.00 outstanding apart from a ฿0.00 outstanding — the customer
   * paid, or the company gave up. Every screen that reads `outstandingThbMinor` needs the
   * distinction, which is why it travels with it.
   *
   * ⛔ `outstandingThbMinor` is already net of this. Postgres subtracts it; nothing here does.
   */
  readonly writtenOffThbMinor: bigint;

  readonly createdAt: Date;
  readonly updatedAt: Date;

  /**
   * Why this row was visible, and what it was loaded for.
   *
   * Carried on the row rather than remembered by the caller so that a handler cannot log
   * "staff read order X" about a row a customer loaded, and so that an action path can
   * assert it is holding a row loaded for `act` rather than one that came from a list.
   */
  readonly reach: OrderReach;
  readonly intent: OrderIntent;
}

/**
 * ⭐ What this order still owes — the expression, as one object with three readers.
 *
 * It is selected as a column (below), filtered on, and sorted by, and those are exactly the
 * three places `overview.repository.ts` had to type `order_outstanding_thb_minor(o.id)` three
 * times inside one statement. Written out three times here it would be three chances for a
 * `coalesce` to appear in the column and not in the predicate — at which point a row whose fold
 * is NULL is *listed* as ฿0.00 and *filtered* as unknown, which is a row that appears in the
 * queue and vanishes from the filter for no reason a reader could see.
 *
 * ⚠️ No `::text` here. The cast belongs to the column, which has to hand node-postgres a string
 * (see the note on `outstandingThbMinor`); a WHERE clause and an ORDER BY want the `int8` so
 * that `> 0` is an integer comparison and the sort is numeric rather than lexicographic —
 * `'900' > '1000'` as text, which would put ฿9.00 above ฿10.00 at the top of a debt list.
 *
 * ⚠️ And no alias, unlike the overview's `LIVE_ORDERS`. `orders.id` is a Drizzle column object
 * and serialises as `"orders"."id"`, so this composes into any statement selecting `from orders`
 * unaliased — which is every statement in `scoped-order.repository.ts`. A statement that aliased
 * the table would not compile against it, and that is the honest failure.
 */
const OUTSTANDING_FOLD: SQL = sql`coalesce(order_outstanding_thb_minor(${orders.id}), 0)`;

/**
 * ⭐ An order that still owes money — in Postgres, on the same statement, and with the same
 * definition of "live" as everywhere else.
 *
 * Two terms, and the second is the one a reader would forget:
 *
 *   ⓵ **The fold is above zero.** `> 0` and not `>= 0`, exactly as
 *     `overview.repository.ts` writes it: an order that owes nothing is not a debt, and the
 *     fold goes *negative* on an overpaid order (`0011_payment_guards.sql`), which is a
 *     modelled state and equally not a debt. This is the term the owner asked for.
 *
 *   ⓶ **The order is somebody's live obligation.** `NON_LIVE_ORDER_STATUSES_SQL` — the list in
 *     `orders/live-order.ts`, which is the definition — and not a fourth copy of it. Without
 *     this term the filter would answer with every cancelled order in the company, because the
 *     fold is total and a cancelled contract still has a remainder. Worse, it would answer with
 *     rows whose `outstandingThbMinor` the encoder then nulls (`isLiveOrder`), so the ค้างชำระ
 *     filter would return a page of em dashes — a filter listing the orders it is asking about
 *     and refusing to state the figure for any of them.
 *
 * The two terms come from the two places that already own them, which is what makes this the
 * same question `GET /overview`'s money card answers, uncapped.
 */
export const OWING_ORDERS: SQL = sql`${orders.status} not in (${NON_LIVE_ORDER_STATUSES_SQL}) and ${OUTSTANDING_FOLD} > 0`;

/**
 * Biggest debt first — the ordering the owner asked for, spelled the way the overview spells it.
 *
 * `order by fold desc, submitted_at asc nulls last, id` is character-for-character the intent of
 * the breakdown query in `overview.repository.ts`, and that is deliberate rather than tidy: the
 * money card shows the top eight by *this* ordering, and this filter is meant to be the uncapped
 * continuation of that list. Ordered differently, page one of the filter would not contain the
 * eight rows the card just showed, and a reader clicking through from one to the other would
 * conclude that one of the two screens is wrong.
 *
 * `nulls last` on `submitted_at` is defensive rather than reachable — `draft` is a non-live
 * status, so every row this predicate admits is post-submit — and `id` last makes the order
 * total, so two renders of the same page cannot disagree.
 */
export const BIGGEST_DEBT_FIRST: SQL = sql`${OUTSTANDING_FOLD} desc, ${orders.submittedAt} asc nulls last, ${orders.id}`;

/** The columns a scoped select asks for. One shape, so every load returns the same row. */
export const ORDER_COLUMNS = {
  id: orders.id,
  orderNo: orders.orderNo,
  status: orders.status,
  statusEventId: orders.statusEventId,
  customerUserId: orders.customerUserId,
  guestId: orders.guestId,
  contactEmail: orders.contactEmail,
  contactName: orders.contactName,
  contactPhone: orders.contactPhone,
  contactLocale: orders.contactLocale,
  destinationCountry: orders.destinationCountry,
  supersedesOrderId: orders.supersedesOrderId,
  frozenAt: orders.frozenAt,
  submittedAt: orders.submittedAt,
  documentId: orders.documentId,
  currency: orders.currency,
  netThbMinor: orders.netThbMinor,
  vatThbMinor: orders.vatThbMinor,
  grandTotalThbMinor: orders.grandTotalThbMinor,
  scheduledDepositThbMinor: orders.scheduledDepositThbMinor,
  depositFloorBp: orders.depositFloorBp,
  /*
   * ⚠️ `.mapWith(BigInt)` and `::text`, not a bare `sql<bigint>` — the generic is a claim to
   * TypeScript and nothing more (`review.repository.ts` says it in those words). `int8` reaches
   * node-postgres as a *string*, so a declared `bigint` type-checks and hands the encoder
   * `'1412400'` at runtime; the cast makes the string deliberate and the decoder makes it a
   * `bigint` where the row is built. `coalesce` mirrors `ledger.repository.ts`'s own call: the
   * fold is NULL only for an order id that names no row, which cannot happen when the id comes
   * off the row being selected — and a NULL that slipped through would reach `encodeThb`.
   *
   * ⚠️ The outstanding one is `OUTSTANDING_FOLD` above rather than the same call typed again,
   * because `OWING_ORDERS` and `BIGGEST_DEBT_FIRST` read it too. Same SQL as before; one
   * definition instead of three. `nextDueThbMinor` keeps its own — nothing filters or sorts on
   * it, so there is one reader and nothing to drift from.
   */
  outstandingThbMinor: sql`${OUTSTANDING_FOLD}::text`.mapWith(BigInt),
  nextDueThbMinor: sql`coalesce(order_next_due_thb_minor(${orders.id}), 0)::text`.mapWith(BigInt),
  /*
   * ⭐ Its own call for the same reason `nextDueThbMinor` keeps one: nothing filters or sorts on
   * it. `coalesce` is belt-and-braces — `order_written_off_thb_minor()` is a `sum()` with a
   * `coalesce(…, 0)` inside it and cannot return NULL even for an order id naming no row — kept so
   * that all three folds on this row read identically and none of them can reach `encodeThb` null.
   */
  writtenOffThbMinor: sql`coalesce(order_written_off_thb_minor(${orders.id}), 0)::text`.mapWith(BigInt),
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
} as const;

/** Exactly what a `select(ORDER_COLUMNS)` yields, so the constructor cannot drift from it. */
export type OrderRow = Omit<ScopedOrder, typeof OWNERSHIP_PROVEN | 'reach' | 'intent'>;

/**
 * The sole constructor. Not exported from `index.ts`.
 *
 * It takes the reach as an argument because the caller must have had one to build the
 * query — there is no default and nothing to guess. A file that wants to fabricate a
 * `ScopedOrder` has to import this deep path *and* produce an `OrderReach`, which is two
 * deliberate acts and shows up in a diff as what it is.
 */
export function scopedOrder(row: OrderRow, reach: OrderReach, intent: OrderIntent): ScopedOrder {
  return { ...row, [OWNERSHIP_PROVEN]: 'loaded by a query that filtered on ownership', reach, intent };
}

/**
 * Past the freeze point, from the column rather than from the status.
 *
 * `order_status_is_post_freeze()` in the database answers the same question about a
 * *status*, and `POST_FREEZE_STATUSES` mirrors it. Neither can answer it about a cancelled
 * order, which is exactly when a cancellation report asks — hence `frozen_at`.
 */
export function isPostFreeze(order: ScopedOrder): boolean {
  return order.frozenAt !== null;
}
