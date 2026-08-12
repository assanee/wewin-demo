import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { and, count, desc, eq, gt, max, min } from '@wewin/db/sql';
import { fxRates, fxSyncFailures } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import { FX_MANUAL_SYNC_WINDOW_HOURS, type FxManualSyncUsage } from './manual-sync';

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
 * in an append-only table is a figure nobody can re-check. `source` is still left off, because
 * it changes no answer.
 *
 * ⚠️ `fetchedAt` **was** left off, on the same "changes no answer" reasoning and with the note
 * *"the ordering key, not an input"*. That was right while nothing measured age and wrong the
 * moment something did — not because age is measured on it (it is not; see `staleness.ts`) but
 * because it is half of the *diagnosis*. See the field's own note below.
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
 * What made a sync happen. Mirrors the `*_trigger_kind_known` CHECK on both tables (0041).
 *
 * `'startup'` is separate from `'scheduled'` because `onModuleInit` fetches only into an empty
 * table and a fleet restarting is not a fleet on a schedule; `'manual'` is separate from both
 * because it is the only one a person causes and the only one with a budget attached.
 */
export type FxSyncTriggerKind = 'scheduled' | 'startup' | 'manual';

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
  async recordFailure(
    stage: FxSyncStage,
    detail: string,
    /*
     * ⭐ Defaulted to `'scheduled'`, so the three existing call sites read exactly as they did
     * and the one new one has to say `'manual'` out loud. A required parameter would have been
     * the tidier signature and the worse one here: the failure path is the one a manual sync
     * shares with the cron, and the whole point of migration 0041 is that the two stop being
     * indistinguishable — which is a distinction worth making at the call site rather than
     * threading through a default nobody sees.
     */
    triggerKind: FxSyncTriggerKind = 'scheduled',
  ): Promise<void> {
    await this.db
      .insert(fxSyncFailures)
      .values({ stage, detail: detail.slice(0, 500), triggerKind });
  }

  /**
   * ⭐ How much of the manual sync's budget has been spent — counted from the rows themselves.
   *
   * ⚠️ **Both tables, and the failures are the half that matters.** A manual sync that failed
   * still spent a provider request: the quota is charged on the request, not on the answer. A
   * count over `fx_rates` alone would let somebody hold the button down through a provider
   * outage and burn the month's allowance while the guard watched a number that never moved —
   * which is the fastest way this quota can actually disappear, not a corner case.
   *
   * ⚠️ `lastAttemptAt` is deliberately **not** bounded by the window while the count is. The
   * count answers "how much is left", which is a question about the window; the minimum interval
   * answers "was the last press a moment ago", which is a question about the newest row and
   * nothing else. Bounding both the same way would have been symmetrical and wrong — an attempt
   * that has just aged out of the window is still the last one that happened.
   *
   * See `manual-sync.ts` for why this count lives in the database at all, where every other
   * limiter in this app keeps its own in memory.
   */
  async manualSyncUsage(now: Date): Promise<FxManualSyncUsage> {
    const since = new Date(now.getTime() - FX_MANUAL_SYNC_WINDOW_HOURS * 60 * 60 * 1000);

    const [stored, failed] = await Promise.all([
      this.db
        .select({
          attempts: count(),
          oldest: min(fxRates.fetchedAt),
          newest: max(fxRates.fetchedAt),
        })
        .from(fxRates)
        .where(and(eq(fxRates.triggerKind, 'manual'), gt(fxRates.fetchedAt, since))),
      this.db
        .select({
          attempts: count(),
          oldest: min(fxSyncFailures.attemptedAt),
          newest: max(fxSyncFailures.attemptedAt),
        })
        .from(fxSyncFailures)
        .where(
          and(eq(fxSyncFailures.triggerKind, 'manual'), gt(fxSyncFailures.attemptedAt, since)),
        ),
    ]);

    /*
     * ⚠️ `newest` here is the newest *inside the window*, where `FxManualSyncUsage.lastAttemptAt`
     * is documented as the newest at all. The two agree for every value the minimum interval can
     * act on: the window is 24 hours and the interval is a minute, so an attempt old enough to
     * have left the window is old enough that the interval has long since elapsed. Reading it
     * from the same bounded aggregate keeps this to two round trips instead of four, and the
     * only value it can lose is one that would have produced `nextAllowedAt: null` regardless.
     */
    const newest = latestOf(stored[0]?.newest, failed[0]?.newest);
    const oldest = earliestOf(stored[0]?.oldest, failed[0]?.oldest);

    return {
      attemptsInWindow: (stored[0]?.attempts ?? 0) + (failed[0]?.attempts ?? 0),
      lastAttemptAt: newest,
      oldestAttemptInWindowAt: oldest,
    };
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

/*
 * `min`/`max` over two tables, resolved in TypeScript rather than in a `UNION ALL`.
 *
 * The alternative is one hand-written `sql` fragment unioning both tables and aggregating over
 * the result, which is a real query and about as long. This stays inside the query builder — the
 * reason `packages/db/src/sql.ts` exists — and the two aggregates already run concurrently, so
 * the union would save a round trip this code does not spend.
 *
 * `null` and `undefined` both mean "no rows": drizzle's `max`/`min` answer `null` for an empty
 * aggregate, and the array itself can be empty. Both collapse to `undefined`, which is the
 * absence `FxManualSyncUsage` is typed with — the same choice `health` above makes for
 * `lastFailureAt`.
 */
const earliestOf = (left: Date | null | undefined, right: Date | null | undefined): Date | undefined =>
  pick(left, right, (a, b) => (a.getTime() <= b.getTime() ? a : b));

const latestOf = (left: Date | null | undefined, right: Date | null | undefined): Date | undefined =>
  pick(left, right, (a, b) => (a.getTime() >= b.getTime() ? a : b));

function pick(
  left: Date | null | undefined,
  right: Date | null | undefined,
  better: (a: Date, b: Date) => Date,
): Date | undefined {
  if (left === null || left === undefined) return right ?? undefined;
  if (right === null || right === undefined) return left;

  return better(left, right);
}
