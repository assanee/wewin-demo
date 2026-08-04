/**
 * Row-level scoping for orders — what the rest of the orders feature imports.
 *
 * The surface is deliberately small, and what is *missing* from it is the point:
 *
 *   - there is no exported way to build a `ScopedOrder`. `scopedOrder()` lives in
 *     `scoped-order.ts` and is not re-exported, so a row that did not come out of
 *     `ScopedOrderRepository` cannot be passed anywhere a `ScopedOrder` is expected.
 *   - there is no exported `canRead(order, scope)` and there never should be. A predicate
 *     over a row already in hand is plan 7.4 trap 2 exactly: the row is loaded by then, and
 *     the next refactor drops the call. Ownership is a term in the WHERE clause.
 *   - `ownershipFilter` is exported so a *new* query in this feature can be written with
 *     the same predicate rather than a fresh one. Anything that needs it should prefer the
 *     repository; anything that genuinely cannot (an aggregate, a join) must still pass
 *     through `orderReach`, so the reach stays the single decision.
 */

export { OrderScopeModule } from './order-scope.module';

export {
  ScopedOrderRepository,
  type OrderListOptions,
  type Tx,
} from './scoped-order.repository';

export { isPostFreeze, type ScopedOrder } from './scoped-order';

export {
  ORDER_INTENTS,
  STAFF_PERMISSION,
  describeReach,
  orderReach,
  type OrderIntent,
  type OrderOwner,
  type OrderReach,
} from './order-reach';

export { ownershipFilter } from './order-ownership';

/** The shape check every id from a URL goes through before it reaches a `uuid` column. */
export { isOrderUuid } from './scoped-order.repository';

export { orderActor, type OrderActor, type OrderActorKind } from './order-actor';
