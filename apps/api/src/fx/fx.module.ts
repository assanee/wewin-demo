import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { OrganisationModule } from '../organisation';
import { FxHttp } from './fx-http';
import { FxRatesRepository } from './fx-rates.repository';
import { FxRatesService } from './fx-rates.service';
import { QuotationRateService } from './quotation-rate.service';

/**
 * Exchange rates: ingestion, and — since this round — the one read that turns a stored
 * observation into the rate a quotation is priced at.
 *
 * `ScheduleModule.forRoot()` lives here because this is the first user of
 * `@nestjs/schedule` in the app (the repo had no scheduler at all before this); it is
 * `@Global` internally, so importing it once here is enough for `@Cron` on
 * `FxRatesService` to be picked up regardless of where else it might be imported later.
 *
 * `FxHttp` is provided by factory rather than by class, for the same reason
 * `auth/oauth/oauth.module.ts` gives `OAuthHttp` the same treatment: its constructor takes
 * a timeout in milliseconds, and Nest would otherwise try to resolve `Number` from the
 * container.
 *
 * ── ⭐ What is exported, and what is still not ────────────────────────────────────
 *
 * This used to export nothing, and said so: *"Nothing outside this module has a reason to read
 * `fx_rates` yet — exporting `FxRatesService` before a consumer exists would be building a
 * surface for a caller that does not exist"*. The consumer now exists — `OrdersService.submit`
 * resolves a rate inside its own transaction — so exactly one thing leaves, and it is not the
 * one that used to be named.
 *
 * `QuotationRateService` is exported. `FxRatesService` and `FxRatesRepository` are not, and the
 * split is the same rule `OrganisationModule` applies to `TaxCountryService` against
 * `TaxCountryRepository`: what leaves is the *decision* — the cache rule, the manual-override
 * short-circuit, and the refusal when there is no usable rate — never the statement layer under
 * it. A caller holding `FxRatesRepository` could read the newest row and interpret it itself,
 * which is a second answer to "which observation counts as the rate for this quotation", and
 * that question is exactly what the exported service exists to answer once.
 *
 * `FxRatesService` stays unexported for the older and blunter reason: it is the only thing that
 * can reach `FxHttp`, and a caller able to trigger a provider fetch from inside a transaction
 * holding a row lock is the failure `QuotationRateService`'s header spends a paragraph ruling
 * out.
 *
 * `OrganisationModule` is imported for `TaxCountryService`, which is where the destination's
 * three `fx_*` settings come from. No cycle: `OrganisationModule` has no `imports` of its own,
 * and nothing in it knows this module exists.
 */
@Module({
  imports: [ScheduleModule.forRoot(), OrganisationModule],
  providers: [
    { provide: FxHttp, useFactory: () => new FxHttp() },
    FxRatesService,
    FxRatesRepository,
    QuotationRateService,
  ],
  exports: [QuotationRateService],
})
export class FxModule {}
