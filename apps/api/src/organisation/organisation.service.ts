import { Injectable } from '@nestjs/common';

// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq, sql } from '@wewin/db/sql';
import {
  bankAccountChanges,
  bankAccounts,
  organisationProfile,
  organisationProfileChanges,
} from '@wewin/db/schema';
import type {
  BankAccountCreateRequestWire,
  BankAccountPatchRequestWire,
  OrganisationProfilePutRequestWire,
} from '@wewin/contract/organisation';
import type { SettingChangeWire } from '@wewin/contract/tax';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { OrganisationRepository, type Tx } from './organisation.repository';

/**
 * The fields the history records for a bank account. Ordering and timestamps are not changes
 * worth keeping.
 *
 * ⚠️ `updatedByUserId` is deliberately not here. `erase_user()` (migration 0028,
 * `0028_erase_organisation_actors.sql:182`) writes `bank_accounts.updated_by_user_id`
 * directly to `NULL` when the staff member it names is erased — outside this service,
 * inside a stored procedure, and with no history row. That is correct rather than a gap:
 * the column an erasure scrubs is exactly the one column `ACCOUNT_RECORDED` never captured,
 * so there is nothing a history row could have recorded that the erasure changes.
 */
const ACCOUNT_RECORDED = ['bankCode', 'accountNumber', 'accountName', 'promptpayId', 'isActive'] as const;

const snapshotAccount = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(ACCOUNT_RECORDED.map((key) => [key, row[key] ?? null]));

/**
 * The fields the history records for the company profile — every business field the letterhead
 * carries, `depositBp` included (D4 put it here). Same exclusion of `updatedByUserId` as
 * `ACCOUNT_RECORDED`, for the same reason: erasure scrubs that column directly and outside this
 * service, so there is nothing a history row could have recorded that the erasure changes.
 */
const PROFILE_RECORDED = [
  'legalNameTh',
  'legalNameEn',
  'addressTh',
  'addressEn',
  'taxId',
  'phone',
  'email',
  'depositBp',
] as const;

const snapshotProfile = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(PROFILE_RECORDED.map((key) => [key, row[key] ?? null]));

