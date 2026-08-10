import { Injectable } from '@nestjs/common';

// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq, sql } from '@wewin/db/sql';
import { taxCountries, taxCountryChanges } from '@wewin/db/schema';
import type {
  SettingChangeWire,
  TaxCountryCreateRequest,
  TaxCountryPatchRequest,
  TaxCountryWire,
} from '@wewin/contract/tax';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { withTranslatedOrganisationErrors } from './pg-errors';
import { TaxCountryRepository } from './tax-country.repository';

/**
 * The fields the history records. Ordering and timestamps are not changes worth keeping.
 *
 * ⚠️ `updatedByUserId` is deliberately not here, for the same reason `organisation.service.ts`
 * leaves it out of `bankAccounts`' own `RECORDED`: erasure scrubs that column to `NULL`
 * directly, outside this service, and with no history row — there is nothing a history row
 * could have recorded that the erasure changes.
 */
const RECORDED = [
  'code',
  'nameTh',
  'rateBp',
  'treatment',
  'pricesIncludeTax',
  'isActive',
  'sortOrder',
] as const;

const snapshot = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(RECORDED.map((key) => [key, row[key] ?? null]));

/**
 * A row as `taxCountries` actually returns it — `treatment` is `text` + CHECK rather than a
 * `pgEnum` (see the schema's own note on why), so the cast below is the one place that
 * narrows it back to the four values the CHECK already guarantees.
 */
interface TaxCountryRow {
  readonly code: string;
  readonly nameTh: string;
  readonly rateBp: number;
  readonly treatment: string;
  readonly pricesIncludeTax: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly updatedAt: Date;
}

const wire = (row: TaxCountryRow): TaxCountryWire => ({
  code: row.code,
  nameTh: row.nameTh,
  rateBp: row.rateBp,
  treatment: row.treatment as TaxCountryWire['treatment'],
  pricesIncludeTax: row.pricesIncludeTax,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  updatedAt: row.updatedAt.toISOString(),
});

