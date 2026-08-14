import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import type { OrderStatus } from '@wewin/db/schema';
import { sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
import { NON_LIVE_ORDER_STATUSES_SQL } from '../orders/live-order';
import { businessMonthStart } from './business-month';
import type {
  CatalogOverviewWire,
  NotificationsOverviewWire,
  OrdersOverviewWire,
  QuotesOverviewWire,
  RefundsOverviewWire,
  ReviewsOverviewWire,
  SlipsOverviewWire,
  UsersOverviewWire,
} from './overview.contract';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The counts behind the overview. One method per card, and no method that
 * answers for two — so the service can fetch exactly what the caller may see.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ **Every predicate here is the queue's own, borrowed rather than restated.** Two
 * `WHERE` clauses that mean the same thing today are still two clauses, and the overview's
 * is the one nobody opens — so it is the one that rots, and it rots into a number on a
 * landing page that quietly disagrees with the screen it links to. Where the database owns
 * the definition (`review_is_moderated`, `order_outstanding_thb_minor`) this file calls the
 * function instead of inlining what it does.
 *
 * ── ⚠️ `db.execute` bypasses Drizzle's type parsers ──────────────────────────
 *
 * Raw SQL comes back through node-postgres alone, and node-postgres returns `bigint`
 * (`int8`) as a **string** — which `count(*)` is. Declaring `number` on the generic
 * type-checks cleanly and hands the caller a string at runtime; this codebase has already
 * paid for that lesson once, in `users.repository.ts`, with a `created_at.toISOString is
 * not a function`. So every count is cast `::int` in the SQL, where the cast is checkable,
 * and every money amount is cast `::text` and parsed to `bigint` deliberately.
 */

/**
 * ⭐ An order that is somebody's live obligation — the predicate, as an object.
 *
 * A draft is not a commitment, and a cancelled or superseded order's money is a refund or a
 * forfeit rather than a debt. That sentence used to appear once, inside the aggregate's
 * subquery; there are now two readers of it in this file — the total and the list of orders
 * behind the total — and they are the pair it would be worst to let drift. A card whose total
 * counted an order its own breakdown had dropped is precisely the "two clauses that mean the
 * same thing today" failure this file's header is about, except visible on one screen at once.
 *
 * ⭐ **There is now a third reader, in another module and another language**, and that is why
 * the membership moved out. `GET /orders` folds the same figure onto every row, and until
 * `orders/encode.ts` learned this sentence a cancelled order printed its whole remainder in
 * the ค้างชำระ column of a list whose own money card said ฿0. That encoder cannot import a
 * WHERE clause, so what it shares is the *list* — `NON_LIVE_ORDER_STATUSES` in
 * `orders/live-order.ts`, which is where the reasoning about refunds and carried money now
 * lives. This stays a fragment of this file's own because it names the alias `o`, and an alias
 * is a contract a repository holds with itself.
 *
 * ⚠️ It names the alias `o`, so every statement that uses it must select `from orders o`.
 */
const LIVE_ORDERS = sql`o.status not in (${NON_LIVE_ORDER_STATUSES_SQL})`;

/**
 * How many orders the breakdown carries. Eight, and the reasoning is on `OutstandingOrderWire`.
 *
 * Named rather than inlined so the number the test asserts and the number the query applies are
 * the same one — a cap proven with a literal typed twice is a cap nobody is holding.
 */
export const OUTSTANDING_ORDERS_CAP = 8;

/**
 * What the breakdown query returns, in the database's own column names and node-postgres's own
 * types.
 *
 * A `type` and not an `interface`: `db.execute<T>` constrains `T` to `Record<string, unknown>`,
 * and only a type alias gets the implicit index signature that satisfies it. The other queries
 * in this file meet the same constraint by writing their shape inline.
 */
type OutstandingOrderQueryRow = {
  readonly id: string;
  readonly order_no: string | null;
  readonly status: OrderStatus;
  /** `::text`, then `BigInt` — the header's rule for every money amount that comes back raw. */
  readonly outstanding: string;
};

/** One row of the breakdown, in this application's own terms. Encoded by `overview.service.ts`. */
export interface OutstandingOrderRow {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly outstandingThbMinor: bigint;
}

@Injectable()
export class OverviewRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * ⚠️ A count of zero has no row.
   *
   * `count(*) ... group by status` returns nothing at all for a status no order is in, so
   * reading the six statuses straight off the result would leave them `undefined` and the
   * screen would render blanks on the quietest — and most reassuring — day. The zeros are
   * supplied here rather than in the client.
   */
  async orders(): Promise<OrdersOverviewWire> {
    const rows = await this.db.execute<{ status: string; n: number }>(sql`
      select status, count(*)::int as n
        from orders
       group by status
    `);

    const by = new Map(rows.rows.map((row) => [row.status, row.n]));
    const count = (status: string): number => by.get(status) ?? 0;

    return {
      draft: count('draft'),
      awaitingPayment: count('awaiting_payment'),
      productionConfirmed: count('production_confirmed'),
      inProduction: count('in_production'),
      awaitingInstallation: count('awaiting_installation'),
      redesign: count('redesign'),
    };
  }

  /** `slips.repository.ts`'s `listSubmitted` is `where status = 'submitted'`. Same clause. */
  async slips(): Promise<SlipsOverviewWire> {
    const rows = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from payment_slips where status = 'submitted'
    `);

    return { awaitingReview: rows.rows[0]?.n ?? 0 };
  }

  async refunds(): Promise<RefundsOverviewWire> {
    const rows = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from refunds where status = 'requested'
    `);

    return { requested: rows.rows[0]?.n ?? 0 };
  }

  /**
   * The money card: two figures and the orders behind one of them.
   *
   * `receivedThisMonth` reads `reviewed_at`, not `transferred_at`: the customer's claim
   * about when they paid is not the company's record of when it decided the money was real,
   * and a month's takings that can be moved by a customer typing a date is not a figure.
   *
   * `outstanding` calls `order_outstanding_thb_minor()` per order rather than re-deriving
   * `grand_total − settled`. Slower by a function call per row, and it is the same number
   * an order screen shows because it is literally the same code.
   *
   * `coalesce(..., 0)` on both: `sum()` over no rows is NULL, and NULL is how a
   * quiet month becomes a blank card.
   *
   * ── Two statements, issued together ──────────────────────────────────────────────
   *
   * The aggregate and the breakdown are different shapes — one row of scalars against a
   * capped, ordered set of rows — and forcing them into one statement would mean aggregating
   * to JSON inside the query and hand-parsing it back. They are `Promise.all`ed instead, so
   * the card still costs one round trip's latency, which is the same bargain
   * `overview.service.ts` makes across the nine cards.
   *
   * ⭐ And they read the *same* predicate object, not the same words typed twice. See
   * `LIVE_ORDERS`.
   */
  async money(): Promise<{
    readonly receivedThisMonth: bigint;
    readonly outstanding: bigint;
    readonly outstandingOrders: readonly OutstandingOrderRow[];
  }> {
    const [totals, owing] = await Promise.all([
      this.db.execute<{ received: string; outstanding: string }>(sql`
        select
          (select coalesce(sum(amount_thb_minor), 0)::text
             from payment_slips
            where status = 'accepted'
              and reviewed_at >= ${businessMonthStart}) as received,
          (select coalesce(sum(order_outstanding_thb_minor(o.id)), 0)::text
             from orders o
            where ${LIVE_ORDERS}) as outstanding
      `),
      /*
       * ⚠️ CAPPED AT EIGHT, AND THE CAP IS THE FEATURE — `OutstandingOrderWire` argues it out.
       * The short version: this is a call list, not the receivables book, and the total beside
       * it is what stops a truncated list from reading as the whole debt.
       *
       * `order_outstanding_thb_minor(o.id) > 0` and not `>= 0`: an order that owes nothing is
       * not a debt, and eight rows of ฿0.00 would push the real ones off the card. It is
       * evaluated twice — once to filter, once to sort — which Postgres is free to collapse
       * because the function is STABLE, and which is still cheaper than a second copy of the
       * fold living here in a CTE somebody has to keep in step.
       *
       * `nulls last` on `submitted_at` is defensive rather than reachable: `LIVE_ORDERS`
       * admits only post-submit statuses, so the column is set on every row this can return.
       * `o.id` last makes the order total, so a page is stable between two renders.
       */
      this.db.execute<OutstandingOrderQueryRow>(sql`
        select o.id::text                              as id,
               o.order_no                              as order_no,
               o.status                                as status,
               order_outstanding_thb_minor(o.id)::text as outstanding
          from orders o
         where ${LIVE_ORDERS}
           and order_outstanding_thb_minor(o.id) > 0
         order by order_outstanding_thb_minor(o.id) desc, o.submitted_at asc nulls last, o.id
         limit ${OUTSTANDING_ORDERS_CAP}
      `),
    ]);

    const row = totals.rows[0];

    return {
      receivedThisMonth: BigInt(row?.received ?? '0'),
      outstanding: BigInt(row?.outstanding ?? '0'),
      outstandingOrders: owing.rows.map((order) => ({
        id: order.id,
        orderNo: order.order_no,
        status: order.status,
        outstandingThbMinor: BigInt(order.outstanding),
      })),
    };
  }

  async quotes(): Promise<QuotesOverviewWire> {
    const rows = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from approvals where status = 'pending'
    `);

    return { approvalsPending: rows.rows[0]?.n ?? 0 };
  }

  /**
   * ⭐ `review_is_moderated(reviews)` — the function, not a copy of it.
   *
   * The rule it encodes is genuinely intricate: a review is moderated once it is hidden, or
   * published early, or its moderation window has elapsed. `review.repository.ts` filters
   * the queue on `not review_is_moderated(...)`, and restating three clauses here would be
   * volunteering to keep two copies of that rule in step.
   */
  async reviews(): Promise<ReviewsOverviewWire> {
    const rows = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from reviews r where not review_is_moderated(r)
    `);

    return { awaitingModeration: rows.rows[0]?.n ?? 0 };
  }

  async notifications(): Promise<NotificationsOverviewWire> {
    const rows = await this.db.execute<{ dead: number; suppressed: number }>(sql`
      select
        count(*) filter (where status = 'dead')::int       as dead,
        count(*) filter (where status = 'suppressed')::int as suppressed
        from notifications
    `);

    const row = rows.rows[0];

    return { dead: row?.dead ?? 0, suppressed: row?.suppressed ?? 0 };
  }

  /**
   * Catalogue health.
   *
   * `products` is every row, matching `GET /admin/catalog/products`, which does not
   * paginate — if it ever starts to, this number and that list stop agreeing and
   * `overview.pg.test.ts` says so.
   */
  async catalog(): Promise<CatalogOverviewWire> {
    const rows = await this.db.execute<{
      products: number;
      drafts: number;
      option_groups: number;
    }>(sql`
      select
        (select count(*)::int from products)                                as products,
        (select count(*)::int from product_versions where status = 'draft') as drafts,
        (select count(*)::int from option_groups)                           as option_groups
    `);

    const row = rows.rows[0];

    return {
      products: row?.products ?? 0,
      unpublishedDrafts: row?.drafts ?? 0,
      optionGroups: row?.option_groups ?? 0,
    };
  }

  async users(): Promise<UsersOverviewWire> {
    const rows = await this.db.execute<{ active: number; suspended: number }>(sql`
      select
        count(*) filter (where status = 'active')::int    as active,
        count(*) filter (where status = 'suspended')::int as suspended
        from users
    `);

    const row = rows.rows[0];

    return { active: row?.active ?? 0, suspended: row?.suspended ?? 0 };
  }
}
