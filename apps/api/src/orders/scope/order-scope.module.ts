import { Module } from '@nestjs/common';

import { ScopedOrderRepository } from './scoped-order.repository';

/**
 * The scoped loader, as a provider anything in the orders feature can import.
 *
 * A module of its own rather than a provider inside `OrdersModule`, so the dependency
 * points one way: the state machine and the outbox import scoping; scoping imports neither
 * and cannot grow a reason to. That is what keeps the row filter reviewable on its own —
 * a change to it is a change to this directory and to nothing else.
 *
 * `DRIZZLE` is exported by the `@Global` `DatabaseModule`, so there is nothing to import
 * here; this module has no imports on purpose, and a future one would be a signal that
 * authorisation had started depending on a feature.
 */
@Module({
  providers: [ScopedOrderRepository],
  exports: [ScopedOrderRepository],
})
export class OrderScopeModule {}
