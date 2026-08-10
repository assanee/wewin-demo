import { Module, type DynamicModule } from '@nestjs/common';

import { OrganisationModule } from '../organisation';
import { CustomerLinkController, DocumentLinkController } from './document-link.controller';
import { DocumentLinkReader } from './document-link.reader';
import { DocumentLinkService, WEB_BASE_URL } from './document-link';
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
  static forRoot(auth: DynamicModule, webBaseUrl: string | undefined): DynamicModule {
    return {
      module: DocumentLinkModule,
      /*
       * ⭐ Fix round 1: `OrganisationModule` joins the list so `DocumentLinkReader` can put
       * `seller` on `LinkedDocumentWire`, and it is safe for a reason the `OrdersModule`
       * paragraph above does not cover — that one is about *this* module being wrapped in a
       * second `DynamicModule`, which is what doubled the routes. `OrganisationModule` is the
       * opposite shape: a plain `@Module({...})` with no `forRoot` of its own, already
       * imported by both `AppModule` and `OrdersModule` today with no ill effect, because Nest
       * deduplicates a static module by class reference — every importer shares the one
       * instance rather than causing another registration of `OrganisationController`'s own
       * routes. There is no cycle either: `OrganisationModule`'s own note says it imports
       * nothing, so nothing it exports can lead back here.
       */
      imports: [auth, OrderScopeModule, OrganisationModule],
      controllers: [DocumentLinkController, CustomerLinkController],
      providers: [
        DocumentLinkService,
        DocumentLinkReader,
        OrderRepository,
        /*
         * ⚠️ The same value the notification worker builds its links from, passed in rather
         * than read again. Two reads of one variable are one deployment mistake away from
         * two origins — and the customer emailed one and told the other over the telephone
         * would find that only one of them works.
         */
        { provide: WEB_BASE_URL, useValue: webBaseUrl },
      ],
    };
  }
}
