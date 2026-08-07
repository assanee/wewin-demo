import { afterAll, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import {
  ERASURE_TREATMENTS,
  mfaCredentials,
  mfaRecoveryCodes,
  authTokens,
  groups,
  guests,
  notifications,
  orderEvents,
  orders,
  passwordCredentials,
  providerIdentities,
  sessions,
  userEmails,
  userErasureRequests,
  userGroups,
  users,
} from '../src/schema/index.js';
import { PG, connect, connectPool, describeDb, errorCode } from './support/db.js';

/**
 * Erasure, tested at the only layer that can tell whether it happened.
 *
 * ── Why every one of these is here and not in apps/api ──────────────────────────
 *
 * Plan 7.14(ก) finding 6b, verbatim: a test that is green because another mechanism is
 * masking it is a test that lies. Every guard below is either (a) a refusal on a direct
 * INSERT that no HTTP path currently reaches — so an api-level test would be green whether
 * the trigger exists or not — or (b) an interleaving of two transactions, which cannot be
 * constructed through a client that has one connection per request. The API-level half of
 * this work lives in apps/api/tests/auth/oauth/erasure.pg.test.ts and tests different
 * sentences.
 *
 * ── The claim these tests exist to falsify ──────────────────────────────────────
 *
 * The design this was built from said: "`erased` must be a claim the database checks, not a
 * job's promise… a half-run scrub cannot commit a row that says erased", and proposed to
 * enforce it with CHECK constraints keyed on the status. That is false as specified, and
 * `refuses to call a row erased while a credential survives` is the test that says why:
 * every constraint expressible on `users` is a same-row check and every scrub target except
 * `display_name` is a different row. The enforcement had to become a trigger. Removing any
 * one of its conjuncts turns exactly one test below red — the mutation table is in plan
 * 7.15.
 */

const tag = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;

const freshDigest = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');

const expectViolation = async (
  operation: Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE ${code}, got: ${String(caught)}`).toBe(code);
};

/** A person with one of everything an erasure has to reach. */
interface Subject {
  readonly userId: string;
  readonly address: string;
  readonly sessionId: string;
}

let sequence = 0;

async function createSubject(db: Database, label: string): Promise<Subject> {
  sequence += 1;
  const address = `erasure-${tag}-${String(sequence)}-${label}@example.test`;

  const [user] = await db
    .insert(users)
    .values({ displayName: `สมชาย ${label}` })
    .returning({ id: users.id });
  if (!user) throw new Error('inserting a user returned no row');

  await db
    .insert(userEmails)
    .values({ userId: user.id, address, verifiedAt: new Date(), isPrimary: true });
  await db
    .insert(providerIdentities)
    .values({ userId: user.id, provider: 'line', subject: `sub-${tag}-${String(sequence)}` });
  await db
    .insert(passwordCredentials)
    .values({ userId: user.id, passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA' });
  await db.insert(authTokens).values({
    purpose: 'password_reset',
    userId: user.id,
    tokenHash: freshDigest(),
    expiresAt: new Date(Date.now() + HOUR),
  });

  const [session] = await db
    .insert(sessions)
    .values({ userId: user.id, expiresAt: new Date(Date.now() + HOUR), ip: '203.0.113.7' })
    .returning({ id: sessions.id });
  if (!session) throw new Error('inserting a session returned no row');

  /*
   * ⚠️ The second factor — and the reason it is here rather than in a test of its own.
   *
   * "leaves no row in any table it calls delete" counts rows for every column declared
   * `delete`, so it is only as strong as this fixture: a table the subject has no rows in
   * counts zero either way, and the loop passes while the DELETE is missing. Declaring
   * `mfa_credentials.user_id` as `delete` and never seeding one is a treatment nothing
   * checks — proved by removing the statement from 0022 and watching all twenty tests stay
   * green.
   *
   * Recovery codes first: `mfa_credentials_guard_confirm` refuses a confirmed credential
   * with fewer than two unused ones, which is the gate's own invariant enforced in Postgres.
   */
  await db.insert(mfaRecoveryCodes).values([
    { userId: user.id, codeHash: freshDigest() },
    { userId: user.id, codeHash: freshDigest() },
    /*
     * One already spent, so erasure has to get past `mfa_recovery_codes_guard_write` — which
     * refuses to delete a used code, because a used code is the record that somebody
     * recovered an account. Without this row the trigger bypass in `erase_user` is never
     * exercised and could be removed with every test still green.
     */
    { userId: user.id, codeHash: freshDigest(), usedAt: new Date() },
  ]);

  await db.insert(mfaCredentials).values({
    userId: user.id,
    secretSealed: 'v1.ZmFrZS1zZWFsZWQtc2VjcmV0',
    confirmedAt: new Date(),
    lastAcceptedStep: 56_000_000,
  });

  return { userId: user.id, address, sessionId: session.id };
}

const close = (db: Database, userId: string): Promise<unknown> =>
  db.execute(sql`select close_user(${userId}::uuid)`);

const erase = (db: Database, userId: string, requestedBy: string | null = null): Promise<unknown> =>
  db.execute(
    sql`select erase_user(${userId}::uuid, ${requestedBy}::uuid, 'self_service', 'PDPA s.33 right to erasure')`,
  );

/**
 * ⚠️ The message is asserted, not only the SQLSTATE, and that is not pedantry.
 *
 * `users_erasure_is_earned` raises `restrict_violation` from four different conjuncts. The
 * first version of the tests below asserted the SQLSTATE alone, and the mutation run caught
 * them out: deleting the surviving-credential check left them green, because the
 * paper-trail check refused the same statement for a different reason. A test that is green
 * because another mechanism is standing in front of it is a test that lies — plan 7.14(ก)
 * finding 6b, met again at a different address. Naming the sentence is what makes each
 * conjunct separately observable.
 */
const expectRefusal = async (operation: Promise<unknown>, fragment: string): Promise<void> => {
  const caught = await operation.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(errorCode(caught), `expected SQLSTATE 23001, got: ${String(caught)}`).toBe(PG.restrictViolation);
  expect(messagesOf(caught).join(' | '), `expected a refusal mentioning "${fragment}"`).toContain(fragment);
};

/**
 * Every `message` down the cause chain.
 *
 * Drizzle wraps a driver error and puts the original on `cause`, so the sentence the trigger
 * raised is one level below the one `String(error)` prints — which is how the first version
 * of `expectRefusal` managed to assert nothing at all.
 */
function messagesOf(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('message' in current) {
      const { message } = current as { message: unknown };
      if (typeof message === 'string') found.push(message);
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return found;
}

/**
 * The `erased` UPDATE, written by hand, inside a transaction we control.
 *
 * `erase_user()` cannot be used to test the trigger, because the function makes some of the
 * same checks itself and would mask them — which is exactly what the mutation run showed for
 * `OLD.status <> 'closed'`. Writing the statement by hand, and optionally writing the paper
 * trail beside it in the same transaction, is what isolates one conjunct at a time.
 */
const attemptSelfErasure = async (
  userId: string,
  options: { readonly withRequest: boolean },
): Promise<unknown> => {
  const pool = await connectPool();
  const client = await pool.connect();

  try {
    await client.query('begin');
    if (options.withRequest) {
      await client.query(
        `insert into user_erasure_requests (user_id, channel, legal_basis, completed_at, write_txid)
         values ($1, 'self_service', 'PDPA s.33', now(), pg_current_xact_id()::text)`,
        [userId],
      );
    }
    await client.query(
      `update users set status = 'erased', erased_at = now(), display_name = null where id = $1`,
      [userId],
    );
    return undefined;
  } catch (error: unknown) {
    return error;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
};

const scrubByHand = async (db: Database, userId: string): Promise<void> => {
  await db.delete(authTokens).where(eq(authTokens.userId, userId));
  await db.delete(userEmails).where(eq(userEmails.userId, userId));
  await db.delete(providerIdentities).where(eq(providerIdentities.userId, userId));
  await db.delete(passwordCredentials).where(eq(passwordCredentials.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
};

const statusOf = async (db: Database, userId: string): Promise<string> => {
  const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  return row?.status ?? 'gone';
};

describeDb('erase_user', () => {
  it('deletes every credential, scrubs the name, and records what it withheld', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'happy');

    await close(db, subject.userId);
    await erase(db, subject.userId);

    const [row] = await db
      .select({
        status: users.status,
        displayName: users.displayName,
        closedAt: users.closedAt,
        erasedAt: users.erasedAt,
      })
      .from(users)
      .where(eq(users.id, subject.userId));

    expect(row?.status).toBe('erased');
    expect(row?.displayName).toBeNull();
    expect(row?.erasedAt).not.toBeNull();
    /*
     * The date the customer asked survives the erasure. `users_closed_at_present` is a
     * one-way implication for exactly this reason: written as a biconditional it would force
     * the erasure to NULL this column, destroying the one fact that proves the cooling-off
     * period was honoured.
     */
    expect(row?.closedAt).not.toBeNull();

    for (const [name, rows] of [
      ['user_emails', await db.select().from(userEmails).where(eq(userEmails.userId, subject.userId))],
      ['provider_identities', await db.select().from(providerIdentities).where(eq(providerIdentities.userId, subject.userId))],
      ['password_credentials', await db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, subject.userId))],
      ['auth_tokens', await db.select().from(authTokens).where(eq(authTokens.userId, subject.userId))],
      ['sessions', await db.select().from(sessions).where(eq(sessions.userId, subject.userId))],
    ] as const) {
      expect(rows, `${name} still holds a row for an erased user`).toHaveLength(0);
    }

    const [request] = await db
      .select()
      .from(userErasureRequests)
      .where(eq(userErasureRequests.userId, subject.userId));

    expect(request?.completedAt).not.toBeNull();
    expect(request?.legalBasis).toBe('PDPA s.33 right to erasure');
    // Not decoration. A DSAR answer of "we erased you" that does not say what the
    // accounting exemption held back is not an answer, and this round could not reach
    // orders, the spine or the attempt log at all.
    expect(request?.withheldScope).toContain('orders.contact_email');
    expect(request?.withheldScope).toContain('notification_attempts.recipient_key');
  });

  /**
   * ⚠️ THE ONE THAT MATTERS. Mutation: delete the `survivor` block from
   * `users_erasure_is_earned()` and this goes red on its own.
   */
  it('refuses to call a row erased while a credential survives', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'liar');
    await close(db, subject.userId);

    // Exactly the statement the CHECK-only design permits: it satisfies
    // `users_erased_has_no_name`, `users_erased_at_present` and `users_erased_at_shape`,
    // and leaves the address, the provider identity, the password hash and a live session
    // attached to a row that says the person has been forgotten. The paper trail IS written,
    // in the same transaction, so that the surviving-credential check is the only thing left
    // that can refuse it.
    await expectRefusal(
      Promise.resolve(attemptSelfErasure(subject.userId, { withRequest: true })).then((error) => {
        if (error !== undefined) throw error;
      }),
      'still has rows in',
    );

    expect(await statusOf(db, subject.userId)).toBe('closed');
  });

  /** Mutation: delete the `user_erasure_requests` EXISTS block from the trigger. */
  it('refuses an erasure with no paper trail written in the same transaction', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'silent');
    await close(db, subject.userId);

    // Do the whole scrub by hand, so the only thing missing is the record of who asked.
    await scrubByHand(db, subject.userId);

    await expectRefusal(
      Promise.resolve(attemptSelfErasure(subject.userId, { withRequest: false })).then((error) => {
        if (error !== undefined) throw error;
      }),
      'no completed erasure request in this transaction',
    );
  });

  /**
   * A request row from an earlier transaction must not authorise a scrub today — which is
   * why the trigger compares `write_txid` against `pg_current_xact_id()` rather than merely
   * requiring a row to exist. Mutation: drop the `write_txid` conjunct.
   */
  it('refuses a paper trail borrowed from an earlier transaction', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'borrowed');
    await close(db, subject.userId);

    await scrubByHand(db, subject.userId);

    await db.insert(userErasureRequests).values({
      userId: subject.userId,
      channel: 'email',
      legalBasis: 'PDPA s.33',
      // `now()` and not a JS Date: `requested_at` defaults to server time in microseconds
      // and a millisecond-truncated client clock lands a hair before it, tripping
      // `user_erasure_requests_completed_after_requested` for the wrong reason.
      completedAt: sql`now()`,
      writeTxid: '1',
    });

    await expectRefusal(
      Promise.resolve(attemptSelfErasure(subject.userId, { withRequest: false })).then((error) => {
        if (error !== undefined) throw error;
      }),
      'no completed erasure request in this transaction',
    );
  });

  /**
   * Mutation: drop the `OLD.status <> 'closed'` block from the trigger.
   *
   * Asserted against a hand-written UPDATE and not against `erase_user()`, because the
   * function makes the same check itself and would mask the trigger's — the mutation run
   * proved that, returning green with the trigger's conjunct deleted. Both halves are here:
   * the function refuses with its own sentence, and the trigger refuses a statement the
   * function never ran.
   */
  it('refuses to erase an account that was never closed', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'sudden');

    await expectRefusal(erase(db, subject.userId), 'close the account before erasing it');
    expect(await statusOf(db, subject.userId)).toBe('active');

    // Everything scrubbed and the paper trail written, so the only thing left to object is
    // that the account never passed through `closed` — the window in which the customer
    // could still change their mind.
    await scrubByHand(db, subject.userId);
    await expectRefusal(
      Promise.resolve(attemptSelfErasure(subject.userId, { withRequest: true })).then((error) => {
        if (error !== undefined) throw error;
      }),
      'erasure is reachable from closed and nothing else',
    );
  });

  /** Mutation: drop the terminal branch at the top of `users_erasure_is_earned()`. */
  it('lets nothing move a row out of erased', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'terminal');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    for (const status of ['active', 'suspended', 'closed'] as const) {
      await expectViolation(
        db.update(users).set({ status }).where(eq(users.id, subject.userId)),
        PG.restrictViolation,
      );
    }

    expect(await statusOf(db, subject.userId)).toBe('erased');
  });

  /**
   * The two CHECKs on `users`, which nothing above reaches — found by mutation, not by reading.
   *
   * Both triggers on `users` are `BEFORE UPDATE **OF status**`. An UPDATE whose SET list does
   * not name `status` therefore fires neither of them, and `users_erasure_is_earned()` returns
   * NEW early for an already-erased row in any case. So for a tombstone the CHECK constraints
   * are not belt-and-braces behind the trigger — for this class of statement they are the only
   * enforcement there is, and
   *
   *   UPDATE users SET display_name = 'สมชาย' WHERE id = <tombstone>;
   *
   * puts the person's name back on a row the database and every DSAR audit call erased.
   *
   * Removing `users_erased_has_no_name` and removing `users_erased_at_shape` from
   * drizzle/0009_user_erasure.sql both left the whole suite green before this test existed —
   * two guards with no evidence, which is the one thing this project's house rules do not
   * allow. `expectViolation` and not `expectRefusal`: a CHECK raises 23514 with the constraint
   * name, not a sentence a trigger wrote.
   *
   * ⚠️ What this test does NOT close, because closing it is a design change and not a missing
   * assertion: `UPDATE users SET closed_at = now()` and `UPDATE users SET suspended_at = now()`
   * against a tombstone are both ACCEPTED today, verified by running them. `closed_at` is the
   * date the customer asked — 0009 calls it "the one fact that proves the cooling-off period
   * was honoured" — and nothing stops it being rewritten after the erasure. See plan 7.16(ฉ).
   */
  it('will not let a tombstone be re-personalised by an UPDATE that never names status', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'repersonalise');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    // users_erased_has_no_name: the name cannot come back.
    await expectViolation(
      db.update(users).set({ displayName: 'สมชาย again' }).where(eq(users.id, subject.userId)),
      PG.checkViolation,
    );

    // users_erased_at_present: the date of the erasure cannot be removed to hide that it ran.
    await expectViolation(
      db.update(users).set({ erasedAt: null }).where(eq(users.id, subject.userId)),
      PG.checkViolation,
    );

    // users_erased_at_shape, from the other side: a live account cannot claim an erasure date.
    const bystander = await createSubject(db, 'bystander');
    await expectViolation(
      db.update(users).set({ erasedAt: new Date() }).where(eq(users.id, bystander.userId)),
      PG.checkViolation,
    );

    const [row] = await db
      .select({ displayName: users.displayName, erasedAt: users.erasedAt })
      .from(users)
      .where(eq(users.id, subject.userId));
    expect(row?.displayName).toBeNull();
    expect(row?.erasedAt).not.toBeNull();
  });

  /**
   * The release, and the reason it does not reopen pre-hijacking ⓐ.
   *
   * `user_emails_one_verified_owner` is status-blind, so a retained verified address is a
   * permanent denial of service on that mailbox — the customer comes back four months later
   * and every provider refuses them opaquely. Deleting the row is the only legal exit
   * (`user_emails_verification_is_final` refuses both un-verifying and re-addressing), and
   * it is safe because `users` holds no address column: ownership is
   * `orders.customer_user_id`, so an address can change hands without an order changing
   * hands.
   */
  it('releases the verified address so the person can have an account again', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'return');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    const [reborn] = await db.insert(users).values({}).returning({ id: users.id });
    if (!reborn) throw new Error('inserting a user returned no row');

    await expect(
      db
        .insert(userEmails)
        .values({ userId: reborn.id, address: subject.address, verifiedAt: new Date(), isPrimary: true }),
    ).resolves.toBeDefined();
  });
});

describeDb('a tombstone cannot be brought back', () => {
  /**
   * ⚠️ Written as direct INSERTs on purpose — plan 7.14(ก) finding 6b. No HTTP path reaches
   * any of these today (after the scrub there is no `sub` and no verified address for
   * `IdentityLinkService` branches 1 and 2 to match), so an api-level version of this test
   * would be green with the triggers deleted. The caller that will reach them is phase 6's
   * "add an email to this account" admin action, and the guard's absence is invisible until
   * it exists.
   *
   * Mutation: drop any one of the six `*_refuse_erased_user` triggers and the matching row
   * below goes red.
   */
  it('refuses every credential and membership insert against an erased user', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'tomb');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    const [group] = await db
      .insert(groups)
      .values({ code: `erasure_${tag}`, nameTh: 'กลุ่มทดสอบ' })
      .returning({ id: groups.id });
    if (!group) throw new Error('inserting a group returned no row');

    await expectViolation(
      db.insert(userEmails).values({ userId: subject.userId, address: `back-${tag}@example.test` }),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .insert(providerIdentities)
        .values({ userId: subject.userId, provider: 'google', subject: `back-${tag}` }),
      PG.restrictViolation,
    );
    await expectViolation(
      db
        .insert(passwordCredentials)
        .values({ userId: subject.userId, passwordHash: '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aA' }),
      PG.restrictViolation,
    );
    await expectViolation(
      db.insert(authTokens).values({
        purpose: 'password_reset',
        userId: subject.userId,
        tokenHash: freshDigest(),
        expiresAt: new Date(Date.now() + HOUR),
      }),
      PG.restrictViolation,
    );
    await expectViolation(
      db.insert(sessions).values({ userId: subject.userId, expiresAt: new Date(Date.now() + HOUR) }),
      PG.restrictViolation,
    );
    await expectViolation(
      db.insert(userGroups).values({ userId: subject.userId, groupId: group.id }),
      PG.restrictViolation,
    );
  });

  /** Mutation: remove the `user_erasure_requests_append_only` trigger. */
  it('will not let the record of an erasure be rewritten or removed', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'record');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    await expectViolation(
      db
        .update(userErasureRequests)
        .set({ legalBasis: 'oops', completedAt: null })
        .where(eq(userErasureRequests.userId, subject.userId)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.delete(userErasureRequests).where(eq(userErasureRequests.userId, subject.userId)),
      PG.restrictViolation,
    );
  });
});

describeDb('closure', () => {
  /**
   * Mutation: remove the `users_status_revoke_sessions` trigger.
   *
   * Before it existed there was no trigger on `users` at all, so suspending an account wrote
   * a column and did nothing else — the per-request read in `RbacGuard` was the entire
   * enforcement, `sessions.revoked_at` stayed NULL forever, and the user's own device list
   * showed live sessions for a closed account.
   */
  it('revokes every open session, with a reason that is not a lie', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'closing');

    await close(db, subject.userId);

    const [session] = await db
      .select({ revokedAt: sessions.revokedAt, reason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.id, subject.sessionId));

    expect(session?.revokedAt).not.toBeNull();
    // `revoked_by_admin` is factually wrong when the customer is the one who asked, and
    // this vocabulary is small enough that the wrong word would be used forever.
    expect(session?.reason).toBe('account_closed');
  });

  it('refuses a status the domain does not know', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'unknown');

    await expectViolation(
      db.execute(sql`update users set status = 'deleted' where id = ${subject.userId}::uuid`),
      PG.checkViolation,
    );
  });
});

describeDb('the specification that replaced the cascades', () => {
  /**
   * The `ON DELETE CASCADE` clauses towards `users` were an *executable* specification of
   * "what personal data hangs off a person": add a table, give it a cascade, and one
   * `DELETE FROM users` covered it. Under the owner's never-delete decision they never fire,
   * so the specification stopped executing and nothing replaced it. This is the replacement.
   *
   * ⚠️ It is derived from foreign keys, and it is blind to the largest concentration of
   * personal data in the system: an order submitted by a guest who never signed in reaches
   * `users` through no foreign key at all. Read the note on `ERASURE_TREATMENTS` and plan
   * 7.15 before trusting a green result here.
   */
  it('names a treatment for every foreign key that points at a user', async () => {
    const db = await connect();

    const found = await db.execute<{ ref: string }>(sql`
      select tc.table_name || '.' || kcu.column_name as ref
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name = 'users'
       order by 1
    `);

    const live = found.rows.map((row) => row.ref);
    const declared = Object.keys(ERASURE_TREATMENTS);

    expect(live.filter((ref) => !declared.includes(ref)), 'a new foreign key to users has no erasure treatment').toStrictEqual([]);
    expect(declared.filter((ref) => !live.includes(ref)), 'a treatment names a foreign key that no longer exists').toStrictEqual([]);
  });

  /**
   * The claim `delete` makes, checked against the database rather than against the function
   * body. A treatment that says `delete` and a scrub that forgets the table is exactly the
   * drift this list exists to catch, and asserting it here is what makes the list a test
   * rather than a comment.
   *
   * ⚠️ It checks `delete` and NOTHING ELSE, and that gap was found by mutation rather than by
   * reading: commenting out `erase_user()`'s `UPDATE guests SET secret_hash = NULL` left all
   * 148 tests in this package and all 721 in apps/api green. `keep` and `escalated` are
   * untestable by construction — they assert an absence of action — but `scrub` is a promise
   * to write something, and a generic loop cannot check it because the treatment names a
   * foreign-key column and says nothing about which column gets scrubbed. So each `scrub`
   * needs its own named test; `guests.claimed_by_user_id` is the only one today and it is the
   * test directly below. A second `scrub` treatment added without one would reintroduce this
   * hole silently.
   */
  it('leaves no row in any table it calls delete', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'coverage');
    await close(db, subject.userId);
    await erase(db, subject.userId);

    for (const [ref, treatment] of Object.entries(ERASURE_TREATMENTS)) {
      if (treatment !== 'delete') continue;
      const [table, column] = ref.split('.');
      const remaining = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(table ?? '')} where ${sql.identifier(column ?? '')} = ${subject.userId}::uuid`,
      );
      expect(remaining.rows[0]?.n, `${ref} is declared 'delete' and still has rows`).toBe('0');
    }
  });

  /**
   * The one `scrub`, which nothing was checking.
   *
   * Mutation: comment out `UPDATE guests SET secret_hash = NULL` in `erase_user()`. Before
   * this test that mutation was silent across the whole repository.
   *
   * ── What is asserted, and what is deliberately not claimed ──────────────────────
   *
   * `secret_hash` is NULL afterwards, and the claim link — `claimed_by_user_id`,
   * `claimed_at` — survives. Both halves matter: the second is why the treatment is `scrub`
   * and not `delete`, because deleting the guest row would orphan the carts and orders that
   * point at it while proving nothing about the person.
   *
   * ⚠️ Be honest about how much this line is doing. `GuestRepository.isOpenGuest` already
   * requires `claimed_by_user_id IS NULL`, so a claimed cookie is refused by that clause
   * whether or not the secret survives — the scrub is defence in depth against a future
   * reader that forgets the claim clause, not the thing standing between a stale cookie and
   * a tombstone's cart today. That is precisely why it needs its own test: a guard whose
   * effect is currently masked by another mechanism is a guard that can be deleted by
   * refactor without any symptom at all (plan 7.14(ก) finding 6b).
   */
  it('revokes the guest cookie secret while keeping the claim link', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'guest');

    const [guest] = await db
      .insert(guests)
      .values({
        secretHash: freshDigest(),
        claimedByUserId: subject.userId,
        // `guests_claim_shape`: either both columns say the visitor was claimed or neither does.
        claimedAt: sql`now()`,
      })
      .returning({ id: guests.id });
    if (!guest) throw new Error('inserting a guest returned no row');

    await close(db, subject.userId);
    await erase(db, subject.userId);

    const [row] = await db
      .select({
        secretHash: guests.secretHash,
        claimedBy: guests.claimedByUserId,
        claimedAt: guests.claimedAt,
      })
      .from(guests)
      .where(eq(guests.id, guest.id));

    expect(row?.secretHash, 'the guest cookie is still presentable after an erasure').toBeNull();
    expect(row?.claimedBy).toBe(subject.userId);
    expect(row?.claimedAt).not.toBeNull();
  });
});

