import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { orders } from '@wewin/db/schema';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { desc, eq, inArray, sql, type SQL } from '@wewin/db/sql';
import type { OrderStatus } from '@wewin/db/schema';

import { AppError } from '../../common/errors/app-error';
import { DRIZZLE } from '../../database/database.tokens';
import type { Scope } from '../../rbac';
import { ownershipFilter } from './order-ownership';
import { orderReach, type OrderIntent, type OrderReach } from './order-reach';
import {
  BIGGEST_DEBT_FIRST,
  ORDER_COLUMNS,
  OWING_ORDERS,
  scopedOrder,
  type OrderRow,
  type ScopedOrder,
} from './scoped-order';

/**
 * The only way an order row enters this application.
 *
 * ── The one rule ────────────────────────────────────────────────────────────────
 *
 * Every method here builds its WHERE as `orderFilter(scope, intent, …)`, which is
 * `ownershipFilter(orderReach(scope, intent))` and something else. There is no method that
 * takes an id without a scope, no overload that omits one, and no `findByIdUnsafe` kept
 * for a script. That is plan 7.4 trap 2 answered structurally rather than by review: not
 * "remember to check the owner" but "there is nothing to remember, because the row you did
 * not own was never in the result set".
 *
 * ── Missing and forbidden are the same answer ───────────────────────────────────
 *
 * `find` returns `undefined` for an order that does not exist *and* for one that exists
 * and is somebody else's, and `findOrFail` turns both into the same 404 with the same
 * message. That is not politeness — a 403 for "exists but not yours" and a 404 for "no
 * such order" is an oracle: iterate ids, read the status codes, and you have counted the
 * company's orders and can tell a real order number from a guess. The same reasoning as
 * the anonymous-caller assertion in `tests/admin/catalog-admin.pg.test.ts`, where a 404 on
 * a path that does not exist would have told an anonymous caller which products do.
 *
 * The cost is a support conversation ("it says not found and I am looking at the email").
 * That is a cost paid in the dashboard, where staff hold `orders.read` and see the row.
 *
 * ── Locking ─────────────────────────────────────────────────────────────────────
 *
 * `lock` is trap 4's first half: *load the order and take the lock before choosing the
 * payload schema*, because `cancel` has two rows in `order_status_transitions` — one each
 * side of the freeze — and the post-freeze one carries `fault`. A controller that picks a
 * zod schema by transition name before it knows `from_status` picks the pre-freeze one and
 * zod strips `fault` silently. `lock` returns the status and `frozen_at`, under `FOR
 * UPDATE`, which is the information that choice needs and the moment it becomes safe to
 * make it.
 *
 * It is deliberately not called `findForUpdate`. The name says what it is for.
 */

