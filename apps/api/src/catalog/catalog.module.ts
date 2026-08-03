import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';

/**
 * No provider for the database here: `DatabaseModule` is global and exports the Drizzle
 * handle, so this module declares only what it owns. The repository is exported because
 * pricing and orders will read the same published documents in phase 3b onward, and they
 * must read them through this one path rather than opening a second one.
 */
@Module({
  controllers: [CatalogController],
  providers: [CatalogRepository],
  exports: [CatalogRepository],
})
export class CatalogModule {}