/**
 * The outbox, which is where "deletion is a status flag" stops being enough.
 *
 * ── How these two were found ────────────────────────────────────────────────────
 *
 * By exercising `erase_user()` against a booted API and a real `NotificationWorker`, not by
 * reading the function. The scrub ran, `users.status` said `erased`, every credential was
 * gone — and the worker then claimed a message queued a moment earlier and delivered it to
 * `email:erased-…@example.test`. A second event on the same order queued another one, because
 * the fan-out re-resolves the address from `orders.contact_email`, which the accounting
 * exemption keeps and `orders_submitted_has_a_contact_channel` will not let anything null.
 *
 * That is the exact failure this whole file is written against, arriving from the one
 * direction nobody had pointed a test at: the erasure reported success and a real message
 * went to a real person who had asked to be forgotten.
 *
 * ── Why the two halves are two tests ────────────────────────────────────────────
 *
 * They are enforced by two different mechanisms and either can be removed without the other
 * noticing. `erase_user()` closes what is already queued; `order_events_fan_out_notifications()`
 * closes what is queued next. A single test that erased and then appended would be green with
 * the UPDATE deleted, because the fan-out refuses anyway — plan 7.14(ก) finding 6b, which has
 * now caught this work three times.
 */
describeDb('an erased customer cannot be reached by a notification', () => {
  /** An order that belongs to `userId`, plus one spine event that fans out to the customer. */
  const orderFor = async (db: Database, userId: string, address: string): Promise<string> => {
    const orderId = randomUUID();
    const createdEvent = randomUUID();

    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('inserting a guest returned no row');

    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        statusEventId: createdEvent,
        guestId: guest.id,
        customerUserId: userId,
        contactEmail: address,
        contactName: 'สมชาย',
      });
      await tx.insert(orderEvents).values({
        id: createdEvent,
        orderId,
        eventType: 'created',
        toStatus: 'draft',
        actorKind: 'customer',
        actorUserId: userId,
      });
    });

    return orderId;
  };

  const appendEvent = async (
    db: Database,
    orderId: string,
    eventType: 'quote_revised' | 'change_resolved' | 'change_requested',
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      // The lock `order_events_seq_is_dense` expects; copied from tests/order.test.ts.
      await tx.execute(sql`select id from orders where id = ${orderId}::uuid for update`);
      await tx.insert(orderEvents).values({ id: randomUUID(), orderId, eventType, actorKind: 'system' });
    });
  };

  const customerRows = async (
    db: Database,
    orderId: string,
  ): Promise<{ status: string; recipientKey: string | null; suppressedReason: string | null }[]> => {
    const rows = await db
      .select({
        status: notifications.status,
        recipientKey: notifications.recipientKey,
        suppressedReason: notifications.suppressedReason,
      })
      .from(notifications)
      .where(eq(notifications.orderId, orderId));

    return rows.filter((row) => row.recipientKey === null || row.recipientKey.startsWith('email:'));
  };

  /**
   * Mutation: delete the `UPDATE notifications … 'recipient_erased'` block from `erase_user()`.
   *
   * With it deleted the row stays `pending` with the address on it, `claimDue` picks it up on
   * the next poll, and the message is delivered. Run, and it is how this test came to exist.
   */
  it('takes the address off every message still queued for them', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'queued');
    const orderId = await orderFor(db, subject.userId, subject.address);

    await appendEvent(db, orderId, 'quote_revised');

    const queued = await customerRows(db, orderId);
    expect(queued, 'the fixture queued no customer message, so this test proves nothing').not.toHaveLength(0);
    expect(queued.every((row) => row.status === 'pending')).toBe(true);
    expect(queued.some((row) => row.recipientKey === `email:${subject.address}`)).toBe(true);

    await close(db, subject.userId);
    await erase(db, subject.userId);

    for (const row of await customerRows(db, orderId)) {
      // The address is gone and the row is not: `notifications` is the record of what the
      // company told this customer, and deleting it would answer a PDPA request by destroying
      // the evidence that the request was honoured.
      expect(row.recipientKey, 'a queued message still carries the erased address').toBeNull();
      expect(row.status).toBe('suppressed');
      expect(row.suppressedReason).toBe('recipient_erased');
    }
  });

  /**
   * Mutation: delete the `recipient_erased` branch from
   * `order_events_fan_out_notifications()` — the row comes back `pending` with
   * `email:<address>`, resolved from `orders.contact_email`.
   *
   * This is the half that survives everything else. The account is a tombstone, every
   * credential is deleted, the queue was emptied by the test above — and the order is still
   * an accounting record carrying a real address, so the next thing that happens to it
   * addresses a person who asked to be forgotten. Nulling that column is not available:
   * `orders_submitted_has_a_contact_channel` refuses it, and it is right to.
   */
  it('refuses to address a new message to them, from an order that still holds their address', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'later');
    const orderId = await orderFor(db, subject.userId, subject.address);

    await close(db, subject.userId);
    await erase(db, subject.userId);

    await appendEvent(db, orderId, 'change_resolved');

    const rows = await customerRows(db, orderId);
    expect(rows, 'no customer message was produced at all; the fan-out did not run').not.toHaveLength(0);

    for (const row of rows) {
      expect(row.recipientKey, 'the fan-out addressed a message to an erased customer').toBeNull();
      expect(row.status).toBe('suppressed');
      expect(row.suppressedReason).toBe('recipient_erased');
    }

    // The order keeps what the accounts need. This is the point of suppressing rather than
    // scrubbing, and it is asserted so that a future change which nulls the column has to
    // come back here and say so.
    const [order] = await db
      .select({ email: orders.contactEmail, name: orders.contactName })
      .from(orders)
      .where(eq(orders.id, orderId));
    expect(order?.email).toBe(subject.address);
    expect(order?.name).toBe('สมชาย');
  });

  /**
   * The company still gets told, and that is not a caveat on the fix — it is half of it.
   *
   * An erasure that also silenced `group:sales_queue` would answer a customer's request by
   * breaking the workflow for an order the company is legally required to go on servicing,
   * and it would do it invisibly. `recipient_kind = 'customer'` in both mechanisms is what
   * keeps the two apart; mutation: drop that predicate from either and this goes red while
   * the two tests above stay green, which is the whole reason it is a separate test.
   *
   * `change_requested` is the fixture because it is the one rule addressed to the sales queue
   * and to nobody else — so a green result here cannot be a customer row in disguise.
   */
  it('does not silence the messages the company sends itself about that order', async () => {
    const db = await connect();
    const subject = await createSubject(db, 'internal');
    const orderId = await orderFor(db, subject.userId, subject.address);

    // Queued before the erasure, so `erase_user()`'s UPDATE has a chance to over-reach…
    await appendEvent(db, orderId, 'change_requested');

    await close(db, subject.userId);
    await erase(db, subject.userId);

    // …and again after it, so the fan-out's new branch has a chance to over-reach too.
    await appendEvent(db, orderId, 'change_resolved');

    const internal = await db
      .select({
        status: notifications.status,
        recipientKey: notifications.recipientKey,
        suppressedReason: notifications.suppressedReason,
      })
      .from(notifications)
      .where(eq(notifications.orderId, orderId));

    const groupRows = internal.filter((row) => row.recipientKey?.startsWith('group:') === true);
    expect(groupRows, 'no internal message to assert on — the rule set changed').not.toHaveLength(0);
    expect(
      groupRows.filter((row) => row.status !== 'pending'),
      'an erasure silenced the company’s own queue',
    ).toStrictEqual([]);

    // And the customer half of the same order is suppressed, so this test is not merely
    // observing that nothing happened at all.
    const customerHalf = internal.filter((row) => row.recipientKey?.startsWith('group:') !== true);
    expect(customerHalf, 'no customer row on this order; the control is vacuous').not.toHaveLength(0);
    expect(customerHalf.every((row) => row.suppressedReason === 'recipient_erased')).toBe(true);
  });
});

