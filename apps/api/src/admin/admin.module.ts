import { Module } from '@nestjs/common';

import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { DraftRepository } from './draft.repository';
import { OptionCatalogController } from './option-catalog.controller';
import { OptionCatalogService } from './option-catalog.service';

/**
 * The write side of the catalogue.
 *
 * It imports nothing. `DatabaseModule` is `@Global`, so `DRIZZLE` is already in scope, and
 * `RbacModule` binds its guard with `APP_GUARD` over the whole graph — which means this
 * module is enforced and audited whether or not it knows either of them exists. That is the
 * property the boot audit is for: adding a controller here with a handler that states no
 * access does not produce an unguarded endpoint, it produces a process that will not start.
 *
 * Nothing is exported. The read path has its own repository over the same tables and does
 * not want this one; a second module reaching in here would be a second thing writing to
 * the normalised layer, and the invariant that a draft's document is always the compile of
 * its own rows only holds because exactly one thing writes it.
 */
@Module({
  controllers: [CatalogAdminController, OptionCatalogController],
  providers: [CatalogAdminService, OptionCatalogService, DraftRepository],
})
export class AdminModule {}