const encodeChange = (row: {
  readonly id: string;
  readonly changedAt: Date;
  readonly changedByUserId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): SettingChangeWire => ({
  id: row.id,
  changedAt: row.changedAt.toISOString(),
  changedByUserId: row.changedByUserId,
  before: row.before ?? null,
  after: row.after,
});

/**
 * The destinations the company sells to, and what tax each one attracts.
 *
 * ⚠️ **The essential rule, same as `OrganisationService`: a tax-country write and its history
 * row are one transaction.** `tax_country_changes_append_only` (migration 0029) stops a
 * history row being edited or deleted after the fact; nothing in the database stops one
 * being *skipped*. That half of the invariant is this file's job, and every write below is a
 * single `transaction()` call whose last statement is the `INSERT` into `taxCountryChanges`.
 *
 * `patch` and `create` return `TaxCountryWire` directly rather than a raw row for the
 * controller to encode — the one deliberate difference from `OrganisationService`, which
 * this brief's interface list states outright rather than leaving to convention.
 *
 * ⚠️ Both writes are also wrapped in `withTranslatedOrganisationErrors` — see `pg-errors.ts`.
 * A body that validates cleanly against Task 2's zod schemas can still trip
 * `tax_countries_rate_matches_treatment`, `tax_countries_name_says_something` or the primary
 * key, and without translation each of those would reach the caller as a raw
 * `DrizzleQueryError`: a 500 plus a production alert for something a client did on purpose.
 */
@Injectable()
export class TaxCountryService {
  constructor(private readonly repository: TaxCountryRepository) {}

  async list(activeOnly: boolean): Promise<TaxCountryWire[]> {
    const rows = await this.repository.list(undefined, { activeOnly });
    return rows.map(wire);
  }

  async create(body: TaxCountryCreateRequest, userId: string): Promise<TaxCountryWire> {
    return withTranslatedOrganisationErrors(() =>
      this.repository.transaction(async (tx) => {
        const [created] = await tx
          .insert(taxCountries)
          .values({ ...body, updatedByUserId: userId })
          .returning();

        /*
         * ⚠️ Same transaction as the write, not a follow-up — see the class comment. A history
         * row that can be skipped is a history somebody skips.
         *
         * `changedAt: clock_timestamp()`, not the column's own `defaultNow()` — see the note on
         * `patch`'s insert below for why the default is the wrong clock for this table.
         */
        await tx.insert(taxCountryChanges).values({
          taxCountryCode: created!.code,
          changedByUserId: userId,
          changedAt: sql`clock_timestamp()`,
          before: null,
          after: snapshot(created!),
        });

        return wire(created!);
      }),
    );
  }

  async patch(code: string, body: TaxCountryPatchRequest, userId: string): Promise<TaxCountryWire> {
    return withTranslatedOrganisationErrors(() =>
      this.repository.transaction(async (tx) => {
        /*
         * ⚠️ Locked, not a plain read. Two PATCHes on the same country can otherwise race under
         * READ COMMITTED: each reads the pre-image before the other's write commits, so both
         * compute a `before` off the same stale row and the resulting history chain no longer
         * has entry N's `before` equal to entry N−1's `after` — see `lockCountry`.
         */
        const [before] = await this.repository.lockCountry(code, tx);
        if (before === undefined) throw AppError.notFound(message('error.tax_country.missing'));

        const [after] = await tx
          .update(taxCountries)
          .set({ ...body, updatedByUserId: userId, updatedAt: new Date() })
          .where(eq(taxCountries.code, code))
          .returning();

        /*
         * ⚠️ `changedAt: clock_timestamp()`, not the column's `defaultNow()`. `now()` — what
         * `defaultNow()` calls — is `transaction_timestamp()`: fixed at BEGIN and frozen for the
         * whole transaction (confirmed by experiment: `select now()` before and after a
         * `pg_sleep` inside one transaction returns the identical instant). Two concurrent
         * `patch()` calls both open their transaction before either reaches `lockCountry`, so the
         * one `FOR UPDATE` blocks can easily have the *earlier* `now()` despite committing
         * *second* — which reorders `changes()` (sorted by `changedAt` ASC) relative to actual
         * commit order and breaks exactly the contiguity this table exists to prove. Verified by
         * mutation-testing the other direction: with the lock restored and this column left on
         * its default, the concurrency test in `tax-country.pg.test.ts` failed at a *rate* rather
         * than a fixed count — anywhere from 1 to 5 of 8 runs across separate sessions, which is
         * the expected shape for a race that depends on exactly how the two transactions happen
         * to interleave, not a number to pin. `clock_timestamp()` reads the real wall clock at the
         * moment this INSERT executes — after `lockCountry` has already waited out any earlier
         * holder of the row — so it reflects commit order instead of BEGIN order.
         *
         * ⚠️ `clock_timestamp()` alone orders nothing — it is a value, not a lock. What actually
         * guarantees entry N's `before` equals entry N−1's `after` is that this `INSERT` runs
         * inside the *same transaction* as `lockCountry`'s row lock, after that lock has already
         * forced any earlier writer to commit first. A `clock_timestamp()` read outside that
         * transaction, or a lock that let go before this statement, would let two inserts land in
         * an order the wall clock cannot fix after the fact.
         */
        await tx.insert(taxCountryChanges).values({
          taxCountryCode: code,
          changedByUserId: userId,
          changedAt: sql`clock_timestamp()`,
          before: snapshot(before),
          after: snapshot(after!),
        });

        return wire(after!);
      }),
    );
  }

  /**
   * Withdraws or restores a destination by flag — never a delete; `tax_countries_block_delete`
   * would refuse one anyway.
   *
   * ⚠️ Reuses `patch` with a cast, deliberately: a copy of `organisation.service.ts`'s
   * `setAvailability`, which reuses `patchAccount` for the identical reason. A withdrawal
   * writes its history row through the exact same path as any other change, rather than a
   * second path that would need its own history-writing discipline proven separately.
   * `taxCountryPatchSchema` has no `isActive` field — it is `z.strictObject`, so a client that
   * sends one is refused at the body pipe — which is what makes the cast safe: nothing
   * reachable from a request body can reach this method except through `setAvailability`
   * itself.
   */
  async setAvailability(code: string, isActive: boolean, userId: string): Promise<TaxCountryWire> {
    return this.patch(code, { isActive } as TaxCountryPatchRequest, userId);
  }

  /** Oldest first — `TaxCountryRepository.changes` already orders by `changedAt` ascending. */
  async changes(code: string): Promise<SettingChangeWire[]> {
    const rows = await this.repository.changes(code);
    return rows.map(encodeChange);
  }
}
