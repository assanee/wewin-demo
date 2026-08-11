import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { asc, desc, eq } from '@wewin/db/sql';
import {
  bankAccountChanges,
  bankAccounts,
  organisationProfile,
  organisationProfileChanges,
} from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';

/**
 * Drizzle names the transaction type nowhere public, so it is read off the callback exactly
 * as `draft.repository.ts` and `slips.repository.ts` do — there is no shared `Transaction`
 * export to import instead.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Every statement the organisation surface runs.
 *
 * Read methods take an *optional* transaction — `executor()` falls back to the pooled
 * handle — because the two admin GETs (`profile`, `bank-accounts`) never open one, while
 * every write in `OrganisationService` reads through the same methods from inside a
 * transaction it already holds. `slips.repository.ts` is the exemplar for this split.
 */
@Injectable()
export class OrganisationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  private executor(tx?: Tx): Tx {
    return tx ?? (this.db as unknown as Tx);
  }

  profile(tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(organisationProfile)
      .where(eq(organisationProfile.id, 1))
      .limit(1);
  }

  /** Every account, sort order first. Admin only — a customer-facing read filters to active. */
  allAccounts(tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(bankAccounts)
      .orderBy(asc(bankAccounts.sortOrder), asc(bankAccounts.createdAt));
  }

  /** What Task 10's customer-facing route reads: the same table, filtered to what is live. */
  activeAccounts(tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.isActive, true))
      .orderBy(asc(bankAccounts.sortOrder), asc(bankAccounts.createdAt));
  }

  account(id: string, tx?: Tx) {
    return this.executor(tx).select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
  }

  /**
   * The same row, locked, inside a transaction the caller opened.
   *
   * ⚠️ `FOR UPDATE` orders two concurrent `PATCH`es on the same account — the same reason
   * `slips.repository.ts:186` gives for `lockSlip`. Without it, READ COMMITTED (this
   * codebase never overrides the Postgres default) lets a plain `SELECT` return a pre-image
   * that predates another transaction's still-uncommitted write, so two overlapping patches
   * can each record a `before` that was already stale the moment it was read. On every other
   * table here that would be an ordinary lost-update race; on this one it breaks the
   * property `bank_account_changes` exists to hold — entry N's `before` equal to entry
   * N−1's `after` (`0027_organisation.sql:47-49`) — so the chain itself, not just the row,
   * would be wrong. `patchAccount` takes this lock before reading the pre-image for exactly
   * that reason; a plain `account()` read here would be the one write in this module with
   * no lock behind it.
   */
  lockAccount(id: string, tx: Tx) {
    return tx.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1).for('update');
  }

  changes(accountId: string, tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(bankAccountChanges)
      .where(eq(bankAccountChanges.bankAccountId, accountId))
      .orderBy(desc(bankAccountChanges.changedAt));
  }

  /**
   * The one-row profile, locked, inside a transaction the caller opened.
   *
   * ⚠️ Same reason as `lockAccount` just above: an unlocked pre-image lets two concurrent
   * `PUT`s on the profile each read the same stale row before the other's write commits, so
   * the history chain `organisation_profile_changes` exists to hold — entry N's `before`
   * equal to entry N−1's `after` — stops being contiguous. `putProfile` takes this lock
   * before reading the pre-image for exactly that reason; an unlocked `profile()` read is the
   * one write in this module `lockAccount` warns about, applied to the singleton row instead
   * of a bank account.
   */
  lockProfile(tx: Tx) {
    return tx
      .select()
      .from(organisationProfile)
      .where(eq(organisationProfile.id, 1))
      .limit(1)
      .for('update');
  }

  /** Oldest first — matches `TaxCountryRepository.changes`, so both history readers behave alike. */
  profileChanges(tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(organisationProfileChanges)
      .orderBy(asc(organisationProfileChanges.changedAt));
  }
}
