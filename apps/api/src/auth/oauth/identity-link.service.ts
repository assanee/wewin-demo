import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { guests, providerIdentities, userEmails, users } from '@wewin/db/schema';
import { and, eq, sql } from '@wewin/db/sql';

import { DRIZZLE } from '../../database/database.tokens';
import type { ProviderName } from './providers/provider.types';

/**
 * ⓐ Turning a provider assertion into an account — plan 6(a).
 *
 * This is the counter-intuitive one, and it is worth stating the attack before the rule
 * because the rule looks wrong without it.
 *
 *   The attacker registers with the *victim's* email address and never verifies it. Nothing
 *   stops them: an unverified claim is exactly what a fresh signup is. Months later the
 *   victim signs in with Google on that address. Any implementation that reaches for "an
 *   existing account with this email" finds the attacker's, links the victim's Google
 *   identity into it, and hands the victim a session inside an account the attacker still
 *   has the password to — reading their orders, their addresses, and everything they do
 *   next. The victim sees a working login. Nothing anywhere reports an incident.
 *
 * So the rule, from the plan: **proving control of an address strips it from every
 * unverified account and creates a fresh one.** Not "merges into the existing account".
 * Merging *is* the handover.
 *
 * Three branches, and the third is the one that closes it:
 *
 *   1. `(provider, subject)` already known → that is the account. No email is consulted at
 *      all. Identity, not address, is what a returning customer is recognised by.
 *   2. new identity, and the address is *already verified by some account* → link to that
 *      account. Safe, and the reason it is safe is precise: somebody proved control of that
 *      mailbox, and the provider has just proved control of the same mailbox. Two proofs of
 *      the same fact are one person. This branch is what makes "sign in with Google" reach
 *      the account you made with a password.
 *   3. new identity, address proven, nobody has verified it → **a new account**, holding
 *      that address as verified. The INSERT fires `user_emails_strip_unverified`
 *      (0003_auth_guards.sql), which deletes every unverified claim on the address in the
 *      same statement. The attacker's row is gone; the attacker's account survives with no
 *      route to it.
 *
 * And one non-branch: an address the provider asserted but did **not** prove (Facebook
 * always; LINE and Apple when they send nothing) never touches `user_emails`. It is
 * recorded on `provider_identities.asserted_email` — what was claimed, when — and is never
 * a link key. That column exists so this distinction can be kept rather than flattened.
 *
 * The retry is not incidental. Two of these paths race against a concurrent verification of
 * the same address, and `user_emails_one_verified_owner` is what makes the loser lose — a
 * 23505 rather than a second verified owner. Catching it and re-running lands the second
 * caller in branch 2, which is the correct answer that was not yet true when it looked.
 */

export interface ProviderAssertion {
  readonly provider: ProviderName;
  readonly subject: string;
  /** Lower-cased, or absent. */
  readonly email: string | undefined;
  /** ⓐ Does this count as proof of control? See `ProviderProfile.emailProven`. */
  readonly emailProven: boolean;
  readonly displayName: string | undefined;
}