/** Drizzle names the transaction type nowhere public; read off the callback, as `admin/draft.repository.ts` does. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface OrderListOptions {
  /** Restrict to these statuses. Absent means every status, including the terminal ones. */
  readonly statuses?: readonly OrderStatus[];
  /**
   * Keep only the orders that still owe money — `OWING_ORDERS`, evaluated in Postgres.
   *
   * A plain boolean here and a two-valued enum on the wire (`?payment=outstanding`), and the
   * asymmetry is deliberate: `slips.contract.ts` refuses `z.coerce.boolean()` on a query string
   * because `"false"` coerces to `true`, which is the one place a boolean flag reliably means
   * the opposite of what was typed. Past the parse there is no string left to misread.
   *
   * ⚠️ It **narrows**, like `statuses` beside it. Both are pushed onto the same `filters` array
   * that starts with `ownershipFilter(reach)` and is folded with `and`, so no value of either
   * can add a row — see the note on `list`.
   */
  readonly owing?: boolean;
  /** Defaults to 50. A page a human reads, not a report — reports come later and stream. */
  readonly limit?: number;
  readonly offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class ScopedOrderRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The one door into a transaction, so a caller cannot forget to open one.
   *
   * Same shape as `DraftRepository.transaction`. The state machine's write path runs
   * inside this and calls `lock` as its first statement.
   */
  async transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /** One order, or nothing. `undefined` covers both "no such order" and "not yours" — see above. */
  async find(scope: Scope, orderId: string, intent: OrderIntent): Promise<ScopedOrder | undefined> {
    if (!isUuid(orderId)) return undefined;
    const reach = orderReach(scope, intent);

    const rows = await this.db
      .select(ORDER_COLUMNS)
      .from(orders)
      .where(orderFilter(orderId, reach))
      .limit(1);

    return first(rows, reach, intent);
  }

  /** `find`, as a 404 rather than an absence. The message is the same for both causes, on purpose. */
  async findOrFail(scope: Scope, orderId: string, intent: OrderIntent): Promise<ScopedOrder> {
    const order = await this.find(scope, orderId, intent);
    if (!order) throw notFound();
    return order;
  }

  /**
   * The same row, locked, inside a transaction the caller opened.
   *
   * `FOR UPDATE` orders the writers; it does not forbid anything on its own (trap 6 says
   * so in as many words). What it buys here is that the status and `frozen_at` this
   * returns cannot change under the caller between the read and the INSERT that follows —
   * which is what makes choosing the payload schema from them sound.
   *
   * The lock is taken on `orders` alone. The claimed-guest subquery in the read predicate
   * reads `guests` and does not lock it, which is why acting never uses that branch: an
   * action must be reachable through a column on the row it locked.
   */
  async lock(tx: Tx, scope: Scope, orderId: string, intent: OrderIntent): Promise<ScopedOrder | undefined> {
    if (!isUuid(orderId)) return undefined;
    const reach = orderReach(scope, intent);

    const rows = await tx
      .select(ORDER_COLUMNS)
      .from(orders)
      .where(orderFilter(orderId, reach))
      .limit(1)
      .for('update');

    return first(rows, reach, intent);
  }

  async lockOrFail(tx: Tx, scope: Scope, orderId: string, intent: OrderIntent): Promise<ScopedOrder> {
    const order = await this.lock(tx, scope, orderId, intent);
    if (!order) throw notFound();
    return order;
  }

  /**
   * The caller's own orders, or the staff queue, from one query.
   *
   * There is no separate `listMine` and `listAll`. Two methods would be two predicates,
   * and the second one is where somebody eventually writes the version without the owner
   * term because "this one is for staff". The reach decides, and a customer's reach makes
   * this list their own orders whether the caller intended a queue or not.
   *
   * ── ⚠️ Every filter is a term in one `and`, and that is what makes it safe ───────
   *
   * `filters` starts as `[ownershipFilter(reach)]` and every option appends. `every()` folds
   * them with `and`, so an option can only ever *remove* rows: there is no branch that replaces
   * the array, no `or`, and nothing that reads an option before deciding the reach. A caller
   * asking for `owing` gets the intersection of "orders I may see" and "orders that owe" — a
   * customer's own unpaid orders, or the whole company's for a holder of `orders.read` — and
   * cannot reach a third set. `tests/orders/list-outstanding.pg.test.ts` asserts it from
   * outside, as customer B.
   *
   * ── The money filter is a filter, not a fetch-and-sift ──────────────────────────
   *
   * `OWING_ORDERS` is SQL on the same single statement as the fold it tests, so the page that
   * comes back is already the answer — nothing downstream drops a row, and nothing downstream
   * could, because `limit` is applied by Postgres *after* the predicate. Sifting in TypeScript
   * would silently turn `limit=50` into "up to fifty, of which some number owe".
   */
  async list(scope: Scope, options: OrderListOptions = {}): Promise<ScopedOrder[]> {
    const reach = orderReach(scope, 'read');
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const filters: SQL[] = [ownershipFilter(reach)];
    if (options.statuses !== undefined) {
      /*
       * An explicit empty list means "no statuses", which is an empty result — not "every
       * status". Drizzle's `inArray` with an empty array is a SQL syntax hazard, and the
       * silent widening is the failure worth guarding.
       */
      filters.push(options.statuses.length === 0 ? sql`false` : inArray(orders.status, [...options.statuses]));
    }
    /*
     * `=== true` rather than a truthiness test, for the reason `exactOptionalPropertyTypes` is
     * on in the first place: `owing` may legitimately be absent, and `undefined` must read as
     * "the caller did not ask", never as a filter that quietly applies.
     */
    const owing = options.owing === true;
    if (owing) filters.push(OWING_ORDERS);

    const rows = await this.db
      .select(ORDER_COLUMNS)
      .from(orders)
      .where(every(filters))
      /*
       * ⭐ The debt decides the order, but only when the debt is the question.
       *
       * `updatedAt desc` is what a queue wants — the thing that moved most recently is the thing
       * you are being asked about — and it is exactly wrong for chasing money: the largest debt
       * in the company is usually the *stalest* row, so on a hundred-row page it sorts last and
       * a `limit` can push it off the page altogether. Answering "who owes us most" with a list
       * ordered by recency is the filter existing and still not being usable.
       *
       * Why a default ordering and not a `sort` parameter: a parameter would have to admit the
       * combination that is never wanted (`owing` + recency, which buries the answer) and would
       * be a second axis of API surface with no second caller. The one ordering the filter needs
       * is implied by the filter, so it comes with it — and `BIGGEST_DEBT_FIRST` is the
       * overview's own ordering, so page one of this filter continues the money card's top eight
       * instead of disagreeing with it. When somebody genuinely needs a different sort, that is
       * the moment to name the parameter, with a caller to justify each value.
       *
       * ⚠️ The unfiltered list is untouched. `?payment=all` — the default — is the same two
       * columns in the same direction it has always been.
       */
      .orderBy(...(owing ? [BIGGEST_DEBT_FIRST] : [desc(orders.updatedAt), desc(orders.id)]))
      .limit(limit)
      .offset(options.offset ?? 0);

    return rows.map((row) => scopedOrder(row, reach, 'read'));
  }
}

