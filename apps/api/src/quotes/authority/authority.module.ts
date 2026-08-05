import { Module } from '@nestjs/common';

import { ApprovalsController } from './approvals.controller';
import { AuthorityController } from './authority.controller';
import { AuthorityRepository } from './authority.repository';
import { AuthorityService } from './authority.service';

/**
 * Who may reduce what the customer pays — phase 5c.
 *
 * It imports nothing. `DatabaseModule` is `@Global`, and `RbacModule` binds its guard with
 * `APP_GUARD` over the whole graph, so this module is enforced and audited whether or not it
 * knows either exists: a handler added here without an access policy stops the process from
 * starting rather than producing an open endpoint.
 *
 * It deliberately does **not** import `OrdersModule` or `ScheduleModule`. This module reads
 * `orders`, `quote_lines`, `quote_overrides` and `order_instalments` and writes none of them —
 * a module that could reach `OrdersService` is a module that will eventually move an order's
 * status from an approval handler, and the whole point of `approvals` is that a concession is
 * a fact about authority rather than a transition. The one thing it takes from the payment
 * schedule is a **pure function** (`cashflowConcessionMinor`), imported directly, because a
 * second implementation of the gated prefix is plan 7.13's ฿12,902 seam reopened.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────────
 *
 * In `AppModule.forRoot`, and imported by `OrdersModule`, which calls `gate` as the last
 * statement of a submit. Both were open for one round — the routes were 404 in the assembled
 * application and `gate` had zero callers anywhere, so every attack the red team wrote had to
 * import the module by hand. `tests/rbac/route-audit.test.ts` is the alarm for the first half
 * and `tests/quotes/submit-seam.pg.test.ts` for the second.
 *
 * `AuthorityService` is exported because the submit path has to call `gate` inside its own
 * transaction. `AuthorityRepository` is not: a second thing writing `approvals` would be a
 * second opinion about who decided what.
 */
@Module({
  controllers: [ApprovalsController, AuthorityController],
  providers: [AuthorityService, AuthorityRepository],
  exports: [AuthorityService],
})
export class AuthorityModule {}
