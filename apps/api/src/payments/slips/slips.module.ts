import { Module, type DynamicModule } from '@nestjs/common';

import { OrganisationModule } from '../../organisation';
import { OrderRepository } from '../../orders/order.repository';
import { OrderScopeModule } from '../../orders/scope';
import { LedgerModule } from '../ledger';
import { SlipImagesController } from './slip-images.controller';
import { SlipImageStore } from './slip-storage';
import { parseSlipStorageConfig, type SlipStorageConfig } from './slip-storage.config';
import { SlipReviewController } from './slip-review.controller';
import { SlipsController } from './slips.controller';
import { SlipsRepository } from './slips.repository';
import { SlipsService } from './slips.service';
import { SLIP_STORAGE_CONFIG } from './slips.tokens';

export interface SlipsModuleOptions {
  /**
   * Omitted means this module parses `process.env` itself, exactly as `MediaModule` and
   * `OAuthModule` do.
   *
   * Tests that care about the bucket or about a stable signing key pass their own; the rest
   * get the local compose defaults and a per-process key. Nothing connects at construction
   * time, so a graph built with no object store running still boots.
   */
  readonly config?: SlipStorageConfig;
}

/**
 * Payment slips — phase 5b.
 *
 * ── What it imports, and the two things it does not ──────────────────────────────
 *
 * `OrderScopeModule`, for `ScopedOrderRepository`: every order this module touches is
 * loaded through it and through nothing else, which is plan 7.4 trap 2 answered
 * structurally. The dependency points one way on purpose — the row filter stays reviewable
 * on its own and never learns about payments.
 *
 * `OrderRepository` is **provided here rather than imported**, because `OrdersModule` does
 * not export it, and that is correct: its own note says a feature module reaching for
 * `OrdersService` would be a second thing driving the state machine. This module does not
 * reach for the service. It uses the three repository methods that file explicitly
 * designates as this phase's seam — *"5b writes its payment events through"* — and it is a
 * second instance of a stateless class over the same `@Global` `DRIZZLE` connection, which
 * is a wiring detail with no behaviour attached.
 *
 * `OrganisationModule`, task 13 fix round 1's addition: `createSlip` checks a customer's
 * `receivedBankAccountId` against `OrganisationRepository.account()` before it ever reaches
 * the insert — the same repository `OrdersModule` already imports it for, over `activeAccounts()`.
 *

 * It does **not** import `MediaModule`. That module exports nothing, deliberately, and the
 * one thing wanted from it is a class: `SlipImageStore` constructs its own `ObjectStorage`
 * pointed at a *different, private* bucket. Sharing a provider would be one `useValue` away
 * from sharing a bucket with the imagery that `GET /media/:id` serves to anybody.
 *
 * It does not import `NotificationsModule` and has no way to send anything. Notifications
 * are a consumer of `order_events` (plan 10.1); the acceptance that freezes an order
 * appends there and the outbox fans it out in the same transaction, with nothing for this
 * module to call and nothing for it to forget.
 *
 * ── ⚠️ Wiring ────────────────────────────────────────────────────────────────────
 *
 * **This module is imported.** `app.module.ts:21` names `SlipsModule` and `:150` lists
 * `SlipsModule.forRoot()` in `AppModule.forRoot`'s imports, so these routes exist in the
 * running process. `OrdersModule` carried a warning through the whole of 5a that this
 * module's routes did not exist yet, and that was true for most of it — which is how a
 * feature came to be tested against an application that did not serve it. It is not true
 * here any more.
 *
 * ⚠️ Naming it a *second* time in that list is now a failure, not a redundancy:
 * `SlipsModule.forRoot()` returns a fresh `DynamicModule` on every call, so Nest cannot
 * deduplicate the two by reference, and `RouteRegistryService.scan()`
 * (`src/rbac/route-registry.service.ts`) refuses to boot with *"shares one handler function
 * with … — an inherited handler cannot carry two access policies"* the moment it finds the
 * same controller reachable through both. `tests/payments/slips/support/slips-app.ts` used
 * to add `SlipsModule` by hand, for exactly the reason this note used to give — and now
 * boots nothing but `AppModule.forRoot(...)`, for exactly the reason this note now gives.
 */
@Module({})
export class SlipsModule {
  static forRoot(options: SlipsModuleOptions = {}): DynamicModule {
    return {
      module: SlipsModule,
      imports: [OrderScopeModule, LedgerModule, OrganisationModule],
      controllers: [SlipsController, SlipReviewController, SlipImagesController],
      providers: [
        {
          provide: SLIP_STORAGE_CONFIG,
          useValue: options.config ?? parseSlipStorageConfig(process.env),
        },
        SlipsService,
        SlipsRepository,
        SlipImageStore,
        OrderRepository,
      ],
    };
  }
}
