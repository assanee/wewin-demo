import { Module, type DynamicModule } from '@nestjs/common';

import { DocumentLinkController } from './document-link.controller';
import { DocumentLinkReader } from './document-link.reader';
import { DocumentLinkService } from './document-link';
import { OrderRepository } from './order.repository';
import { OrderScopeModule } from './scope';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The emailed quotation link: one route, one read, and no way to do anything else.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⭐ Why this is not part of `OrdersModule` ────────────────────────────────
 *
 * The first attempt gave `OrdersModule` a `forRoot`, so it could take the session graph for
 * the signing key. `RouteAuditError` refused to start the process, and it was right: a
 * `DynamicModule` whose `module` is `OrdersModule` is a *different* module to Nest than the
 * static `OrdersModule` other modules already import, so every order route was registered
 * twice and each one appeared to carry two access policies. The audit exists for exactly that
 * class of mistake and it found this one in its first run.
 *
 * The remedy turned out to be better than the thing it replaced. `document-link.ts` promises
 * the token is **read-only**; as a wing of `OrdersModule` that was a promise held up by a
 * comment, because `OrdersService` — every transition, every price, every cancellation — was
 * one constructor parameter away. Here it is not reachable at all. This module has
 * `ScopedOrderRepository` and `OrderRepository`, both of which can only read, and there is no
 * import that would let a later handler move an order with a link a customer forwarded.
 *
 * ⚠️ It provides its own `OrderRepository` rather than borrowing one. Two instances of a
 * stateless reader over the same `@Global` pool cost nothing, and the alternative — exporting
 * it from `OrdersModule` — would open that module's surface for the convenience of one route.
 */
@Module({})
export class DocumentLinkModule {
  /**
   * ⚠️ `auth` is the application's one session graph, passed in and never rebuilt.
   *
   * `DocumentLinkService` derives its signing key from `SESSION_CONFIG`. A second
   * `SessionModule.forRoot(...)` derives a *different* key, so a link the notification worker
   * minted would be refused by this route — in the same process, with nothing in either log
   * to explain it. `auth.module.ts` makes the argument at length.
   */
  static forRoot(auth: DynamicModule): DynamicModule {
    return {
      module: DocumentLinkModule,
      imports: [auth, OrderScopeModule],
      controllers: [DocumentLinkController],
      providers: [DocumentLinkService, DocumentLinkReader, OrderRepository],
    };
  }
}