/**
 * Two connections, because one cannot express either of these.
 *
 * Both are races the design reasoned about and did not run. Over HTTP they are invisible:
 * `RbacGuard` 401s the resulting token whether or not the row got written, so an api-level
 * assertion is green either way — plan 7.14(ก) finding 6b again.
 */
describeDb('erasure against a concurrent sign-in', () => {
  /* Clients checked out of the shared pool; released together so a failure cannot strand one. */
  // Structural, not `Awaited<ReturnType<Pool['connect']>>`: pg overloads `connect`, and
  // `ReturnType` resolves the callback overload, which returns void.
  const open: { readonly release: () => void }[] = [];

  afterAll(() => {
    for (const client of open) client.release();
    open.length = 0;
  });

  /**
   * Mutation: remove `FOR SHARE` from `auth_rows_refuse_erased_user()`.
   *
   * Without it the guard's `SELECT status FROM users` takes no lock, so under READ COMMITTED
   * a sign-in that began before the erasure committed reads `active`, commits a provider
   * identity onto a row that says `erased`, and the person's Google account becomes a
   * permanent opaque dead end pointing at a tombstone.
   */
  it('makes a sign-in that started first wait, and then refuses it', async () => {
    const db = await connect();
    const pool = await connectPool();
    const subject = await createSubject(db, 'race');
    await close(db, subject.userId);

    const eraser = await pool.connect();
    const signer = await pool.connect();
    open.push(eraser, signer);

    try {
      await eraser.query('begin');
      await eraser.query(
        `select erase_user($1::uuid, null::uuid, 'self_service', 'PDPA s.33')`,
        [subject.userId],
      );

      await signer.query('begin');
      let settled = false;
      const insert = signer
        .query(`insert into provider_identities (user_id, provider, subject) values ($1, 'google', $2)`, [
          subject.userId,
          `race-${tag}`,
        ])
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled, 'the sign-in did not wait for the erasure — FOR SHARE is not taking the lock').toBe(false);

      await eraser.query('commit');
      const outcome = await insert;
      expect(errorCode(outcome), `expected the insert to be refused, got: ${String(outcome)}`).toBe(
        PG.restrictViolation,
      );
    } finally {
      await signer.query('rollback').catch(() => undefined);
      await eraser.query('rollback').catch(() => undefined);
    }
  });

  /**
   * Mutation: remove the `pg_advisory_xact_lock` from `erase_user()`.
   *
   * 0004_auth_hardening.sql reserved namespace 4919 and takes that lock on every INSERT and
   * every verification of an address, on the stated reasoning that it "serialises every
   * writer of one address". Erasure introduces DELETE as a third concurrent writer, and
   * without the lock a signup racing a release is refused for an address that no longer has
   * an owner — a self-healing spurious failure, and a comment block that covers two
   * operations out of three.
   */
  it('serialises a signup for the address it is releasing', async () => {
    const db = await connect();
    const pool = await connectPool();
    const subject = await createSubject(db, 'lock');
    await close(db, subject.userId);

    const [claimant] = await db.insert(users).values({}).returning({ id: users.id });
    if (!claimant) throw new Error('inserting a user returned no row');

    const eraser = await pool.connect();
    const signup = await pool.connect();
    open.push(eraser, signup);

    try {
      await eraser.query('begin');
      await eraser.query(
        `select erase_user($1::uuid, null::uuid, 'self_service', 'PDPA s.33')`,
        [subject.userId],
      );

      await signup.query('begin');
      let settled = false;
      const claim = signup
        .query(`insert into user_emails (user_id, address) values ($1, $2)`, [
          claimant.id,
          subject.address,
        ])
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled, 'the signup did not queue behind the release — the advisory lock is missing').toBe(false);

      await eraser.query('commit');
      // It succeeds, because by the time it wakes the address genuinely has no owner. That
      // is the point: without the lock it would have been refused for an address that was
      // already free.
      expect(await claim).toBeUndefined();
    } finally {
      await signup.query('rollback').catch(() => undefined);
      await eraser.query('rollback').catch(() => undefined);
    }
  });
});
