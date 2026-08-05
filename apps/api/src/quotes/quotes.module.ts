import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { OrderScopeModule } from '../orders/scope';
import { QuoteRepository } from './quote.repository';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/**
 * The sales-editable quote — phase 5c.
 *
 * It imports two things and exports one.
 *
 * `OrderScopeModule` provides `ScopedOrderRepository`, which is the only way anything here
 * loads an order. The dependency points one way on purpose (plan 7.4 trap 2): the row filter
 * stays reviewable on its own and cannot grow a reason to know about quotes.
 *
 * `CatalogModule`, for `CatalogRepository`. Not a convenience — pricing a quote line needs the
 * *published* document, and that module's note says why the read has to go through it rather
 * than through a second query over `product_versions`: the document a customer is quoted from
 * is the frozen one, its hash is verified on the way out, and a second reader would eventually
 * disagree with the first about which of those two things it was serving.
 *
 * It does **not** import `OrdersModule`. `OrdersService` drives the state machine and nothing
 * here has any business moving an order; what this module needs from that one is two pure
 * modules — `orders/defaults` for the VAT rule and `orders/scope` for the loader — and both are
 * imported directly rather than through the feature's barrel, which would drag the state
 * machine in behind them.
 *
 * `QuotesService` is exported for exactly one reason, and it is the seam below.
 *
 * ── Wiring ───────────────────────────────────────────────────────────────────────
 *
 * In `AppModule.forRoot`, and imported by `OrdersModule` — which is where `assertSubmittable`
 * and `adoptCart` are called, inside the transaction that pins. Both were open seams for one
 * round: every route here was a 404 in the assembled application, and submit priced the request
 * body rather than the quote, so the editor's output was consumed by nothing.
 */
@Module({
  imports: [CatalogModule, OrderScopeModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuoteRepository],
  exports: [QuotesService],
})
export class QuotesModule {}
