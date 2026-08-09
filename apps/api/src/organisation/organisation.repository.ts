import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { asc, desc, eq } from '@wewin/db/sql';
import { bankAccountChanges, bankAccounts, organisationProfile } from '@wewin/db/schema';

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

  changes(accountId: string, tx?: Tx) {
    return this.executor(tx)
      .select()
      .from(bankAccountChanges)
      .where(eq(bankAccountChanges.bankAccountId, accountId))
      .orderBy(desc(bankAccountChanges.changedAt));
  }
}
