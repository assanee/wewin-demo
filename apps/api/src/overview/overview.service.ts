import { Injectable } from '@nestjs/common';
import { encodeThb } from '@wewin/contract/order';

import type { Scope } from '../rbac/scope';
import type { OverviewWire } from './overview.contract';
import { OverviewRepository } from './overview.repository';
import { visibleSections } from './sections';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The overview, assembled for one caller.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ **A count the caller may not see is never fetched.**
 *
 * The obvious implementation reads all nine cards and deletes the ones the caller is not
 * entitled to. It gives the same response today and it is the wrong shape: the unpermitted
 * numbers exist, in memory, in a variable, one careless edit away from being spread into
 * the result. Filtering is a rule somebody has to keep applying; not fetching is a rule that
 * cannot be forgotten, because there is nothing there to leak.
 *
 * It is also cheaper in the case that matters — a catalogue editor's overview is one query,
 * not nine — which is a happy consequence rather than the reason.
 *
 * `Promise.all` over the permitted set: the cards are independent, so nine queries for an
 * administrator cost one round trip's latency rather than nine.
 */
@Injectable()
export class OverviewService {
  constructor(private readonly repository: OverviewRepository) {}

  async overview(scope: Scope): Promise<OverviewWire> {
    const wanted = new Set(visibleSections(scope));

    /*
     * `undefined` for a card that was not asked for, and the spreads below drop the key
     * entirely. Not `null`: `JSON.stringify` writes `"orders": null`, which is exactly the
     * "you may not see this, and now you know it exists" disclosure the section table
     * exists to prevent.
     */
    const [orders, slips, refunds, money, quotes, reviews, notifications, catalog, users] =
      await Promise.all([
        wanted.has('orders') ? this.repository.orders() : undefined,
        wanted.has('slips') ? this.repository.slips() : undefined,
        wanted.has('refunds') ? this.repository.refunds() : undefined,
        wanted.has('money') ? this.repository.money() : undefined,
        wanted.has('quotes') ? this.repository.quotes() : undefined,
        wanted.has('reviews') ? this.repository.reviews() : undefined,
        wanted.has('notifications') ? this.repository.notifications() : undefined,
        wanted.has('catalog') ? this.repository.catalog() : undefined,
        wanted.has('users') ? this.repository.users() : undefined,
      ]);

    /*
     * Written in the section table's order so the response's keys are the same for every
     * caller. A screen that walks the keys then gets a stable layout, and two responses can
     * be diffed without being sorted first.
     */
    return {
      ...(orders !== undefined && { orders }),
      ...(slips !== undefined && { slips }),
      ...(refunds !== undefined && { refunds }),
      ...(money !== undefined && {
        money: {
          /*
           * Tagged on the way out, never sent as a bare integer. `MoneyWire` carries its
           * unit — `THB.satang` — so a client cannot render satang as baht by forgetting to
           * divide, which is the failure this codebase spends a whole contract package
           * preventing.
           */
          receivedThisMonth: encodeThb(money.receivedThisMonth),
          outstanding: encodeThb(money.outstanding),
          /*
           * The same tagging, one level down — and the same repository read, so the total and
           * the orders under it were taken against one predicate rather than assembled from two
           * fetches a caller could have made at different moments.
           */
          outstandingOrders: money.outstandingOrders.map((order) => ({
            id: order.id,
            orderNo: order.orderNo,
            status: order.status,
            outstandingThbMinor: encodeThb(order.outstandingThbMinor),
          })),
        },
      }),
      ...(quotes !== undefined && { quotes }),
      ...(reviews !== undefined && { reviews }),
      ...(notifications !== undefined && { notifications }),
      ...(catalog !== undefined && { catalog }),
      ...(users !== undefined && { users }),
    };
  }
}
