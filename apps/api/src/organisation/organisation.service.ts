import { Injectable } from '@nestjs/common';

// Through @wewin/db and not 'drizzle-orm' directly — see the note in packages/db/src/sql.ts.
import { eq } from '@wewin/db/sql';
import { bankAccountChanges, bankAccounts, organisationProfile } from '@wewin/db/schema';
import type {
  BankAccountCreateRequestWire,
  BankAccountPatchRequestWire,
  OrganisationProfilePutRequestWire,
} from '@wewin/contract/organisation';

import { AppError } from '../common/errors/app-error';
import { message } from '../i18n';
import { OrganisationRepository } from './organisation.repository';

/** The fields the history records. Ordering and timestamps are not changes worth keeping. */
const RECORDED = ['bankCode', 'accountNumber', 'accountName', 'promptpayId', 'isActive'] as const;

const snapshot = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(RECORDED.map((key) => [key, row[key] ?? null]));

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
        after: snapshot(created!),
      });

      return created!;
    });
  }

  async patchAccount(actorUserId: string, id: string, patch: BankAccountPatchRequestWire) {
    return this.repository.transaction(async (tx) => {
      const [before] = await this.repository.account(id, tx);
      if (before === undefined) throw AppError.notFound(message('error.organisation.account_missing'));

      const [after] = await tx
        .update(bankAccounts)
        .set({ ...patch, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(bankAccounts.id, id))
        .returning();

      await tx.insert(bankAccountChanges).values({
        bankAccountId: id,
        changedByUserId: actorUserId,
        before: snapshot(before),
        after: snapshot(after!),
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

  async putProfile(actorUserId: string, input: OrganisationProfilePutRequestWire) {
    const [updated] = await this.repository.transaction((tx) =>
      tx
        .update(organisationProfile)
        .set({ ...input, updatedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(organisationProfile.id, 1))
        .returning(),
    );

    return updated!;
  }
}
