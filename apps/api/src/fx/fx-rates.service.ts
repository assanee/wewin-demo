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
 * ── Daily, and why that number and not a smaller one ──────────────────────────────
 *
 * The free Open Exchange Rates plan allows 1,000 requests a month. Daily is ~30 of those —
 * roughly 970 spare every month, which is the point: a failed fetch (see "Failure
 * handling" below) can be retried on the next tick, or by hand, without quota anxiety.
 * Hourly used to be ~730 a month, which fit too, but left no such room.
 *
 * The stronger reason is on the consuming side, not the provider's. Nothing reads
 * `fx_rates` yet, but what will read it is a quotation the staff confirm — see the header
 * on `fx_rates` (`packages/db/src/schema/fx.ts`) — and a confirmed quotation is a document
 * whose life is measured in days, not minutes. Hourly freshness bought nothing for a rate
 * that gets pinned once and then sits for days; it only spent quota re-observing a number
 * that, per the free plan's own hourly update cadence, usually had not even changed.
 *
 * `CronExpression.EVERY_DAY_AT_1AM` — 01:00 server time — is a choice, not a discovery:
 * Open Exchange Rates' free plan updates hourly and USD trades in a market that is
 * effectively continuous, so no moment in the day is "the" correct one to read it at. This
 * repo sets `TZ` nowhere (`docker-compose.yml`, every `.env*`) and containers default to
 * UTC, so 01:00 here is 08:00 in Bangkok — `overview/business-month.ts`'s
 * `BUSINESS_TIME_ZONE`, and where the staff who confirm quotations actually work — which
 * puts the fetch just ahead of the working day rather than in the middle of it, so the
 * rate on hand when staff arrive is at most a few hours old rather than one fetched
 * mid-afternoon the day before. Do not tighten the schedule below without re-reading the
 * quota and staleness reasoning above; they are why the number is what it is, not a
 * preference that happened to land here.
 *
 * ── Startup fetch ─────────────────────────────────────────────────────────────────
 *
 * `onModuleInit` fetches once, but only when `fx_rates` is still empty, so a fresh
 * environment is not blank for the first day rather than because startup fetching is
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
 * **The database calls get the identical trade, on purpose.** `onModuleInit`'s "is the
 * table empty" read and `fetchAndStore`'s insert are both wrapped rather than left to
 * throw — the same reasoning `DatabaseService.probe` (`database/database.service.ts`)
 * already states for the connection itself: "an unreachable database is usually a
 * database that is still starting, and a service that exits on it turns a ten-second
 * outage into a crash loop." `OnModuleInit` is awaited by Nest, so an uncaught rejection
 * here would propagate out of `NestFactory.create()` and take the whole app down at boot
 * — over a table nothing reads. Wrapping the insert also matters for the daily tick:
 * unguarded, `@nestjs/schedule`'s own explorer would still catch it, but through a
 * generic `'Scheduler'` logger carrying the raw driver error, not through the deliberately
 * narrow logging the rest of this class uses. Both paths report through `this.logger`.
 *
 * ── The missing-key case ──────────────────────────────────────────────────────────
 *
 * `OPENEXCHANGERATES_APP_ID` is optional (`config/env.ts`): a developer without an OXR
 * account still has to be able to boot this app and run its suite. Its absence is logged
 * once, in the constructor, and never again — every scheduled tick and the startup check
 * both return immediately and silently, so a fleet running without the key produces one
 * boot-time line rather than a daily warning for the life of the process.
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
          'The app boots and the test suite runs regardless — set the key to start daily fetching.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.appId === undefined) return;

    let existing: { id: string }[];
    try {
      existing = await this.db.select({ id: fxRates.id }).from(fxRates).limit(1);
    } catch (error) {
      // See the class header: refusing to boot over this would turn a database that is
      // still starting into a crash loop, over a table nothing reads. The regular daily
      // tick still runs and will fill an empty table once the database is reachable.
      this.logger.warn(
        `could not check whether fx_rates is empty (${dbFailureReason(error)}); skipping the startup fetch`,
      );
      return;
    }
    if (existing.length > 0) return;

    this.logger.log(
      'fx_rates is empty; fetching once at startup so a fresh environment is not blank for a day.',
    );
    await this.fetchAndStore(this.appId);
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async fetchDaily(): Promise<void> {
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

    try {
      await this.db.insert(fxRates).values({
        rateTimestamp: new Date(parsed.value.timestamp * 1000),
        base: parsed.value.base,
        rates: parsed.value.rates,
        source: 'openexchangerates',
      });
    } catch (error) {
      this.logger.warn(`could not store the fetched rates (${dbFailureReason(error)}); will retry on the next tick`);
    }
  }
}

/**
 * A short, safe-to-log reason for a database failure — the SQLSTATE or driver errno if
 * one is available (drizzle wraps the driver's error one level down on `.cause`, the same
 * place `packages/db/tests/support/db.ts`'s `errorCode` walks for the identical reason),
 * the error's own name otherwise. Never the query text and never a value that was being
 * written — a DB failure here carries no `app_id` to begin with, but there is no reason to
 * start logging query parameters just because this path happens to be safe today.
 */
function dbFailureReason(error: unknown): string {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') return code;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return error instanceof Error ? error.name : 'unknown error';
}
