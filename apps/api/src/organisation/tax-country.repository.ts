import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { asc, eq } from '@wewin/db/sql';
import { taxCountries, taxCountryChanges } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Drizzle names the transaction type nowhere public, so it is read off the callback exactly
 * as `organisation.repository.ts` does — there is no shared `Transaction` export to import
 * instead.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Every statement the tax-country surface runs.
 *
 * Same split as `OrganisationRepository`: `list()` and `changes()` take an *optional*
 * transaction — `executor()` falls back to the pooled handle — because a plain admin GET
 * never opens one, while every write in `TaxCountryService` reads the pre-image through
 * `lockCountry` from inside a transaction it already holds.
 */
@Injectable()
export class TaxCountryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  /** Every destination, sort order first. `activeOnly` is what a customer-facing read wants. */
  list(tx?: Tx, opts?: { activeOnly?: boolean }) {
    const runner = this.executor(tx);
    const query = runner.select().from(taxCountries);
    return opts?.activeOnly
      ? query
          .where(eq(taxCountries.isActive, true))
          .orderBy(asc(taxCountries.sortOrder), asc(taxCountries.code))
      : query.orderBy(asc(taxCountries.sortOrder), asc(taxCountries.code));
  }

  /**
   * The same row, locked, inside a transaction the caller opened.
   *
   * ⚠️ `.for('update')`, and the lock is the whole reason this method exists. An unlocked
   * pre-image read lets two concurrent PATCHes both see the old row, so the history chain
   * stops being contiguous — entry N's `before` no longer equals entry N−1's `after`. Same
   * reasoning as `OrganisationRepository.lockAccount` (`organisation.repository.ts:65-82`),
   * applied to this table instead of inventing a second one.
   */
  lockCountry(code: string, tx: Tx) {
    return tx.select().from(taxCountries).where(eq(taxCountries.code, code)).limit(1).for('update');
  }

  /** Oldest first — `TaxCountryService.changes` relies on that order rather than re-sorting. */
  changes(code: string, tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(taxCountryChanges)
      .where(eq(taxCountryChanges.taxCountryCode, code))
      .orderBy(asc(taxCountryChanges.changedAt));
  }
}