/**
 * `id = $1 AND <ownership>`, in that order and never separately.
 *
 * A module-level function rather than a method so it can be unit-tested against the SQL it
 * produces, and so that the two call sites above cannot each grow their own version.
 */
function orderFilter(orderId: string, reach: OrderReach): SQL {
  return sql`${eq(orders.id, orderId)} and ${ownershipFilter(reach)}`;
}

/**
 * Any uuid version — `orders.id` is v4 today and a switch to v7 must not become a 404.
 *
 * Checked before the statement rather than after it, because `where id = 'nonsense'`
 * against a uuid column is SQLSTATE 22P02 — a 500 for a request that is simply about an
 * order that cannot exist. Same treatment as a guest cookie that is not a uuid
 * (`rbac/guest-cookie.ts`): a value that cannot be an id is not an id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Exported because `order_change_requests.id` is the same kind of value arriving the same
 * way, and it was the one path segment that reached a uuid column unchecked — a 500 any
 * client could produce by typing. One test of what an id may look like, not two.
 */
export function isOrderUuid(value: string): boolean {
  return UUID.test(value);
}

const isUuid = isOrderUuid;

/** `and` over a list, without Drizzle's `SQL | undefined` — see `ownershipFilter`'s note on dropped terms. */
function every(filters: readonly SQL[]): SQL {
  return filters.reduce((left, right) => sql`${left} and ${right}`);
}

function first(rows: readonly OrderRow[], reach: OrderReach, intent: OrderIntent): ScopedOrder | undefined {
  const row = rows[0];
  return row === undefined ? undefined : scopedOrder(row, reach, intent);
}

/**
 * The same 404 for every reason an order was not returned.
 *
 * Thai, because it reaches a customer. It deliberately does not say "or you may not see
 * it": a message that distinguishes the two cases is the same oracle as two status codes,
 * spelled out.
 */
function notFound(): AppError {
  return AppError.notFound('ไม่พบคำสั่งซื้อนี้');
}
