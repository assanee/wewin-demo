/**
 * What `src/orders` imports to make an order's money follow its status.
 *
 * The repository is deliberately not exported: it moves allocation rows, and a second caller
 * moving allocations is a second opinion about whose money a payment is.
 */

export { PaymentLifecycleModule } from './lifecycle.module';
export { PaymentLifecycleService, type CancellationPrice } from './lifecycle.service';
