import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { count, desc, gt, max } from '@wewin/db/sql';
import { fxRates, fxSyncFailures } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Drizzle names the transaction type nowhere public, so it is read off the callback exactly
 * as `tax-country.repository.ts` and `order.repository.ts` do — there is no shared
 * `Transaction` export to import instead. Structurally identical to both, which is what lets
 * `OrdersService.submit` hand its own `tx` straight through.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * One stored observation, narrowed to what a conversion needs.
 *
 * `id` is not used by the arithmetic and is selected anyway: it is the only thing that names
 * *which* row a pinned figure came from, and a quotation that cannot be traced back to a row
 * in an append-only table is a figure nobody can re-check. `source` and `fetchedAt` are left
 * off because neither changes an answer — `fetchedAt` is the ordering key, not an input.
 */
export interface FxSnapshotRow {
  readonly id: string;
  readonly base: string;
  readonly rates: Record<string, number>;
  /** When the provider says the rates were struck — never "when we asked". */
  readonly rateTimestamp: Date;
  /**
   * When we asked. Selected now, having deliberately not been before: the header on this
   * interface used to say `fetchedAt` was "the ordering key, not an input", which was true
   * while nothing measured age. `FxStalenessService` and the health endpoint print both
   * clocks side by side precisely so a reader can see them disagree — a `fetched_at` minutes
   * old above a `rate_timestamp` three weeks old is the frozen-feed failure named in
   * `staleness.ts`, and it is only legible when both are on the screen.
   *
   * ⚠️ It is still not an input to any *arithmetic*. Nothing converts money with it and
   * `fxRateAgeHours` is never called on it — see `staleness.ts` for why age is measured on
   * `rateTimestamp` alone.
   */
  readonly fetchedAt: Date;
}

/**
 * What the organisation screen prints, and what decides whether staff get an email.
 *
 * `newest` is `undefined` for a database nobody has ever synced — a real state of a fresh
 * environment, and one that already refuses every foreign-currency submit. It is not folded
 * into a zero age, because "no observation" and "an observation from the epoch" are different
 * facts and a screen should say which.
 *
 * `consecutiveFailures` counts the failed attempts recorded *since* the newest stored rate, so
 * a retry that lands resets it to zero by arithmetic rather than by anybody remembering to
 * clear a counter. With `newest === undefined` it is every failure ever recorded, which is the
 * same sentence for a table that has never had a success in it.
 */
export interface FxSyncHealth {
  readonly newest: FxSnapshotRow | undefined;
  readonly consecutiveFailures: number;
  /** The newest failure's own moment, for a screen that wants to say when it last tried. */
  readonly lastFailureAt: Date | undefined;
}

/** How far a sync got before it gave up. Mirrors the `fx_sync_failures_stage_known` CHECK. */
export type FxSyncStage = 'fetch' | 'parse' | 'store';

/**
 * Reading `fx_rates`, which until now nothing did.
 *
 * ⚠️ **The most recent stored observation, and never a live fetch.** This is the owner's
 * cache rule stated as code: *"ดึงไม่ได้ทำยังไง = ให้ใช้ค่าเดิมที่ cache ไว้ในฐานข้อมูล"* — when
 * the daily sync fails, the newest row that did land is what a quotation converts with, with
 * no branch anywhere deciding whether today's fetch succeeded. `FxRatesService` is the only
 * writer and it already logs-and-shrugs on failure (see its header); this is the other half of
 * that trade, and the two together mean a provider outage costs freshness rather than
 * availability.
 *
 * It is also why there is no HTTP call on this path and must never be one. `forDestination`
 * runs inside `OrdersService.submit`'s transaction, which is holding a row lock on the order
 * by the time it is reached — a provider round-trip there would hold that lock for the length
 * of somebody else's network, and a provider that hangs would hold it for the length of a
 * timeout. `FxHttp` is reachable from `FxRatesService` and from nothing else, on purpose.
 *
 * `executor(tx)` is `TaxCountryRepository`'s idiom, copied rather than reinvented: a read that
 * belongs to a transaction the caller already holds runs on that connection, and a read that
 * belongs to nobody falls back to the pool.
 */
@Injectable()
export class FxRatesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  /**
   * The newest observation by `fetched_at`, or `undefined` when the table is still empty.
   *
   * `fetched_at` and not `rate_timestamp`, deliberately. They are different instants (the free
   * plan updates hourly, so most fetches land strictly after the rate they carry) and only one
   * of them is monotonic in *our* history: a provider that re-serves a stale `timestamp` after
   * an outage would sort an older observation above a newer one under `rate_timestamp`, which
   * is the opposite of what the cache rule above asks for. `fx_rates_fetched_at_idx` is
   * declared `on(fetched_at desc)` for exactly this statement.
   *
   * `undefined` rather than a throw: an empty table is a state a fresh environment is really
   * in, and what to do about it is the *caller's* decision — `QuotationRateService` refuses the
   * submit, and refuses it with a sentence about destinations rather than about a table.
   */
  async latest(tx?: Tx): Promise<FxSnapshotRow | undefined> {
    const [row] = await this.executor(tx)
      .select({
        id: fxRates.id,
        base: fxRates.base,
        rates: fxRates.rates,
        rateTimestamp: fxRates.rateTimestamp,
        fetchedAt: fxRates.fetchedAt,
      })
      .from(fxRates)
      .orderBy(desc(fxRates.fetchedAt))
      .limit(1);

    return row;
  }

  /**
   * ⭐ One failed attempt, recorded — the row that makes an outage countable.
   *
   * ⚠️ **Never on the submit path.** This is written by `FxRatesService` from its daily tick
   * and from nowhere else; `QuotationRateService` reads and refuses but records nothing,
   * because a submit that fails is not a sync that failed and counting it as one would make
   * the consecutive figure grow with sales traffic.
   *
   * `detail` is bounded rather than trusted: a provider that answers with a megabyte of HTML
   * must not turn a logging path into a row nobody can read. `FxRatesService` already narrows
   * everything it passes to a status code or a SQLSTATE — this is the second wall, not the
   * first.
   */
  async recordFailure(stage: FxSyncStage, detail: string): Promise<void> {
    await this.db.insert(fxSyncFailures).values({ stage, detail: detail.slice(0, 500) });
  }

  /**
   * ⭐ Both halves of "is the rate feed alright" in one round trip each.
   *
   * The failure count is bounded by the newest success rather than by a window of days, so it
   * answers the question staff actually ask — *"has it been failing since the last one landed?"*
   * — and answers it identically however long ago that was. A `WHERE attempted_at > now() - 7d`
   * version would report zero during exactly the outage that matters most, the one that started
   * eight days ago.
   *
   * ⚠️ No `tx` parameter, unlike `latest`. This never runs inside `OrdersService.submit`'s
   * transaction: it is read by a controller answering a screen and by a scheduled check, and
   * neither holds a row lock on an order. Giving it one would be building the argument
   * `QuotationRateService`'s header spends a paragraph refusing.
   */
  async health(): Promise<FxSyncHealth> {
    const newest = await this.latest();

    const since = newest === undefined ? undefined : gt(fxSyncFailures.attemptedAt, newest.fetchedAt);

    const [tally] = await this.db
      .select({ failures: count(), lastFailureAt: max(fxSyncFailures.attemptedAt) })
      .from(fxSyncFailures)
      .where(since);

    return {
      newest,
      consecutiveFailures: tally?.failures ?? 0,
      lastFailureAt: tally?.lastFailureAt ?? undefined,
    };
  }
}
