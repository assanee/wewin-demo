import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, eq, sql } from '@wewin/db/sql';
import { authTokens, passwordCredentials, userEmails, users } from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';

/** Who a reset would be for, and whether they may have one. */
export interface ResetTargetRow {
  readonly userId: string;
  readonly address: string;
  readonly displayName: string | null;
  readonly status: string;
}

export interface ResetTokenRow {
  readonly userId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly status: string;
}

export interface PasswordResetStore {
  findResetTarget(address: string): Promise<ResetTargetRow | undefined>;
  issueToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;
  /** Marks it spent and returns it, or `undefined` if it was already spent, expired or unknown. */
  consumeToken(tokenHash: string, now: Date): Promise<ResetTokenRow | undefined>;
  writePassword(userId: string, hash: string): Promise<void>;
  revokeSessions(userId: string): Promise<void>;
}

export const PASSWORD_RESET_STORE = Symbol('wewin.auth.passwordResetStore');

@Injectable()
export class PasswordResetRepository implements PasswordResetStore {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Verified addresses only, for the reason `password.repository.ts` spells out at length. */
  async findResetTarget(address: string): Promise<ResetTargetRow | undefined> {
    const [row] = await this.db
      .select({
        userId: users.id,
        address: userEmails.address,
        displayName: users.displayName,
        status: users.status,
      })
      .from(userEmails)
      .innerJoin(users, eq(users.id, userEmails.userId))
      .where(and(eq(userEmails.address, address), sql`${userEmails.verifiedAt} is not null`))
      .limit(1);

    return row;
  }

  /**
   * ⚠️ **Every earlier unspent token for this user is consumed first.**
   *
   * Otherwise "I clicked it three times" leaves three live links in three copies of an
   * email, each valid for the full window, and the oldest of them is the one most likely to
   * have been forwarded, logged by a scanner, or read over somebody's shoulder. One live
   * link per account at a time is the only count that is easy to reason about.
   *
   * `auth_tokens_email_target_shape` requires `user_email_id` to be NULL for this purpose,
   * which is why it is absent rather than forgotten: a reset is for the account, not for one
   * of its addresses.
   */
  async issueToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(authTokens.userId, input.userId),
            eq(authTokens.purpose, 'password_reset'),
            sql`${authTokens.consumedAt} is null`,
          ),
        );

      await tx.insert(authTokens).values({
        purpose: 'password_reset',
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
    });
  }

  /**
   * Spend a token, atomically.
   *
   * ⭐ One UPDATE with `consumed_at is null` in its WHERE clause, and `returning` to find out
   * whether it matched. A read-then-write would let two requests carrying the same link both
   * see an unspent row and both proceed — which is the whole of "one-shot" lost to a race
   * that a doubled-clicked email link produces on purpose.
   */
  async consumeToken(tokenHash: string, now: Date): Promise<ResetTokenRow | undefined> {
    const [row] = await this.db
      .update(authTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.purpose, 'password_reset'),
          sql`${authTokens.consumedAt} is null`,
          sql`${authTokens.expiresAt} > ${now}`,
        ),
      )
      .returning({ userId: authTokens.userId, expiresAt: authTokens.expiresAt });

    if (row === undefined) return undefined;

    const [user] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    return {
      userId: row.userId,
      expiresAt: row.expiresAt,
      consumedAt: now,
      status: user?.status ?? 'erased',
    };
  }

  /** Upsert, because the account may never have had a password — a Google sign-up setting one. */
  async writePassword(userId: string, hash: string): Promise<void> {
    await this.db
      .insert(passwordCredentials)
      .values({ userId, passwordHash: hash })
      .onConflictDoUpdate({
        target: passwordCredentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
  }

  /**
   * End every session this account has.
   *
   * `password_changed`, which `sessions_revoked_reason_known` already allows — the CHECK
   * lists six reasons and a seventh would be a migration for a distinction nobody needs.
   * It is also the accurate word: what happened to the credential is that it changed. The
   * column exists at all because "logged out" and "we saw a stolen token" need different
   * words in a support conversation, and this is the one that answers "why was I signed out
   * on my phone".
   */
  async revokeSessions(userId: string): Promise<void> {
    await this.db.execute(
      sql`update sessions
             set revoked_at = now(), revoked_reason = 'password_changed'
           where user_id = ${userId}::uuid and revoked_at is null`,
    );
  }
}