export interface LinkedAccount {
  readonly userId: string;
  /** True when branch 3 ran — a fresh account, and every unverified claim on the address stripped. */
  readonly accountCreated: boolean;
  /** True when branch 2 ran — attached to an account that had already proved the same address. */
  readonly attachedToVerifiedOwner: boolean;
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * The account exists and is not allowed to be used.
 *
 * A separate error and not a `false` return, because every caller of `link` must do
 * something different with it than with a failure: there is nothing to retry and nothing to
 * create. `OAuthService` turns it into the same opaque redirect every other refusal gets —
 * a suspended person must not learn from the login page whether their suspension is the
 * reason, and a stranger must not learn that an account exists at all.
 *
 * `users.status` was written by the schema and read by nothing until this existed:
 * suspending an account revoked no session, refused no sign-in, and the operator who did it
 * had no way to see that nothing had happened.
 */
export class AccountSuspendedError extends Error {
  constructor(readonly userId: string) {
    super('This account is not active.');
    this.name = 'AccountSuspendedError';
  }
}

@Injectable()
export class IdentityLinkService {
  private readonly logger = new Logger('OAuthIdentity');

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async link(assertion: ProviderAssertion): Promise<LinkedAccount> {
    /*
     * Two attempts, not a loop. One retry is enough to absorb the race — the second pass
     * sees the row the winner committed and takes branch 1 or 2, neither of which can
     * raise the same violation — and an unbounded loop against a live conflict is how a
     * login turns into a hot spin.
     */
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.linkOnce(assertion);
      } catch (error) {
        if (attempt >= 1 || !isUniqueViolation(error)) throw error;
        this.logger.debug(
          `${assertion.provider} identity lost a race on a concurrent verification; retrying once`,
        );
      }
    }
  }

  private async linkOnce(assertion: ProviderAssertion): Promise<LinkedAccount> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: providerIdentities.id,
          userId: providerIdentities.userId,
          status: users.status,
        })
        .from(providerIdentities)
        // The account's status travels with the identity: every branch that returns an
        // *existing* user id has to answer for it, and a separate lookup is a lookup a
        // future branch can forget to make.
        .innerJoin(users, eq(users.id, providerIdentities.userId))
        .where(
          and(
            eq(providerIdentities.provider, assertion.provider),
            eq(providerIdentities.subject, assertion.subject),
          ),
        )
        .limit(1);

      /* Branch 1 — a returning customer, recognised by `sub` and by nothing else. */
      if (existing) {
        if (existing.status !== 'active') throw new AccountSuspendedError(existing.userId);
        await tx
          .update(providerIdentities)
          .set({
            assertedEmail: assertion.email ?? null,
            assertedEmailVerified: assertion.emailProven,
            lastAuthenticatedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(providerIdentities.id, existing.id));

        if (assertion.email !== undefined && assertion.emailProven) {
          await this.recordProvenAddress(tx, existing.userId, assertion.email);
        }

        return {
          userId: existing.userId,
          accountCreated: false,
          attachedToVerifiedOwner: false,
        };
      }

      const provenOwner =
        assertion.email !== undefined && assertion.emailProven
          ? await verifiedOwnerOf(tx, assertion.email)
          : undefined;

      /* Branch 2 — the address is already proved by an account, so this is that person. */
      if (provenOwner !== undefined) {
        /*
         * Refused, and deliberately *not* fallen through to branch 3. A second account
         * holding the same verified address is what `user_emails_one_verified_owner`
         * forbids, so the fall-through would 23505, retry, and 23505 again — a 500 on a
         * login page instead of an answer. The address belongs to a suspended account and
         * that is the whole story.
         */
        if (provenOwner.status !== 'active') throw new AccountSuspendedError(provenOwner.userId);

        await insertIdentity(tx, provenOwner.userId, assertion);
        return { userId: provenOwner.userId, accountCreated: false, attachedToVerifiedOwner: true };
      }

      /* Branch 3 — a fresh account. Never a merge into an unverified one. */
      const [created] = await tx
        .insert(users)
        .values({ displayName: assertion.displayName ?? null })
        .returning({ id: users.id });

      if (created === undefined) {
        throw new Error('inserting a user returned no row');
      }

      if (assertion.email !== undefined && assertion.emailProven) {
        /*
         * ⓐ The statement that closes the attack.
         *
         * `verifiedAt` set in the INSERT — not written now and verified later — because
         * `user_emails_strip_unverified` fires on exactly this, and it is the trigger that
         * deletes the attacker's unverified claim. Doing it in two statements would leave a
         * window in which the address has two owners, and doing the deletion here in
         * application code would leave the same window plus a caller that can forget.
         *
         * `isPrimary` is safe to set in the same row only because it is verified;
         * `user_emails_primary_is_verified` rejects the alternative.
         */
        await tx.insert(userEmails).values({
          userId: created.id,
          address: assertion.email,
          verifiedAt: sql`now()`,
          isPrimary: true,
        });
      }

      await insertIdentity(tx, created.id, assertion);
      return { userId: created.id, accountCreated: true, attachedToVerifiedOwner: false };
    });
  }

  /**
   * A returning customer whose provider has now proved an address the account did not hold.
   *
   * The same rule as branch 3, applied to an account that already exists: the proof is a
   * proof whichever branch it arrives through, so the address is recorded verified and the
   * strip trigger runs. A concurrent verification elsewhere wins the unique index instead,
   * and that is not a login failure — the customer is already identified by `sub`, so the
   * address is simply not added and the sign-in proceeds.
   */
  private async recordProvenAddress(tx: Transaction, userId: string, address: string): Promise<void> {
    /*
     * ⓐ The strip runs on *every* proof, before any early return, and that is a fix.
     *
     * The rule in plan 6(a) is "proving control strips the address from every unverified
     * account". The trigger implements that as a sweep on the proving *statement*, so a
     * returning customer re-proving an address they already hold verified used to return
     * two lines below without stripping anything — and an attacker who re-planted the claim
     * one second after the first proof was never swept again. Running it unconditionally
     * makes the rule idempotent rather than a one-off.
     *
     * `user_emails_claim_guard` now also refuses to *insert* an unverified claim on a proven
     * address, so in a database migrated past 0004 this statement should find nothing. It
     * stays because rows written before that migration are not hypothetical, and because
     * "the invariant is restored on every proof" is a cheaper thing to reason about than
     * "the invariant was true at every past instant".
     */
    await tx
      .delete(userEmails)
      .where(
        and(
          eq(userEmails.address, address),
          sql`${userEmails.verifiedAt} is null`,
          sql`${userEmails.userId} <> ${userId}`,
        ),
      );

    const [held] = await tx
      .select({ id: userEmails.id, verifiedAt: userEmails.verifiedAt })
      .from(userEmails)
      .where(and(eq(userEmails.userId, userId), eq(userEmails.address, address)))
      .limit(1);

    if (held !== undefined && held.verifiedAt !== null) return;

    // Somebody already proved it — this account, in which case there is nothing to do, or
    // another, in which case their claim stands and ours is not recorded. The two collapse
    // into one branch because the first is unreachable past the check above.
    if ((await verifiedOwnerOf(tx, address)) !== undefined) return;

    if (held) {
      await tx
        .update(userEmails)
        .set({ verifiedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(userEmails.id, held.id));
      return;
    }

    await tx.insert(userEmails).values({ userId, address, verifiedAt: sql`now()` });
  }

  /**
   * The seam between the anonymous funnel and an account.
   *
   * `oauth_states.guest_id` carried the visitor through the provider round trip; this is
   * where the cart they built before signing in becomes theirs. Guarded by
   * `claimed_by_user_id IS NULL` so a second sign-in from the same browser — the guest
   * cookie outlives the login — cannot re-point an already-claimed visitor at a different
   * account.
   *
   * Claiming is also what *ends* the cookie's power. The id is an unsigned bearer
   * capability, so an attacker who can write a cookie in the victim's browser (which
   * `__Host-` is there to prevent) could have the victim's sign-in adopt a cart the attacker
   * still held the id for. Since `GuestRepository.isOpenGuest` refuses a claimed row, that
   * id is worth nothing the moment this statement succeeds — the transfer costs the victim
   * the cart they built in that browser, and gives the attacker no read at all.
   *
   * Logged with both ids, because a claim is an ownership transfer and the one question
   * afterwards is always "which cart went where".
   */
  async claimGuest(guestId: string, userId: string): Promise<boolean> {
    const claimed = await this.db
      .update(guests)
      .set({ claimedByUserId: userId, claimedAt: sql`now()`, lastSeenAt: sql`now()` })
      .where(and(eq(guests.id, guestId), sql`${guests.claimedByUserId} is null`))
      .returning({ id: guests.id });

    if (claimed.length > 0) this.logger.log(`guest ${guestId} claimed by user ${userId}`);
    return claimed.length > 0;
  }
}

