import { Module } from '@nestjs/common';

import { DestinationsController } from './destinations.controller';
import { OrganisationController } from './organisation.controller';
import { OrganisationRepository } from './organisation.repository';
import { OrganisationService } from './organisation.service';
import { TaxCountryRepository } from './tax-country.repository';
import { TaxCountryService } from './tax-country.service';

/**
 * The company's own settings: its profile, the bank accounts it is paid into, and the
 * destinations it sells to and the tax each one attracts.
 *
 * No `forRoot` — nothing here needs configuration. It imports nothing else, the same as
 * `AdminModule`: `DatabaseModule` is `@Global`, so `DRIZZLE` is already in scope, and
 * `RbacModule` binds its guard with `APP_GUARD` over the whole graph, so every route here is
 * enforced and boot-audited whether or not this module knows either of them exists.
 *
 * `OrganisationRepository` is exported for task 10: `OrdersModule` reads `activeAccounts()`
 * through it rather than opening a second query over `bank_accounts`, the same reason
 * `CatalogModule` exports its repository for `orders` and `quotes` to share.
 *
 * `TaxCountryService` is exported for the same reason and by the same rule: `OrdersService`
 * resolves the destination inside the submit transaction, and `resolveDestination` is the one
 * place a destination code becomes a rate, a treatment and a basis. A second reader over
 * `tax_countries` in `orders` would be a second answer to "what does a withdrawn country
 * mean", which is exactly the question that file spends a page settling.
 *
 * `TaxCountryRepository` stays unexported. It is the statement layer under that decision, and
 * a caller holding it could run `byCode` and interpret the row itself — which is the thing the
 * export above exists to prevent.
 *
 * `DestinationsController` is registered here beside `OrganisationController` — two
 * controllers, one module — because a Nest controller absent from a module's `controllers`
 * array is never routed: leaving it off would make `GET /destinations` a silent 404, and
 * nothing else in this module would reveal that.
 */
@Module({
  controllers: [OrganisationController, DestinationsController],
  providers: [
    OrganisationService,
    OrganisationRepository,
    TaxCountryService,
    TaxCountryRepository,
  ],
  exports: [OrganisationRepository, TaxCountryService],
})
export class OrganisationModule {}
