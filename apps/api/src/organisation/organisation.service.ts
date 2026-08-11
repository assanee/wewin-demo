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
       * ⚠️ Same transaction as the write, not a follow-up — see the class comment. A history
       * row that can be skipped is a history somebody skips. The append-only trigger stops it
       * being edited afterwards; this is what stops it never existing.
       *
       * `changedAt: clock_timestamp()`, not the column's own `defaultNow()` — see the note on
       * `patchAccount`'s insert below for why the default is the wrong clock for this table.
       */
      await tx.insert(bankAccountChanges).values({
        bankAccountId: created!.id,
        changedByUserId: actorUserId,
        changedAt: sql`clock_timestamp()`,
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

      /*
       * ⚠️ `changedAt: clock_timestamp()`, not the column's own `defaultNow()`. `now()` — what
       * `defaultNow()` calls — is `transaction_timestamp()`: fixed at BEGIN and frozen for the
       * whole transaction (confirmed by experiment — see `tax-country.service.ts`'s `patch()`,
       * which ran `select now()` before and after a `pg_sleep` inside one transaction and got
       * the identical instant back both times). Two concurrent `patchAccount` calls both open
       * their transaction before either reaches `lockAccount`, so the one `FOR UPDATE` blocks
       * can easily have the *earlier* `now()` despite committing *second* — which reorders
       * `changes()` (`organisation.repository.ts`, sorted `changedAt` DESC) relative to actual
       * commit order and breaks exactly the contiguity `bank_account_changes` exists to prove.
       * `clock_timestamp()` reads the real wall clock at the moment this `INSERT` executes —
       * after `lockAccount` has already waited out any earlier holder of the row — so it
       * reflects commit order instead of BEGIN order.
       *
       * ⚠️ `clock_timestamp()` alone orders nothing — it is a value, not a lock. The guarantee
       * this restores: entry N+1's transaction cannot reach its own `clock_timestamp()` until
       * entry N's transaction has committed, because it is blocked on `lockAccount`'s row lock
       * until then. That only holds because this `INSERT` runs inside the *same* transaction as
       * the lock, as the last statement before commit — a `clock_timestamp()` read outside that
       * transaction, or a lock released before this statement, would let two inserts land in an
       * order the wall clock cannot fix after the fact. Verified by mutation-testing the other
       * direction: with the lock intact and this line reverted to the column default, the new
       * contiguity test in `organisation.pg.test.ts` ("bank-account history under concurrent
       * patches") failed at a *rate* rather than a fixed count — 7 of 20 runs in one measured
       * session — which is the expected shape for a race that depends on exactly how the two
       * transactions happen to interleave, not a number to pin.
       */
      await tx.insert(bankAccountChanges).values({
        bankAccountId: id,
        changedByUserId: actorUserId,
        changedAt: sql`clock_timestamp()`,
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
   * 7.13's ฿12,902 seam in a new column.
   *
   * ⚠️ **A submit calls this method once, not twice — and that was not always true.** This is a
   * plain unlocked `SELECT` at READ COMMITTED, where every statement takes its own snapshot, so
   * two live calls can disagree if a `putProfile` commits between them. That used to be exactly
   * what a submit did: `pinsForSubmit` called this to plan the schedule and
   * `AuthorityService.measureFor` called it again inside `gate` — each its own snapshot, and a
   * `putProfile` landing between the two was seen by the second call and not the first. Commit
   * `4a00bd0` closed that window without a lock: `applySubmission` pins this call's result onto
   * the order, in the same transaction, as `orders.deposit_floor_bp`, and `measureFor` now reads
   * `order.depositFloorBp ?? (await this.depositPolicy.depositBp(tx))` — so the pin short-circuits
   * the second live read entirely, for any order that has one. See `orders.service.ts` — *"One
   * definition is now also one read"* — for the full account of the window and why a `FOR SHARE`
   * was rejected as its remedy.
   *
   * That guarantee is only as old as the pin. Every order submitted before it existed carries
   * `deposit_floor_bp = null` forever — `0034_order_deposit_floor.sql` deliberately backfills
   * nothing, because no column says which orders predate the setting they'd be backfilled to —
   * so for those orders `measureFor`'s `??` still falls through to a live call here on every
   * measurement: `assess`, `request`, an objection's `gate`. Each of those remains its own
   * snapshot, unsynchronised with any other, exactly as this note used to describe for every
   * order. The window is closed only where a pin exists to read instead.
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
