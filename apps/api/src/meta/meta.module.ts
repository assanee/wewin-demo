import { Module } from '@nestjs/common';

import { CatalogSourceService } from './catalog-source';
import { MetaController } from './meta.controller';

// No database provider here either: DatabaseModule is global and exports the Drizzle
// handle that CatalogSourceService injects.
@Module({
  controllers: [MetaController],
  providers: [CatalogSourceService],
})
export class MetaModule {}
