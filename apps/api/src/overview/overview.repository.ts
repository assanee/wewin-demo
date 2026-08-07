import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { DRIZZLE } from '../database/database.tokens';
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
   * The two money figures, in one round trip.
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
   */
  async money(): Promise<{ readonly receivedThisMonth: bigint; readonly outstanding: bigint }> {
    const rows = await this.db.execute<{ received: string; outstanding: string }>(sql`
      select
        (select coalesce(sum(amount_thb_minor), 0)::text
           from payment_slips
          where status = 'accepted'
            and reviewed_at >= ${businessMonthStart}) as received,
        (select coalesce(sum(order_outstanding_thb_minor(o.id)), 0)::text
           from orders o
          where o.status not in ('draft', 'cancelled', 'superseded')) as outstanding
    `);

    const row = rows.rows[0];

    return {
      receivedThisMonth: BigInt(row?.received ?? '0'),
      outstanding: BigInt(row?.outstanding ?? '0'),
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
