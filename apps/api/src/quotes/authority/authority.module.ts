import { Module } from '@nestjs/common';

import { OrganisationModule } from '../../organisation';
import { ApprovalsController } from './approvals.controller';
import { AuthorityController } from './authority.controller';
import { AuthorityRepository } from './authority.repository';
import { AuthorityService } from './authority.service';

/**
 * Who may reduce what the customer pays — phase 5c.
 *
 * It imports one module, and it used to import none. `DatabaseModule` is `@Global`, and
 * `RbacModule` binds its guard with `APP_GUARD` over the whole graph, so this module is enforced
 * and audited whether or not it knows either exists: a handler added here without an access
 * policy stops the process from starting rather than producing an open endpoint.
 *
 * It deliberately does **not** import `OrdersModule` or `ScheduleModule`. This module reads
 * `orders`, `quote_lines`, `quote_overrides` and `order_instalments` and writes none of them —
 * a module that could reach `OrdersService` is a module that will eventually move an order's
 * status from an approval handler, and the whole point of `approvals` is that a concession is
 * a fact about authority rather than a transition. The one thing it takes from the payment
 * schedule is a **pure function** (`cashflowConcessionMinor`), imported directly, because a
 * second implementation of the gated prefix is plan 7.13's ฿12,902 seam reopened.
 *
 * ── The one import, and why it is not that rule being bent ───────────────────────
 *
 * `OrganisationModule`, for `DEPOSIT_POLICY` — the `cashflow` floor, which stopped being a
 * module constant when the owner answered plan 13's open question and became
 * `organisation_profile.deposit_bp`. What arrives is the interface *this* module declares
 * (`deposit-policy.port.ts`): one method, one number, no verbs, and no way to reach an order or
 * a schedule through it. The rule above is about not coupling to the Orders and Schedule
 * **domains**, and neither is on the other end of this edge; `OrganisationModule` is the
 * company's own settings, it imports nothing itself, and the edge runs one way.
 *
 * ⚠️ The direction matters and it is the opposite of the obvious one. `OrganisationModule`
 * imports the port *file* — never `./index.ts`, which re-exports this module — so the module
 * graph has exactly one edge between them and the CommonJS require graph has none.
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
  imports: [OrganisationModule],
  controllers: [ApprovalsController, AuthorityController],
  providers: [AuthorityService, AuthorityRepository],
  exports: [AuthorityService],
})
export class AuthorityModule {}
