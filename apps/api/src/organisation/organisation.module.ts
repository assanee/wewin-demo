import { Module, type Provider } from '@nestjs/common';

/*
 * ⚠️ The port file, never `../quotes/authority` — the barrel re-exports `AuthorityModule`, which
 * imports this module, and a CommonJS require cycle through it hands `@Module`'s decorator an
 * `undefined` class at evaluation time. `deposit-policy.port.ts` imports one *type* and nothing
 * else, so this specifier has no runtime edge.
 */
import { DEPOSIT_POLICY, type DepositPolicyPort } from '../quotes/authority/deposit-policy.port';
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
 *
 * ── `DEPOSIT_POLICY`, and why the *token* is exported and not the service ────────
 *
 * The company's deposit percentage governs two things that live nowhere near this module: the
 * payment schedule a submit plans, and the `cashflow` floor the approvals module measures
 * against. Both need to read one column; neither may be given the ability to *write* the
 * company's profile. So what leaves this module is the one-method read-only interface the
 * authority module declares — `OrganisationService` itself stays unexported, exactly as
 * `TaxCountryRepository` does and for the same reason: a caller holding the service could call
 * `putProfile`.
 */

/**
 * `OrganisationService` as `DepositPolicyPort`, checked at compile time.
 *
 * A `useExisting` provider would wire the same object with **no** type relationship between the
 * class and the interface — the token is a `symbol` and Nest checks nothing — so the day
 * `depositBp` is renamed the failure would be a runtime `is not a function` inside a submit
 * transaction. The `useFactory` return annotation is what turns that into a compile error.
 */
const depositPolicyProvider: Provider = {
  provide: DEPOSIT_POLICY,
  inject: [OrganisationService],
  useFactory: (organisation: OrganisationService): DepositPolicyPort => organisation,
};

@Module({
  controllers: [OrganisationController, DestinationsController],
  providers: [
    OrganisationService,
    OrganisationRepository,
    TaxCountryService,
    TaxCountryRepository,
    depositPolicyProvider,
  ],
  exports: [OrganisationRepository, TaxCountryService, DEPOSIT_POLICY],
})
export class OrganisationModule {}