/**
 * The transaction handle drizzle hands to the callback.
 *
 * Derived from `Database` rather than imported: `PgTransaction`'s type parameters are part
 * of drizzle's internals, and naming them here would resolve a second copy of drizzle's
 * declarations — the exact problem packages/db/src/sql.ts exists to avoid.
 */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface VerifiedOwner {
  readonly userId: string;
  readonly status: 'active' | 'suspended';
}

async function verifiedOwnerOf(tx: Transaction, address: string): Promise<VerifiedOwner | undefined> {
  const [owner] = await tx
    .select({ userId: userEmails.userId, status: users.status })
    .from(userEmails)
    .innerJoin(users, eq(users.id, userEmails.userId))
    .where(and(eq(userEmails.address, address), sql`${userEmails.verifiedAt} is not null`))
    .limit(1);

  return owner;
}

async function insertIdentity(
  tx: Transaction,
  userId: string,
  assertion: ProviderAssertion,
): Promise<void> {
  await tx.insert(providerIdentities).values({
    userId,
    provider: assertion.provider,
    subject: assertion.subject,
    assertedEmail: assertion.email ?? null,
    assertedEmailVerified: assertion.emailProven,
    lastAuthenticatedAt: sql`now()`,
  });
}

/**
 * Drizzle wraps driver errors and puts the original on `cause`, so the SQLSTATE is one
 * level down — read defensively rather than cast, because comparing `undefined` to
 * `undefined` would make the retry fire on every error instead of on a race.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (code === PG_UNIQUE_VIOLATION) return true;
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return false;
}
