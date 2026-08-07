import { Module } from '@nestjs/common';

import { OverviewController } from './overview.controller';
import { OverviewRepository } from './overview.repository';
import { OverviewService } from './overview.service';

/**
 * The overview.
 *
 * A plain `@Module` rather than a `forRoot(...)`: it needs no configuration and no shared
 * instance of anything — only `DRIZZLE`, which `DatabaseModule` provides globally. Every
 * other module in this application that takes options does so because a second instance
 * would be a second session key or a second throttle; there is nothing here to duplicate.
 *
 * ⚠️ Importing this in `AppModule` is what makes the route exist.
 * `controller-reachability.test.ts` scans `src/` for `@Controller` classes and asserts the
 * booted application serves every one, because phase 7 shipped two modules that were built,
 * tested and never mounted — the screen 404s and no unit test notices.
 */
@Module({
  controllers: [OverviewController],
  providers: [OverviewService, OverviewRepository],
})
export class OverviewModule {}
