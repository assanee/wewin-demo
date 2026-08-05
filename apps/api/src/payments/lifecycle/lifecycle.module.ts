import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger';
import { ScheduleModule } from '../schedule';
import { LifecycleRepository } from './lifecycle.repository';
import { PaymentLifecycleService } from './lifecycle.service';

/**
 * The one module `OrdersModule` imports from `payments`, and the only direction that edge runs.
 *
 * It has no controller and never will: every movement here is a consequence of an order
 * transition, and an HTTP route that wrote one would be a way to forfeit a deposit or recognise
 * revenue with no event behind it — the same reason `LedgerModule` has none.
 */
@Module({
  imports: [ScheduleModule, LedgerModule],
  providers: [PaymentLifecycleService, LifecycleRepository],
  exports: [PaymentLifecycleService],
})
export class PaymentLifecycleModule {}