/** `organisationProfileChanges` mapped to the one shape both change logs share — see Task 2's `SettingChangeWire`. */
const encodeProfileChange = (row: {
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
 * The company's own profile and the bank accounts it is paid into.
 *
 * ⚠️ **The essential rule: a bank-account write and its history row are one transaction.**
 * `bank_account_changes_append_only` (migration 0027) stops a history row being edited or
 * deleted after the fact; nothing in the database stops one being *skipped*. That half of
 * the invariant is this file's job, and every write below is a single `transaction()` call
 * whose last statement is the `INSERT` into `bankAccountChanges` — never a follow-up query
 * issued after the account write has already committed.
 */
@Injectable()
export class OrganisationService {
  constructor(private readonly repository: OrganisationRepository) {}

  async createAccount(actorUserId: string, input: BankAccountCreateRequestWire) {
    return this.repository.transaction(async (tx) => {
      const [created] = await tx
        .insert(bankAccounts)
        .values({ ...input, updatedByUserId: actorUserId })
        .returning();

      /*
       * ⚠️ Same transaction as the write, not a follow-up.
       *
       * A history row that can be skipped is a history somebody skips. The append-only
       * trigger stops it being edited afterwards; this is what stops it never existing.
       */
      await tx.insert(bankAccountChanges).values({
        bankAccountId: created!.id,
        changedByUserId: actorUserId,
        before: null,
        after: snapshotAccount(created!),
      });

      return created!;
    });
  }

  async patchAccount(actorUserId: string, id: string, patch: BankAccountPatchRequestWire) {
    return this.repository.transaction(async (tx) => {
      /*
       * ⚠️ Locked, not a plain read. Two `PATCH`es on the same account can otherwise race
       * under READ COMMITTED: each reads the pre-image before the other's write commits, so
       * both compute a `before` off the same stale row and the resulting history chain no
       * longer has entry N's `before` equal to entry N−1's `after` — see `lockAccount`.
       */
      const [before] = await this.repository.lockAccount(id, tx);
      if (before === undefined) throw AppError.notFound(message('error.organisation.account_missing'));

      const [after] = await tx
        .update(bankAccounts)
        .set({ ...patch, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(bankAccounts.id, id))
        .returning();

      await tx.insert(bankAccountChanges).values({
        bankAccountId: id,
        changedByUserId: actorUserId,
        before: snapshotAccount(before),
        after: snapshotAccount(after!),
      });

      return after!;
    });
  }

  /**
   * Turn an account on or off.
   *
   * ⚠️ Reuses `patchAccount` with a cast, deliberately: a deactivation writes its history
   * row through the exact same path as any other change, rather than a second path that
   * would need its own history-writing discipline proven separately. `bankAccountPatchSchema`
   * has no `isActive` field — it is `z.strictObject`, so a client that sends one is refused
   * at the body pipe — which is what makes the cast safe: nothing reachable from a request
   * body can reach this method except through `setAvailability` itself.
   */
  async setAvailability(actorUserId: string, id: string, isActive: boolean) {
    return this.patchAccount(actorUserId, id, { isActive } as BankAccountPatchRequestWire);
  }

  /**
   * ⚠️ **Locked-pre-image-plus-history, same discipline as `patchAccount`.** D4 put
   * `depositBp` on this row — the line that decides what counts as a concession — so this
   * stopped being allowed to be a bare `UPDATE` with no trace. Every write below is a single
   * transaction whose last statement is the `INSERT` into `organisationProfileChanges`, and
   * the pre-image is read through `lockProfile`'s `FOR UPDATE`, not a plain `SELECT`: two
   * concurrent `PUT`s on this singleton row can otherwise both read the same stale pre-image
   * before the other's write commits, breaking the property the history table exists to hold
   * — entry N's `before` equal to entry N−1's `after`.
   */
  async putProfile(actorUserId: string, input: OrganisationProfilePutRequestWire) {
    return this.repository.transaction(async (tx) => {
      const [before] = await this.repository.lockProfile(tx);
      if (before === undefined) throw AppError.notFound(message('error.organisation.profile_missing'));

      const [after] = await tx
        .update(organisationProfile)
        .set({ ...input, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(organisationProfile.id, 1))
        .returning();

      /*
       * ⚠️ `changedAt: clock_timestamp()`, not the column's own `defaultNow()`.
       *
       * `now()` — what `defaultNow()` calls — is `transaction_timestamp()`: fixed at BEGIN and
       * frozen for the whole transaction. Two concurrent `putProfile` calls both open their
       * transaction before either reaches `lockProfile`, so the one `FOR UPDATE` blocks can
       * still carry the *earlier* `now()` despite committing *second* — which would reorder
       * `profileChanges()` (sorted by `changedAt` ASC) relative to actual commit order and break
       * exactly the contiguity this table exists to prove. See `tax-country.service.ts`'s
       * `patch()` for the full account, including the experiment that confirmed `now()` freezes
       * at BEGIN. `clock_timestamp()` reads the real wall clock at the moment this `INSERT`
       * executes — after `lockProfile` has already waited out any earlier holder of the row —
       * so it reflects commit order instead of BEGIN order.
       *
       * ⚠️ `clock_timestamp()` alone orders nothing — it is a value, not a lock. What actually
       * guarantees entry N's `before` equals entry N−1's `after` is that this `INSERT` runs
       * inside the *same transaction* as `lockProfile`'s row lock, after that lock has already
       * forced any earlier writer to commit first.
       */
      await tx.insert(organisationProfileChanges).values({
        changedByUserId: actorUserId,
        changedAt: sql`clock_timestamp()`,
        before: snapshotProfile(before),
        after: snapshotProfile(after!),
      });

      return after!;
    });
  }

  /**
   * The company's deposit percentage — `DepositPolicyPort`, and the only reader of that column.
   *
   * ⚠️ **One definition, two consumers, and they must not be allowed to disagree.** The submit
   * plans the payment schedule from this number (`PaymentLifecycleService.pinsForSubmit`) and the
   * approvals module measures the `cashflow` floor against it (`AuthorityService.measureFor`).
   * A schedule that gates 30% judged against a floor of 100% is a 70% concession, fail-closed
   * refuses an approval it cannot grant, and the whole submit rolls back — so a second reader of
   * this column, with its own opinion about a missing row or its own default, would be plan
   * 7.13's ฿12,902 seam in a new column. Both consumers arrive at this method.
   *
   * ⚠️ **One method is not one read, and the first version of this note said "both consumers
   * arrive here" in a way that implied it was.** A submit calls this twice — once for the
   * schedule, once inside `gate` — and this is a plain unlocked `SELECT` at READ COMMITTED, where
   * each statement takes its own snapshot. A `putProfile` committing between the two is seen by
   * the second and not the first. The window, its one harmful direction, and why a `FOR SHARE`
   * was written and then rejected are set out at the call site in `orders.service.ts`; what
   * belongs here is only that this method does **not** promise the two reads agree.
   *
   * A missing profile row throws rather than defaulting to payment in full. It is the singleton
   * `id = 1` seeded by migration `0029`, so its absence is not a configuration state — and a
   * silent 10 000 bp would be a submit that quietly ignores the company's policy.
   */
  async depositBp(tx?: Tx): Promise<number> {
    const [row] = await this.repository.profile(tx);
    if (row === undefined) throw AppError.notFound(message('error.organisation.profile_missing'));
    return row.depositBp;
  }

  /** Oldest first — matches `TaxCountryService.changes`/`TaxCountryRepository.changes`, so both history readers behave alike. */
  async profileChanges(): Promise<SettingChangeWire[]> {
    const rows = await this.repository.profileChanges();
    return rows.map(encodeProfileChange);
  }
}
