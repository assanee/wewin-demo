import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, eq, sql } from '@wewin/db/sql';
import { mfaCredentials, mfaRecoveryCodes } from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import { AuditRepository } from '../../users/audit.repository';

/**
 * Everything the second factor reads and writes.
 *
 * ⚠️ Nothing here decrypts a secret or verifies a code. The repository hands back the sealed
 * envelope and the service opens it, so a query result cannot carry a plaintext secret
 * anywhere it might be logged, serialised or held in a variable that outlives the check.
 */

export interface MfaCredentialRow {
  readonly userId: string;
  /** Still sealed. `SecretBox` is the only thing that opens it, and only inside the service. */
  readonly secretSealed: string;
  /** Null while enrolling. Non-null is the only thing that means "the gate is up". */
  readonly confirmedAt: Date | null;
  readonly lastAcceptedStep: number | null;
}

export interface MfaState {
  readonly enabled: boolean;
  readonly enrolling: boolean;
  readonly unusedRecoveryCodes: number;
  readonly confirmedAt: Date | null;
}

@Injectable()
export class MfaRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  async findCredential(userId: string): Promise<MfaCredentialRow | undefined> {
    const [row] = await this.db
      .select({
        userId: mfaCredentials.userId,
        secretSealed: mfaCredentials.secretSealed,
        confirmedAt: mfaCredentials.confirmedAt,
        lastAcceptedStep: mfaCredentials.lastAcceptedStep,
      })
      .from(mfaCredentials)
      .where(eq(mfaCredentials.userId, userId))
      .limit(1);

    return row;
  }

  /** What the account screen shows, and what the sign-in path asks before issuing a session. */
  async state(userId: string): Promise<MfaState> {
    const [credential, unused] = await Promise.all([
      this.findCredential(userId),
      this.countUnusedRecoveryCodes(userId),
    ]);

    return {
      enabled: credential?.confirmedAt != null,
      /* A secret written and never proved. The gate is *not* up — see the schema comment. */
      enrolling: credential !== undefined && credential.confirmedAt === null,
      unusedRecoveryCodes: unused,
      confirmedAt: credential?.confirmedAt ?? null,
    };
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), sql`${mfaRecoveryCodes.usedAt} is null`));

    return row?.n ?? 0;
  }

  /**
   * Start again from scratch.
   *
   * An unconfirmed credential is replaced rather than added to: somebody who abandoned an
   * enrolment and came back should get a fresh QR code, not the one they failed to save.
   * `onConflictDoUpdate` and not delete-then-insert, so the row's identity survives for the
   * foreign keys and there is no window where it is absent.
   */
  async putUnconfirmedSecret(userId: string, secretSealed: string): Promise<void> {
    await this.db
      .insert(mfaCredentials)
      .values({ userId, secretSealed })
      .onConflictDoUpdate({
        target: mfaCredentials.userId,
        set: { secretSealed, confirmedAt: null, lastAcceptedStep: null, updatedAt: new Date() },
      });
  }

  /**
   * ⚠️ Raises the gate — and `mfa_credentials_guard_confirm` refuses this UPDATE unless two
   * unused recovery codes already exist. The service checks the same rule first so that a
   * person gets a sentence rather than a 500; the trigger is what makes it true regardless of
   * which code path arrives here.
   */
  async confirm(userId: string, step: number): Promise<void> {
    await this.db
      .update(mfaCredentials)
      .set({ confirmedAt: new Date(), lastAcceptedStep: step, updatedAt: new Date() })
      .where(eq(mfaCredentials.userId, userId));
  }

  /**
   * Move the replay marker forward.
   *
   * ⚠️ `and(eq(userId), lt(lastAcceptedStep, step))` — a compare-and-set, not a blind write.
   * Two requests presenting the same code at the same instant both pass `verifyTotp`; this
   * makes the second one affect zero rows, and the caller treats zero as "somebody else used
   * it first". `mfa_credentials_guard_step` refuses it as well, and the two are not
   * redundant: the guard raises, which is a 500, and this returns false, which is a refusal.
   */
  async advanceStep(userId: string, step: number): Promise<boolean> {
    const updated = await this.db
      .update(mfaCredentials)
      .set({ lastAcceptedStep: step, updatedAt: new Date() })
      .where(
        and(
          eq(mfaCredentials.userId, userId),
          sql`(${mfaCredentials.lastAcceptedStep} is null or ${mfaCredentials.lastAcceptedStep} < ${step})`,
        ),
      )
      .returning({ userId: mfaCredentials.userId });

    return updated.length === 1;
  }

  /** Replaces the unused set. Spent codes stay — the trigger refuses to delete them. */
  async replaceRecoveryCodes(userId: string, hashes: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, userId), sql`${mfaRecoveryCodes.usedAt} is null`));

      await tx.insert(mfaRecoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
    });
  }

  /**
   * Spend one, if it is there and unspent.
   *
   * ⭐ One indexed statement rather than read-then-write. `WHERE used_at IS NULL` inside the
   * UPDATE is what makes two simultaneous redemptions of the same code resolve to one — a
   * check in the service followed by a write would let both through.
   */
  async redeemRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const spent = await this.db
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          eq(mfaRecoveryCodes.codeHash, codeHash),
          sql`${mfaRecoveryCodes.usedAt} is null`,
        ),
      )
      .returning({ id: mfaRecoveryCodes.id });

    return spent.length === 1;
  }

  /**
   * Turn it off entirely, credential and all unused codes.
   *
   * Spent codes survive, because `mfa_recovery_codes_guard_write` refuses to delete them and
   * that refusal is correct: a spent code is the record that somebody recovered an account,
   * and disabling MFA is not a reason to lose it.
   */
  async disable(userId: string, audit?: { readonly actorUserId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(mfaCredentials).where(eq(mfaCredentials.userId, userId));
      await tx
        .delete(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, userId), sql`${mfaRecoveryCodes.usedAt} is null`));

      /*
       * ⚠️ Recorded only when an **administrator** did it, and `audit` is optional for that
       * reason rather than out of convenience.
       *
       * `admin_events` is the record of what staff did to *somebody else's* account. A
       * person turning off their own second factor — having re-proved their password — is
       * not an administrative act on another person, and a row saying "X disabled X's MFA"
       * would fill the trail with noise that hides the entries that matter.
       *
       * The self-service path is not unrecorded: `sessions` and the credential's own absence
       * are the evidence, and the person did it themselves.
       */
      if (audit !== undefined) {
        await this.auditRepository.record(tx, {
          action: 'user.mfa_disabled',
          actorUserId: audit.actorUserId,
          subjectUserId: userId,
        });
      }
    });
  }
}
