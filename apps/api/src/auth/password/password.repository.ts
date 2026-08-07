import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db/client';
import { and, eq, sql } from '@wewin/db/sql';
import { passwordCredentials, userEmails, userPhones, users } from '@wewin/db/schema';

import { DRIZZLE } from '../../database/database.tokens';
import type { UserStatus } from '@wewin/db/schema';

/**
 * One row, flattened from three tables, holding everything the sign-in decision needs.
 *
 * `passwordHash` is nullable because an account created through Google has no credential —
 * that is a normal state and not an error, and the service must answer it identically to a
 * wrong password.
 */
export interface PasswordCredentialRow {
  readonly userId: string;
  readonly status: UserStatus;
  readonly passwordHash: string | null;
}

/**
 * The seam. An interface so the service can be tested against a fake that answers in
 * microseconds, which is what makes the timing assertions in `password-sign-in.test.ts`
 * measure the *service* rather than a database round trip.
 */
export interface PasswordCredentialStore {
  findByVerifiedEmail(address: string): Promise<PasswordCredentialRow | undefined>;
  /**
   * ⭐ The same lookup, one field over.
   *
   * `user_phones_one_verified_owner` is partial exactly as the address index is, so
   * `verified_at is not null` carries the same whole-of-the-security weight here: without
   * it, this returns whichever account claimed the number first, verified or not.
   *
   * ⚠️ The number must already be **canonical** — `@wewin/core/phone`'s E.164. Every stored
   * value obeys `user_phones_number_e164`, so an un-normalised argument silently matches
   * nothing and reads to the caller as "wrong password".
   */
  findByVerifiedPhone(number: string): Promise<PasswordCredentialRow | undefined>;
  /**
   * By id, for a caller that already has a session and is re-proving.
   *
   * ⚠️ Separate from `findByVerifiedEmail` on purpose. That one is the *sign-in* lookup and
   * requires a verified address, because an unverified one is a claim. Here the identity
   * came from a token this process signed, so there is nothing left to verify — and reusing
   * the address path would refuse somebody with a working password and an unconfirmed email.
   */
  findByUserId(userId: string): Promise<PasswordCredentialRow | undefined>;
  replaceHash(userId: string, hash: string): Promise<void>;
}

export const PASSWORD_CREDENTIAL_STORE = Symbol('wewin.auth.passwordCredentialStore');

@Injectable()
export class PasswordRepository implements PasswordCredentialStore {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * ⭐ **`verified_at is not null` is the whole of this query's security.**
   *
   * `user_emails_one_verified_owner` is a *partial* unique index — it constrains verified
   * rows only, and unverified duplicates are allowed to exist on purpose, because that is
   * the state an attacker creates when they add somebody else's address to their own
   * account. The schema's own comment calls it "the constraint the whole attack turns on".
   *
   * So a lookup that matched on address alone would find the attacker's *unverified* row
   * for the victim's address and hand back the attacker's user id — at which point the
   * attacker signs in as themselves, with their own password, having chosen which account
   * the address resolves to. Requiring `verified_at` means this query can only ever return
   * the one row the unique index guarantees.
   *
   * The address is expected already trimmed and lower-cased by the caller; the CHECK
   * `user_emails_address_lowercase` means every stored value is lower case, so an
   * un-normalised argument would silently return nothing and read as "wrong password".
   */
  async findByVerifiedEmail(address: string): Promise<PasswordCredentialRow | undefined> {
    const [row] = await this.db
      .select({
        userId: users.id,
        status: users.status,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(userEmails)
      .innerJoin(users, eq(users.id, userEmails.userId))
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      // `sql` rather than an `isNotNull` helper: `@wewin/db/sql` re-exports a deliberately
      // small set of drizzle operators, and widening that surface for one predicate is the
      // wrong trade — see packages/db/src/sql.ts.
      .where(and(eq(userEmails.address, address), sql`${userEmails.verifiedAt} is not null`))
      .limit(1);

    return row === undefined ? undefined : { ...row, status: row.status as UserStatus };
  }

  /**
   * ⭐ By verified telephone number — the other username.
   *
   * The argument is `findByVerifiedEmail`'s, verbatim, one field over: the unique index is
   * *partial*, unverified duplicates exist by design because that is the state an attacker
   * creates, and a lookup on the number alone would hand back whichever account claimed it
   * first. `verified_at is not null` is what makes the row this returns the one the index
   * guarantees is unique.
   *
   * ⚠️ The caller passes E.164 and this does not normalise. Doing it in both places is how
   * the two drift; doing it in the service means one normalisation feeds the lookup *and*
   * the throttle key, which is the property `password-sign-in.service.ts` needs.
   */
  async findByVerifiedPhone(number: string): Promise<PasswordCredentialRow | undefined> {
    const [row] = await this.db
      .select({
        userId: users.id,
        status: users.status,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(userPhones)
      .innerJoin(users, eq(users.id, userPhones.userId))
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .where(and(eq(userPhones.number, number), sql`${userPhones.verifiedAt} is not null`))
      .limit(1);

    return row === undefined ? undefined : { ...row, status: row.status as UserStatus };
  }

  /**
   * Write a stronger hash over a weaker one, for the same user.
   *
   * An UPDATE and never an INSERT: this only ever runs after a successful verification
   * against an existing row, so an upsert here could only paper over a bug in which the row
   * was not found. `password_credentials_argon2id` refuses anything that is not a PHC
   * argon2id string, which is the database's half of the same guarantee.
   */
  async findByUserId(userId: string): Promise<PasswordCredentialRow | undefined> {
    const [row] = await this.db
      .select({
        userId: users.id,
        status: users.status,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(users)
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    return row;
  }

  async replaceHash(userId: string, hash: string): Promise<void> {
    await this.db
      .update(passwordCredentials)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(eq(passwordCredentials.userId, userId));
  }
}
