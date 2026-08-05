import { Module } from '@nestjs/common';

import { LedgerRepository } from './ledger.repository';
import { LedgerService } from './ledger.service';

/**
 * The two-legged ledger — phase 5b.
 *
 * No controller, and that is deliberate rather than unfinished. A ledger is not a resource
 * anybody POSTs to: every entry in this phase is a consequence of something else happening —
 * a slip accepted, an order cancelled, a refund transferred — and an HTTP route that wrote one
 * directly would be a way to move money with no event behind it. What money an order holds is
 * served by the modules that own the event, embedded in their own responses.
 *
 * Imports nothing (`DatabaseModule` is `@Global`) and exports both providers, because the two
 * consumers this round has — refunds, and the slip-review module being written beside it —
 * need `LedgerService` for the postings and `LedgerRepository` for the folds and for
 * `forfeitThbMinor`.
 *
 * ⚠️ Wiring: nothing here reaches the running process until a module that imports it is in
 * `AppModule.forRoot`'s list. `apps/api/src/app.module.ts` is not this agent's file; see the
 * note at the top of `refunds.module.ts`.
 */
@Module({
  providers: [LedgerService, LedgerRepository],
  exports: [LedgerService, LedgerRepository],
})
export class LedgerModule {}
