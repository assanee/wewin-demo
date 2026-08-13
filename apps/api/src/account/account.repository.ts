import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, asc, desc, eq, sql } from '@wewin/db/sql';
import { passwordCredentials, providerIdentities, userEmails, userPhones, users } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import type { AccountWire, LinkedProviderWire, MySessionWire, PhoneWire } from './account.contract';

@Injectable()
export class AccountRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Everything the settings screen shows, for one person.
   *
   * `currentSessionId` comes from the verified access token, so "this device" is a fact
   * about the request rather than something the browser told us about itself.
   */
  async overview(userId: string, currentSessionId: string): Promise<AccountWire | undefined> {
    const [user] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (user === undefined) return undefined;

    const [emails, providers, sessions, hasPassword, phones] = await Promise.all([
      this.db
        .select({ address: userEmails.address, isPrimary: userEmails.isPrimary })
        .from(userEmails)
        // Verified only. An unverified row is somebody's claim on an address, and showing it
        // here would tell its owner they hold something they do not.
        .where(and(eq(userEmails.userId, userId), sql`${userEmails.verifiedAt} is not null`)),
      this.listProviders(userId),
      this.listSessions(userId, currentSessionId),
      this.hasPassword(userId),
      this.listPhones(userId),
    ]);

    return {
      userId: user.id,
      displayName: user.displayName,
      emails,
      phones,
      hasPassword,
      providers,
      sessions,
      /* Filled in by the service, which owns the rule. */
      waysIn: 0,
    };
  }

  /**
   * Every telephone number this account has claimed — verified or not.
   *
   * ⚠️ **Not filtered to verified rows, unlike `emails` above.** `RegistrationService` leaves
   * every self-registered number with `verified_at` null — it is a claim, proved later (if
   * ever) by a member of staff on the phone — so a verified-only filter would answer "no
   * phone" for almost every customer who signed up the only way this storefront offers.
   * Showing an unverified email would misrepresent a proof that does not exist; showing an
   * unverified phone here is just showing somebody their own number back.
   *
   * `isPrimary` is carried through rather than assumed true for a single row: the schema's
   * `user_phones_primary_is_verified` check makes it false for exactly the unverified numbers
   * this method exists to surface, so a caller after "the" number should not read it as a
   * signal of anything.
   *
   * ⭐ **`verified_at` and a voucher flag travel with each row**, because `isPrimary` was being
   * asked a question it cannot answer. The CHECK makes `isPrimary` imply verified, so reading
   * it as the verification signal is safe in one direction only — a verified number that is
   * not the primary one would have read as an unproven claim. A profile screen showing that
   * would tell a customer their confirmed number is unconfirmed.
   *
   * ⚠️ **`verified_by_user_id` is reduced to a boolean here and the id never leaves this
   * method.** The projection is what enforces that, not a mapping the caller could bypass: a
   * customer asking about their own number has no business receiving a member of staff's user
   * UUID. `/admin/users` carries the id, on its own wire, for a reader who may see it.
   */
  async listPhones(userId: string): Promise<readonly PhoneWire[]> {
    const rows = await this.db
      .select({
        number: userPhones.number,
        isPrimary: userPhones.isPrimary,
        verifiedAt: userPhones.verifiedAt,
        verifiedByUserId: userPhones.verifiedByUserId,
      })
      .from(userPhones)
      .where(eq(userPhones.userId, userId))
      .orderBy(desc(userPhones.isPrimary), asc(userPhones.createdAt));

    return rows.map((row) => ({
      number: row.number,
      isPrimary: row.isPrimary,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      /*
       * `user_phones_voucher_needs_a_verification` already refuses a voucher on an unverified
       * row, so this cannot be true while `verifiedAt` is null — the CHECK is what makes the
       * pair coherent rather than a conjunction written here.
       */
      verifiedByStaff: row.verifiedByUserId !== null,
    }));
  }

  async listProviders(userId: string): Promise<readonly LinkedProviderWire[]> {
    const rows = await this.db
      .select({
        provider: providerIdentities.provider,
        assertedEmail: providerIdentities.assertedEmail,
        assertedEmailVerified: providerIdentities.assertedEmailVerified,
        lastAuthenticatedAt: providerIdentities.lastAuthenticatedAt,
      })
      .from(providerIdentities)
      .where(eq(providerIdentities.userId, userId));

    return rows.map((row) => ({
      provider: row.provider,
      assertedEmail: row.assertedEmail,
      assertedEmailVerified: row.assertedEmailVerified,
      lastAuthenticatedAt: row.lastAuthenticatedAt?.toISOString() ?? null,
    }));
  }

  /**
   * The person's own live sessions.
   *
   * ⚠️ No token, no hash, nothing that could be replayed — `sessions` holds none of that
   * anyway (the refresh secret lives in its own table), and this projection is deliberate
   * rather than incidental: a screen listing devices needs a user agent and a timestamp and
   * has no business holding anything else.
   */
  async listSessions(userId: string, currentSessionId: string): Promise<readonly MySessionWire[]> {
    const rows = await this.db.execute<{
      id: string;
      user_agent: string | null;
      created_at: string;
      last_seen_at: string | null;
    }>(sql`
      select id, user_agent, created_at, last_seen_at
        from sessions
       where user_id = ${userId}::uuid and revoked_at is null and expires_at > now()
       order by coalesce(last_seen_at, created_at) desc
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      userAgent: row.user_agent,
      /* Strings, because `db.execute` bypasses Drizzle's type parsers — see users.repository. */
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  async hasPassword(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: passwordCredentials.userId })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId))
      .limit(1);

    return row !== undefined;
  }

  async passwordHashOf(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ hash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId))
      .limit(1);

    return row?.hash;
  }

  async verifiedEmailCount(userId: string): Promise<number> {
    const rows = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from user_emails
       where user_id = ${userId}::uuid and verified_at is not null
    `);
    return rows.rows[0]?.n ?? 0;
  }

  async writePassword(userId: string, hash: string): Promise<void> {
    await this.db
      .insert(passwordCredentials)
      .values({ userId, passwordHash: hash })
      .onConflictDoUpdate({
        target: passwordCredentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
  }

  async unlinkProvider(userId: string, provider: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      delete from provider_identities
       where user_id = ${userId}::uuid and provider = ${provider}
      returning id
    `);
    return result.rows.length;
  }

  /**
   * Revoke one session, or every session except one.
   *
   * ⚠️ `user_id` is in the WHERE clause of both, and it comes from the verified token rather
   * than from the request body. Without it, a session id from a URL would end somebody
   * else's session — the same shape as the ownership term in `scoped-order.repository.ts`,
   * for the same reason.
   */
  async revokeSession(userId: string, sessionId: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      update sessions set revoked_at = now(), revoked_reason = 'logout'
       where id = ${sessionId}::uuid and user_id = ${userId}::uuid and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }

  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      update sessions set revoked_at = now(), revoked_reason = 'logout'
       where user_id = ${userId}::uuid and id <> ${keepSessionId}::uuid and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }

  /** Every session but this one, after a password change. See the service for why. */
  async revokeOthersAfterPasswordChange(userId: string, keepSessionId: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      update sessions set revoked_at = now(), revoked_reason = 'password_changed'
       where user_id = ${userId}::uuid and id <> ${keepSessionId}::uuid and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }
}
