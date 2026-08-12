import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { desc } from '@wewin/db/sql';
import { fxRates } from '@wewin/db/schema';

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
}

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
      })
      .from(fxRates)
      .orderBy(desc(fxRates.fetchedAt))
      .limit(1);

    return row;
  }
}
