import { Module } from '@nestjs/common';

import { OrganisationController } from './organisation.controller';
import { OrganisationRepository } from './organisation.repository';
import { OrganisationService } from './organisation.service';

/**
 * The company's own settings: its profile, and the bank accounts it is paid into.
 *
 * No `forRoot` — nothing here needs configuration. It imports nothing else, the same as
 * `AdminModule`: `DatabaseModule` is `@Global`, so `DRIZZLE` is already in scope, and
 * `RbacModule` binds its guard with `APP_GUARD` over the whole graph, so every route here is
 * enforced and boot-audited whether or not this module knows either of them exists.
 *
 * `OrganisationRepository` is exported for task 10: `OrdersModule` reads `activeAccounts()`
 * through it rather than opening a second query over `bank_accounts`, the same reason
 * `CatalogModule` exports its repository for `orders` and `quotes` to share.
 */
@Module({
  controllers: [OrganisationController],
  providers: [OrganisationService, OrganisationRepository],
  exports: [OrganisationRepository],
})
export class OrganisationModule {}
