import { Module } from '@nestjs/common';

import { ScheduleRepository } from './schedule.repository';
import { ScheduleService } from './schedule.service';

/**
 * The instalment schedule — phase 5b.
 *
 * ── It has no controller, and that is the phase boundary ─────────────────────────
 *
 * Nothing here is reachable over HTTP. Authoring a schedule per order is plan 7.10 and is
 * 5c's work, and it arrives with an authority check attached — a gate below the floor, or no
 * gate at all, is the company extending credit and is a permission distinct from the one
 * that allows a discount. Shipping the route now and the check later is the order that
 * produces a feature nobody can take back.
 *
 * What 5b needs is that the *model* exists so the submit path can write a schedule and the
 * repricing path can move one, and both of those are service calls inside somebody else's
 * transaction. So this module exports a service and nothing else.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Not yet imported by `AppModule`, and it does not need to be until a module that has
 * routes depends on it. `OrdersModule` is the caller this was built for: `submit` should
 * `open()` a schedule and pin `depositMinor()` into `orders.scheduled_deposit_thb_minor`
 * instead of computing the deposit itself, and every path that rewrites a document should
 * `recompute()`. Both edits are in `apps/api/src/orders`, which is not this agent's to
 * change, so they are written down here rather than done.
 */
@Module({
  providers: [ScheduleService, ScheduleRepository],
  exports: [ScheduleService],
})
export class ScheduleModule {}
