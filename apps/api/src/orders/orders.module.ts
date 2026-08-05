import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { PaymentLifecycleModule } from '../payments/lifecycle';
import { FunnelThrottleMiddleware } from './funnel-throttle.middleware';
import { OrderRepository } from './order.repository';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderScopeModule } from './scope';

/**
 * The order lifecycle — phase 5a.
 *
 * It imports two things. `OrderScopeModule` provides `ScopedOrderRepository`, which is the
 * only way anything here loads an order — the dependency points one way on purpose, so the
 * row filter stays reviewable on its own and cannot grow a reason to know about the state
 * machine. And `CatalogModule`, for `CatalogRepository`. That is not a convenience
 * either. Submitting an order prices it, pricing it needs the *published* document, and that
 * module's own note says why the read has to go through it rather than through a second
 * query over `product_versions`: the document a customer is quoted from is the frozen one,
 * its hash is verified on the way out, and a second reader would eventually disagree with the
 * first about which of those two things it was serving.
 *
 * It imports nothing else and exports nothing. `DatabaseModule` is `@Global`, and `RbacModule`
 * binds its guard with `APP_GUARD` over the whole graph — so this module is enforced and
 * audited whether or not it knows either of them exists, and a handler added here without an
 * access policy stops the process from starting rather than producing an open endpoint.
 *
 * ── There is no notification provider here, and that is the design ───────────────
 *
 * Plan 10.1: notifications are a *consumer* of `order_events`. The fan-out is a deferred
 * constraint trigger on that table, so appending an event is what queues the messages, in the
 * same transaction, with nothing for this module to call and nothing for it to forget. The
 * delivery side lives in `src/notifications` and this module does not import it — an order
 * module that could reach a transport is an order module that will eventually be given a
 * `sendEmail()` in a transition handler, which is the whole thing the outbox exists to stop.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────────
 *
 * ⚠️ This module still has to be added to `AppModule.forRoot`'s import list, which is a file
 * this round's split does not put in one agent's hands. Until it is, none of these routes
 * exist in the running process — and `tests/orders/scope/cross-tenant-routes.pg.test.ts`
 * fails by design when its sweep finds no order routes, which is the intended way to notice.
 */
@Module({
  /*
   * `PaymentLifecycleModule` and not `SlipsModule`/`RefundsModule`: the edge from the order
   * lifecycle to money runs in exactly one direction, and it runs through one service with four
   * methods. Slips and refunds import *from* here, so importing either of them back would be a
   * cycle — and `forwardRef` is a way of writing a cycle down rather than not having one.
   */
  imports: [CatalogModule, OrderScopeModule, PaymentLifecycleModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderRepository, FunnelThrottleMiddleware],
})
export class OrdersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /*
     * One route, and it is the only one that is unauthenticated: `POST /orders` mints the
     * principal, so it cannot require one, and it was therefore unbounded row creation
     * reachable by anybody. See funnel-throttle.middleware.ts for what it does and does not
     * bound — in particular, it meters only callers with *no* identity, because a caller who
     * already has a referent is metered by the scope rules instead.
     *
     * Declared here rather than in `AppModule.configure` so that the rule travels with the
     * route it is about: a module registered without its own middleware would otherwise lose
     * the limit silently, which is the same wiring failure that left this module out of the
     * graph for a whole round.
     */
    consumer.apply(FunnelThrottleMiddleware).forRoutes({ path: 'orders', method: RequestMethod.POST });
  }
}
