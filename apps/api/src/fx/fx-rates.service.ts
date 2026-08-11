import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Database } from '@wewin/db/client';
import { fxRates } from '@wewin/db/schema';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DRIZZLE } from '../database/database.tokens';
import { FxHttp, FxHttpError } from './fx-http';
import { parseLatestRates } from './latest-rates';

/**
 * Ingests Open Exchange Rates' `latest.json` into `fx_rates` — and does nothing else.
 *
 * **Ingestion only.** Nothing here converts money. THB→SGD, or any other pair, needs
 * business decisions nobody has made yet (which pair, which rounding, which moment counts
 * as "the" rate for a quotation) — see the header on `fx_rates`
 * (`packages/db/src/schema/fx.ts`) for why the whole response is stored rather than a
 * computed figure. This service's entire job is bringing the provider's numbers in
 * honestly, with both timestamps attached, and leaving them for whoever makes that
 * decision to read back.
 *
 * ── Hourly, and why that number and not a smaller one ────────────────────────────
 *
 * The free Open Exchange Rates plan allows 1,000 requests a month. Hourly is ~730 requests
 * and fits with room to spare; every thirty minutes is ~1,460 and runs out mid-month. The
 * free plan also only *updates* its rates hourly, so polling faster would spend quota
 * re-fetching numbers that have not changed — it would not make the data any fresher. Do
 * not tighten `CronExpression.EVERY_HOUR` below without re-reading both of those facts;
 * they are the reason for the number, not a preference that happened to land here.
 *
 * ── Startup fetch ─────────────────────────────────────────────────────────────────
 *
 * `onModuleInit` fetches once, but only when `fx_rates` is still empty, so a fresh
 * environment is not blank for the first hour rather than because startup fetching is
 * generally safe to repeat — it is not what runs on every restart.
 *
 * ── Failure handling ──────────────────────────────────────────────────────────────
 *
 * A failed fetch is logged and left for the next tick — no retry loop, no crash. Nothing
 * downstream reads `fx_rates` yet, so a failed fetch is not an outage, and spending the
 * app's availability on a table nobody consumes would be the wrong trade. `FxHttp` never
 * hands this class a URL or a response body to log (see that file), so what gets logged
 * here is a status code at most — never anything that could carry `app_id`.
 *
 * ── The missing-key case ──────────────────────────────────────────────────────────
 *
 * `OPENEXCHANGERATES_APP_ID` is optional (`config/env.ts`): a developer without an OXR
 * account still has to be able to boot this app and run its suite. Its absence is logged
 * once, in the constructor, and never again — every scheduled tick and the startup check
 * both return immediately and silently, so a fleet running without the key produces one
 * boot-time line rather than an hourly warning for the life of the process.
 */
@Injectable()
export class FxRatesService implements OnModuleInit {
  private readonly logger = new Logger(FxRatesService.name);
  private readonly appId: string | undefined;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly http: FxHttp,
  ) {
    this.appId = env.OPENEXCHANGERATES_APP_ID;
    if (this.appId === undefined) {
      this.logger.warn(
        'OPENEXCHANGERATES_APP_ID is not set; exchange-rate ingestion is disabled. ' +
          'The app boots and the test suite runs regardless — set the key to start hourly fetching.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.appId === undefined) return;

    const existing = await this.db.select({ id: fxRates.id }).from(fxRates).limit(1);
    if (existing.length > 0) return;

    this.logger.log(
      'fx_rates is empty; fetching once at startup so a fresh environment is not blank for an hour.',
    );
    await this.fetchAndStore(this.appId);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async fetchHourly(): Promise<void> {
    if (this.appId === undefined) return;
    await this.fetchAndStore(this.appId);
  }

  private async fetchAndStore(appId: string): Promise<void> {
    let body: unknown;
    try {
      body = await this.http.getLatest(appId);
    } catch (error) {
      const status = error instanceof FxHttpError ? error.status : undefined;
      this.logger.warn(
        `exchange-rate fetch failed${status === undefined ? '' : ` (status ${String(status)})`}; will retry on the next tick`,
      );
      return;
    }

    const parsed = parseLatestRates(body);
    if (!parsed.ok) {
      this.logger.warn(`exchange-rate fetch returned a malformed body (${parsed.reason}); storing nothing`);
      return;
    }

    await this.db.insert(fxRates).values({
      rateTimestamp: new Date(parsed.value.timestamp * 1000),
      base: parsed.value.base,
      rates: parsed.value.rates,
      source: 'openexchangerates',
    });
  }
}
