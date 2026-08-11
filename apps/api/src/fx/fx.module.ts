import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { FxHttp } from './fx-http';
import { FxRatesService } from './fx-rates.service';

/**
 * Exchange-rate ingestion — ingestion only, see `FxRatesService`'s header for what that
 * means and what it deliberately does not do.
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
 * Nothing is exported. Nothing outside this module has a reason to read `fx_rates` yet —
 * exporting `FxRatesService` before a consumer exists would be building a surface for a
 * caller that does not exist, which `reviews.module.ts` already names as the mistake to
 * avoid.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [{ provide: FxHttp, useFactory: () => new FxHttp() }, FxRatesService],
})
export class FxModule {}
