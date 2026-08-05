import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger';
import { RefundsController } from './refunds.controller';
import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';

/**
 * Refunds by ordinary bank transfer — phase 5b.
 *
 * It imports `LedgerModule` and nothing else. `DatabaseModule` is `@Global`, and `RbacModule`
 * binds its guard with `APP_GUARD` over the whole graph, so this module is enforced and audited
 * whether or not it knows either exists — a handler added here without an access policy stops
 * the process from starting rather than producing an open endpoint.
 *
 * It does not import `OrdersModule`, and that is the design rather than an omission. A refund is
 * not an order transition (plan 7.12, mirroring 7.3): this module reads `orders` and
 * `order_events` to find out what was cancelled and whose fault it was, and it writes neither.
 * A module that could reach `OrdersService` is a module that will eventually move an order's
 * status from a refund handler.
 *
 * There is no notification provider either, for the reason `OrdersModule` gives: notifications
 * are consumers of `order_events` and the fan-out is a trigger. ⚠️ The consequence, stated
 * because it is a gap and not a feature — **this module writes no event, so a customer is told
 * nothing when their refund is approved or paid.** Closing it means either an `order_events` row
 * that is not a status change (the table supports exactly three such types today, and `refunded`
 * is not one of them) or a second outbox. Both are somebody else's file.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────────
 *
 * ⚠️ This module still has to be added to `AppModule.forRoot`'s import list — a file this
 * round's split does not put in one agent's hands. Until it is, none of these routes exist in
 * the running process. `tests/payments/refunds/refunds.pg.test.ts` boots the real application
 * graph *plus* this module explicitly, exactly as `tests/orders/support/lifecycle-app.ts` does,
 * so the suite proves the feature while `tests/rbac/route-audit.test.ts` remains the alarm for
 * the wiring itself.
 */
@Module({
  imports: [LedgerModule],
  controllers: [RefundsController],
  providers: [RefundsService, RefundsRepository],
  exports: [RefundsService],
})
export class RefundsModule {}
