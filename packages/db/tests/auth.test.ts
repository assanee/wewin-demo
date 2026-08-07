import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Pool } from '../src/client.js';
import {
  authTokens,
  groupPermissions,
  groups,
  guests,
  mfaCredentials,
  mfaRecoveryCodes,
  oauthStates,
  passwordCredentials,
  permissions,
  providerIdentities,
  refreshTokens,
  sessions,
  userEmails,
  userGroups,
  userPhones,
  users,
} from '../src/schema/index.js';
import { PG, connect, connectPool, describeDb, errorCode } from './support/db.js';

/**
 * The four vulnerabilities plan section 6 names, tested where they are actually closed.
 *
 * Each block below is written so that removing the fix makes it fail — not so that it
 * passes today. That distinction is the whole point of the file: three of these four are
 * races, and a test that only exercises the happy path would keep passing after somebody
 * "simplified" the constraint into a service method with a window in it.
 *
 * No secret appears anywhere in here. Every token is random bytes hashed on the way to
 * the column, and the raw value is thrown away in the same expression that produced it —
 * which is also the shape the API has to use, so a fixture that leaked one would be
 * modelling the wrong thing.
 */

/** A digest of material that exists for one expression and is never written down. */
const freshDigest = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');

/** Distinguishes this run's rows from a previous run's leftovers. */
const tag = randomUUID().slice(0, 8);

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

const HOUR = 60 * 60 * 1000;

/** Rows this file created, torn down in one cascade at the end. */
const createdUsers: string[] = [];

const createUser = async (db: Database, name: string): Promise<string> => {
  const [row] = await db.insert(users).values({ displayName: name }).returning({ id: users.id });
  if (!row) throw new Error('could not create a user');
  createdUsers.push(row.id);
  return row.id;
};

const createSession = async (db: Database, userId: string, lifetimeMs = 30 * 24 * HOUR) => {
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt: new Date(Date.now() + lifetimeMs) })
    .returning({ id: sessions.id });
  if (!row) throw new Error('could not create a session');
  return row.id;
};

// ─────────────────────────────────────────────────────────────────────────────
// ⓐ Account pre-hijacking — plan 6(a)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('ⓐ an email address is owned by whoever proved it, and by nobody else', () => {
  let db: Database;
  let pool: Pool;

  beforeAll(async () => {
    db = await connect();
    pool = await connectPool();
  });

  it('lets the attack be *set up* — two accounts may both claim an address unverified', async () => {
    const address = `setup-${tag}@example.test`;
    const attacker = await createUser(db, 'attacker');
    const victim = await createUser(db, 'victim');

    await db.insert(userEmails).values({ userId: attacker, address });
    await db.insert(userEmails).values({ userId: victim, address });

    const rows = await db.select().from(userEmails).where(eq(userEmails.address, address));

    // Not an oversight. An unverified claim is only an assertion, and refusing to store a
    // second one would mean the first person to type an address could lock everyone else
    // out of signing up with it. What must be impossible is *acting* on one.
    expect(rows).toHaveLength(2);
  });

  it('strips the address from every unverified account when somebody proves it', async () => {
    const address = `strip-${tag}@example.test`;
    const attacker = await createUser(db, 'attacker');
    const victim = await createUser(db, 'victim');

    await db.insert(userEmails).values({ userId: attacker, address });
    const [victimEmail] = await db
      .insert(userEmails)
      .values({ userId: victim, address })
      .returning({ id: userEmails.id });
    if (!victimEmail) throw new Error('could not create the victim claim');

    await db
      .update(userEmails)
      .set({ verifiedAt: new Date() })
      .where(eq(userEmails.id, victimEmail.id));

    const survivors = await db
      .select({ userId: userEmails.userId, verifiedAt: userEmails.verifiedAt })
      .from(userEmails)
      .where(eq(userEmails.address, address));

    // One row, the victim's, verified. The attacker's claim is gone — not merged into,
    // not left beside it. This is the assertion that fails if the strip trigger is
    // dropped: without it the attacker's row survives and any lookup by address that
    // forgets to filter on `verified_at` finds two answers and picks the older one.
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.userId).toBe(victim);
    expect(survivors[0]?.verifiedAt).not.toBeNull();

    // The attacker's account still exists and is now unreachable by that address, which
    // is the intended outcome: we take the claim away, not the account.
    const attackerRows = await db
      .select()
      .from(userEmails)
      .where(eq(userEmails.userId, attacker));
    expect(attackerRows).toHaveLength(0);
  });

  it('refuses a second verified owner outright', async () => {
    const address = `owned-${tag}@example.test`;
    const first = await createUser(db, 'first');
    const second = await createUser(db, 'second');

    await db.insert(userEmails).values({ userId: first, address, verifiedAt: new Date() });

    // The provider-verified path: Google says this address is confirmed, so we would
    // create a fresh account for it. Somebody already proved it, so this must fail.
    await expectViolation(
      db.insert(userEmails).values({ userId: second, address, verifiedAt: new Date() }),
      PG.uniqueViolation,
    );
  });

  it('refuses two *simultaneous* proofs of the same address — the window a service method leaves open', async () => {
    const address = `race-${tag}@example.test`;
    const first = await createUser(db, 'first');
    const second = await createUser(db, 'second');

    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('begin');
      await b.query('begin');

      await a.query(
        'insert into user_emails (user_id, address, verified_at) values ($1, $2, now())',
        [first, address],
      );

      // B is inside its own transaction and cannot see A's uncommitted row, so a
      // SELECT-then-INSERT in application code would find nothing and proceed. The index
      // does not let it: this INSERT blocks on A's index entry rather than succeeding.
      const blocked = b
        .query('insert into user_emails (user_id, address, verified_at) values ($1, $2, now())', [
          second,
          address,
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      await a.query('commit');

      expect(errorCode(await blocked)).toBe(PG.uniqueViolation);
    } finally {
      await b.query('rollback').catch(() => undefined);
      a.release();
      b.release();
    }

    const owners = await db.select().from(userEmails).where(eq(userEmails.address, address));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(first);
  });

  it('will not un-verify, re-address or re-home a proven claim', async () => {
    const address = `final-${tag}@example.test`;
    const owner = await createUser(db, 'owner');
    const other = await createUser(db, 'other');

    const [row] = await db
      .insert(userEmails)
      .values({ userId: owner, address, verifiedAt: new Date() })
      .returning({ id: userEmails.id });
    if (!row) throw new Error('could not create the verified claim');

    await expectViolation(
      db.update(userEmails).set({ verifiedAt: null }).where(eq(userEmails.id, row.id)),
      PG.restrictViolation,
    );

    await expectViolation(
      db
        .update(userEmails)
        .set({ address: `moved-${tag}@example.test` })
        .where(eq(userEmails.id, row.id)),
      PG.restrictViolation,
    );

    await expectViolation(
      db.update(userEmails).set({ userId: other }).where(eq(userEmails.id, row.id)),
      PG.restrictViolation,
    );
  });

  it('will not make an unverified address the primary one', async () => {
    const owner = await createUser(db, 'owner');

    await expectViolation(
      db
        .insert(userEmails)
        .values({ userId: owner, address: `unproven-${tag}@example.test`, isPrimary: true }),
      PG.checkViolation,
    );
  });

  it('stores addresses lower-cased, so two spellings are one address', async () => {
    const owner = await createUser(db, 'owner');

    await expectViolation(
      db.insert(userEmails).values({ userId: owner, address: `Mixed-${tag}@Example.test` }),
      PG.checkViolation,
    );
  });

  it('treats a provider assertion as a record, not as an identity', async () => {
    const address = `asserted-${tag}@example.test`;
    const one = await createUser(db, 'google user');
    const two = await createUser(db, 'facebook user');

    // Two providers asserting the same address for two different accounts is legal here
    // and means nothing: only `user_emails` can say who owns an address. If this were
    // unique, the schema itself would be doing the merge that 6(a) forbids.
    await db.insert(providerIdentities).values({
      userId: one,
      provider: 'google',
      subject: `g-${tag}`,
      assertedEmail: address,
      assertedEmailVerified: true,
    });
    await db.insert(providerIdentities).values({
      userId: two,
      provider: 'facebook',
      subject: `f-${tag}`,
      assertedEmail: address,
      assertedEmailVerified: true,
    });

    const owners = await db.select().from(userEmails).where(eq(userEmails.address, address));
    expect(owners).toHaveLength(0);
  });

  it('gives one account per (provider, subject)', async () => {
    const one = await createUser(db, 'first');
    const two = await createUser(db, 'second');
    const subject = `line-${tag}`;

    await db.insert(providerIdentities).values({ userId: one, provider: 'line', subject });

    await expectViolation(
      db.insert(providerIdentities).values({ userId: two, provider: 'line', subject }),
      PG.uniqueViolation,
    );

    // The same string at a different provider is a different person.
    await db.insert(providerIdentities).values({ userId: two, provider: 'google', subject });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓑ OAuth state must be bound to the browser — plan 6(b)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('ⓑ a callback has to prove the browser, not just the flow', () => {
  let db: Database;

  const startFlow = async (guestId?: string) => {
    const stateHash = freshDigest();
    const bindingHash = freshDigest();

    await db.insert(oauthStates).values({
      provider: 'apple',
      stateHash,
      bindingHash,
      pkceChallenge: 'x'.repeat(43),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      ...(guestId === undefined ? {} : { guestId }),
    });

    return { stateHash, bindingHash };
  };

  /**
   * The callback, as one atomic statement.
   *
   * Both halves are in the WHERE clause and `consumed_at IS NULL` makes it single use, so
   * a replayed callback and a callback from the wrong browser are the same answer: zero
   * rows. Nothing is read and then decided upon.
   */
  const completeFlow = async (stateHash: string, bindingHash: string): Promise<number> => {
    const result = await db
      .update(oauthStates)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(oauthStates.stateHash, stateHash),
          eq(oauthStates.bindingHash, bindingHash),
          sql`${oauthStates.consumedAt} is null`,
          sql`${oauthStates.expiresAt} > now()`,
        ),
      )
      .returning({ id: oauthStates.id });

    return result.length;
  };

  beforeAll(async () => {
    db = await connect();
  });

  it('completes a flow that comes back in the browser that started it', async () => {
    const { stateHash, bindingHash } = await startFlow();
    expect(await completeFlow(stateHash, bindingHash)).toBe(1);
  });

  it('refuses a genuine state presented by a different browser — the whole of the attack', async () => {
    // The attacker starts a flow of their own and signs in as themselves. `state` is real
    // and the server row exists; the only thing they do not have is the cookie that was
    // set on the victim's browser, because it was never set there.
    const { stateHash } = await startFlow();
    const somebodyElsesCookie = freshDigest();

    expect(await completeFlow(stateHash, somebodyElsesCookie)).toBe(0);

    // And the row is still unspent, so the honest owner of the flow can still finish it.
    const [row] = await db
      .select({ consumedAt: oauthStates.consumedAt })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash));
    expect(row?.consumedAt).toBeNull();
  });

  it('refuses a replay of a completed callback', async () => {
    const { stateHash, bindingHash } = await startFlow();

    expect(await completeFlow(stateHash, bindingHash)).toBe(1);
    expect(await completeFlow(stateHash, bindingHash)).toBe(0);
  });

  it('will not let the browser half be left out', async () => {
    // `binding_hash` is NOT NULL because an optional check is fix ⓑ removed. This is the
    // assertion that fails if somebody makes the column nullable "for the providers that
    // do not need it".
    await expectViolation(
      db.execute(sql`
        insert into oauth_states (provider, state_hash, pkce_challenge, expires_at)
        values ('google', ${freshDigest()}, ${'y'.repeat(43)}, now() + interval '10 minutes')
      `),
      PG.notNullViolation,
    );
  });

  it('will not store anything a dump could replay', async () => {
    // A raw state parameter is base64url and is not 64 lower-case hex characters, so a
    // service that forgot to hash fails here, on the row that did it.
    await expectViolation(
      db.insert(oauthStates).values({
        provider: 'line',
        stateHash: 'this-is-raw-state-material'.padEnd(64, 'X'),
        bindingHash: freshDigest(),
        pkceChallenge: 'z'.repeat(43),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
      PG.checkViolation,
    );
  });

  it('will not carry the user off-site afterwards', async () => {
    for (const returnTo of ['https://evil.example/', '//evil.example/', '/\\evil.example/']) {
      await expectViolation(
        db.insert(oauthStates).values({
          provider: 'google',
          stateHash: freshDigest(),
          bindingHash: freshDigest(),
          pkceChallenge: 'q'.repeat(43),
          returnTo,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        }),
        PG.checkViolation,
      );
    }
  });

  it('carries the anonymous visitor through the flow', async () => {
    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('could not create a guest');

    const { stateHash, bindingHash } = await startFlow(guest.id);
    expect(await completeFlow(stateHash, bindingHash)).toBe(1);

    const [row] = await db
      .select({ guestId: oauthStates.guestId })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash));
    expect(row?.guestId).toBe(guest.id);

    await db.delete(guests).where(eq(guests.id, guest.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guest scope — plan section 6, "guest cart"
// ─────────────────────────────────────────────────────────────────────────────

describeDb('the anonymous visitor is a row, so the fourth scope has something to point at', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
  });

  it('exists without a user, a group or a permission', async () => {
    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('could not create a guest');

    // The whole point of plan 6's fourth scope variant: this row is a referent a cart can
    // hold a foreign key to before anybody has signed in. Nothing above is required.
    expect(guest.id).toMatch(/^[0-9a-f-]{36}$/);

    await db.delete(guests).where(eq(guests.id, guest.id));
  });

  it('is claimed by the account it turns into, and stays claimed', async () => {
    const user = await createUser(db, 'converted visitor');
    const [guest] = await db.insert(guests).values({}).returning({ id: guests.id });
    if (!guest) throw new Error('could not create a guest');

    await db
      .update(guests)
      .set({ claimedByUserId: user, claimedAt: new Date() })
      .where(eq(guests.id, guest.id));

    const [row] = await db.select().from(guests).where(eq(guests.id, guest.id));
    expect(row?.claimedByUserId).toBe(user);
    expect(row?.claimedAt).not.toBeNull();
  });

  it('cannot be half-claimed', async () => {
    const user = await createUser(db, 'half claimer');

    await expectViolation(
      db.insert(guests).values({ claimedByUserId: user }),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓒ Refresh rotation races — plan 6(c)
// ─────────────────────────────────────────────────────────────────────────────

type Rotation = {
  outcome: string;
  in_session: string | null;
  successor_id: string | null;
};

describeDb('ⓒ six panels refreshing at once is not a stolen token', () => {
  let db: Database;

  const rotate = async (
    presented: string,
    successor: string,
    graceSeconds = 15,
  ): Promise<Rotation> => {
    const result = await db.execute<Rotation>(sql`
      select outcome, in_session, successor_id
        from rotate_refresh_token(
          ${presented}::char(64),
          ${successor}::char(64),
          interval '7 days',
          make_interval(secs => ${graceSeconds})
        )
    `);

    const row = result.rows[0];
    if (!row) throw new Error('rotate_refresh_token returned no row');
    return row;
  };

  const issue = async (sessionId: string, lifetimeMs = 7 * 24 * HOUR): Promise<string> => {
    const tokenHash = freshDigest();
    await db
      .insert(refreshTokens)
      .values({ sessionId, tokenHash, expiresAt: new Date(Date.now() + lifetimeMs) });
    return tokenHash;
  };

  beforeAll(async () => {
    db = await connect();
  });

  it('rotates once and hands back a successor', async () => {
    const user = await createUser(db, 'single refresher');
    const sessionId = await createSession(db, user);
    const presented = await issue(sessionId);

    const rotation = await rotate(presented, freshDigest());

    expect(rotation.outcome).toBe('rotated');
    expect(rotation.in_session).toBe(sessionId);
    expect(rotation.successor_id).not.toBeNull();
  });

  it('gives every one of eight simultaneous refreshes a working answer', async () => {
    const user = await createUser(db, 'busy dashboard');
    const sessionId = await createSession(db, user);
    const presented = await issue(sessionId);

    // The plan's scenario, at eight panels instead of six. Separate connections out of the
    // pool, all in flight at once, all holding the token that expired a millisecond ago.
    const rotations = await Promise.all(
      Array.from({ length: 8 }, () => rotate(presented, freshDigest())),
    );

    const outcomes = rotations.map((rotation) => rotation.outcome);

    /*
     * All eight served, none accused. That is the property, and it is the one that fails
     * if the grace branch is removed from the WHERE clause: without it seven come back
     * `reused` and the user is signed out in the middle of their work, which is exactly
     * the bug plan 6(c) describes.
     *
     * The *split* between `rotated` and `graced` is deliberately not asserted, and the
     * reason is worth knowing because the obvious assertion — "1 rotated, 7 graced" — was
     * here and is a flake. The two are told apart by `RETURNING old.consumed_at`, and `old`
     * is the row as the **statement's own snapshot** saw it. A backend that blocked on the
     * row lock took its snapshot before the winner committed, so it reads NULL and is
     * labelled `rotated` even though it is precisely the racing tab the window exists for.
     * The WHERE clause is a different matter and *is* re-evaluated against the updated row,
     * which is why the window still does its job — only the label is lost. So `graced` is a
     * lower bound on races, never a count of them, and nothing may branch on it.
     */
    expect(outcomes.filter((outcome) => outcome === 'rotated' || outcome === 'graced')).toHaveLength(8);
    expect(outcomes.filter((outcome) => outcome === 'reused')).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome === 'rejected')).toHaveLength(0);

    // Every caller got a usable successor, and nobody was logged out.
    expect(rotations.every((rotation) => rotation.successor_id !== null)).toBe(true);

    const [session] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.revokedAt).toBeNull();
  });

  it('treats the same token after the window as theft, and revokes the session', async () => {
    const user = await createUser(db, 'victim of theft');
    const sessionId = await createSession(db, user);
    const presented = await issue(sessionId);

    expect((await rotate(presented, freshDigest())).outcome).toBe('rotated');

    // A grace of zero is the window having closed — the same statement, minus the excuse.
    const late = await rotate(presented, freshDigest(), 0);
    expect(late.outcome).toBe('reused');
    expect(late.successor_id).toBeNull();

    const [session] = await db
      .select({ revokedAt: sessions.revokedAt, reason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.reason).toBe('refresh_reuse');

    // The revocation reached the rows the refresh path reads, without the caller doing it.
    const live = await db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.sessionId, sessionId), sql`${refreshTokens.revokedAt} is null`));
    expect(live).toHaveLength(0);
  });

  it('separates an unknown or expired token from a stolen one', async () => {
    const unknown = await rotate(freshDigest(), freshDigest());
    expect(unknown.outcome).toBe('rejected');

    const user = await createUser(db, 'lapsed');
    const sessionId = await createSession(db, user);
    const tokenHash = freshDigest();
    // Issued in the past and already expired. Nothing suspicious happened; the user has
    // simply been away too long, and revoking the session over it would be a false alarm.
    await db.execute(sql`
      insert into refresh_tokens (session_id, token_hash, issued_at, expires_at)
      values (${sessionId}, ${tokenHash}, now() - interval '8 days', now() - interval '1 day')
    `);

    expect((await rotate(tokenHash, freshDigest())).outcome).toBe('rejected');

    const [session] = await db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.revokedAt).toBeNull();
  });

  it('refuses to re-date a consumption', async () => {
    const user = await createUser(db, 'rewriter');
    const sessionId = await createSession(db, user);
    const presented = await issue(sessionId);

    await rotate(presented, freshDigest());

    // Write-once is what makes the claim a single UPDATE. If `consumed_at` could be
    // rewritten, a second caller could take the token back and the WHERE clause would
    // stop being the mutual exclusion.
    await expectViolation(
      db
        .update(refreshTokens)
        .set({ consumedAt: new Date(Date.now() + 60_000) })
        .where(eq(refreshTokens.tokenHash, presented)),
      PG.restrictViolation,
    );
  });

  it('keeps a refresh token inside the life of its session', async () => {
    const user = await createUser(db, 'over-eager');
    const sessionId = await createSession(db, user, 2 * HOUR);

    // The invariant that lets the rotation statement read session state off the token row
    // instead of joining. Break it and the hot path silently starts accepting tokens for
    // sessions that ended.
    await expectViolation(
      db.insert(refreshTokens).values({
        sessionId,
        tokenHash: freshDigest(),
        expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
      }),
      PG.restrictViolation,
    );
  });

  it('clamps a successor to the session rather than failing the refresh', async () => {
    const user = await createUser(db, 'near the end');
    const sessionId = await createSession(db, user, 2 * HOUR);
    const presented = await issue(sessionId, HOUR);

    const rotation = await rotate(presented, freshDigest());
    expect(rotation.outcome).toBe('rotated');

    const [session] = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const successorId = rotation.successor_id;
    if (successorId === null) throw new Error('a rotation returned no successor');

    const [successor] = await db
      .select({ expiresAt: refreshTokens.expiresAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.id, successorId));

    expect(successor?.expiresAt.getTime()).toBe(session?.expiresAt.getTime());
  });

  it('will not store anything a dump could replay', async () => {
    const user = await createUser(db, 'raw token');
    const sessionId = await createSession(db, user);

    await expectViolation(
      db.insert(refreshTokens).values({
        sessionId,
        // 64 characters and not a digest — what a base64url token looks like when a
        // service passes it straight through instead of hashing it.
        tokenHash: 'this-is-raw-token-material'.padEnd(64, 'X'),
        expiresAt: new Date(Date.now() + HOUR),
      }),
      PG.checkViolation,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓓ Permissions survive a rollback — plan 6(d)
// ─────────────────────────────────────────────────────────────────────────────

describeDb('ⓓ a permission is named, so rolling back cannot renumber it', () => {
  let db: Database;

  const known = [
    { code: `orders_${tag}.read`, description: 'read orders' },
    { code: `orders_${tag}.refund`, description: 'refund an order' },
  ];
  /** What release N+1 added and the rollback to N has never heard of. */
  const addedLater = { code: `orders_${tag}.export`, description: 'added by the next release' };

  let groupId: string;

  /** The boot-time upsert from plan 6(d): forward only, idempotent, one statement. */
  const upsertKnownPermissions = () =>
    db
      .insert(permissions)
      .values(known)
      .onConflictDoUpdate({
        target: permissions.code,
        set: { description: sql`excluded.description` },
      });

  beforeAll(async () => {
    db = await connect();
    await db.delete(permissions).where(
      inArray(
        permissions.code,
        [...known.map((permission) => permission.code), addedLater.code],
      ),
    );

    const [group] = await db
      .insert(groups)
      .values({ code: `sales_${tag}`, nameTh: 'ฝ่ายขาย' })
      .returning({ id: groups.id });
    if (!group) throw new Error('could not create a group');
    groupId = group.id;
  });

  afterAll(async () => {
    await db.delete(groups).where(eq(groups.id, groupId));
    await db.delete(permissions).where(
      inArray(
        permissions.code,
        [...known.map((permission) => permission.code), addedLater.code],
      ),
    );
  });

  it('keys a permission by its code and nothing else', async () => {
    // The assertion that fails the day somebody adds a surrogate `id serial`. A grant
    // stores what it points at; if that were a generated number, re-seeding this table on
    // a rolled-back release would renumber it and every grant would quietly mean
    // something else.
    const key = await db.execute<{ column_name: string }>(sql`
      select kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
       where tc.table_schema = 'public'
         and tc.table_name = 'permissions'
         and tc.constraint_type = 'PRIMARY KEY'
    `);
    expect(key.rows.map((row) => row.column_name)).toEqual(['code']);

    const generated = await db.execute<{ column_name: string }>(sql`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'permissions'
         and (is_identity = 'YES' or column_default like 'nextval%')
    `);
    expect(generated.rows).toEqual([]);

    const reference = await db.execute<{ column_name: string }>(sql`
      select kcu.column_name
        from information_schema.referential_constraints rc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = rc.unique_constraint_name
       where rc.constraint_name = 'group_permissions_permission_code_permissions_code_fk'
    `);
    expect(reference.rows.map((row) => row.column_name)).toEqual(['code']);
  });

  it('upserts what is missing at boot, twice over, without disturbing a grant', async () => {
    await upsertKnownPermissions();

    const first = known[0];
    if (!first) throw new Error('the known permission list is empty');
    await db.insert(groupPermissions).values({ groupId, permissionCode: first.code });

    // Booting again — the same binary, or the one after it — must be a no-op on the
    // grants. `ON CONFLICT (code)` is what makes that a single statement, and the code
    // being the key is what makes the conflict resolvable at all.
    await upsertKnownPermissions();

    const grants = await db
      .select({ code: groupPermissions.permissionCode })
      .from(groupPermissions)
      .where(eq(groupPermissions.groupId, groupId));
    expect(grants.map((grant) => grant.code)).toEqual([first.code]);
  });

  it('boots against a database that knows more than the binary does', async () => {
    // Release N+1 added a permission; we are release N, rolled back, and have never heard
    // of it. Nothing here fails — that is the whole requirement. The strict comparison
    // belongs in CI, where it fails a pull request instead of a deploy.
    await db.insert(permissions).values(addedLater);
    await db.insert(groupPermissions).values({ groupId, permissionCode: addedLater.code });

    await expect(upsertKnownPermissions()).resolves.not.toThrow();

    const rows = await db
      .select({ code: permissions.code })
      .from(permissions)
      .where(eq(permissions.code, addedLater.code));
    expect(rows).toHaveLength(1);
  });

  it('refuses to drop a permission somebody is still granted', async () => {
    // The other direction of "extra in the database → warn, do not delete": if a tidy-up
    // ever tries, the grants that depend on it stop it rather than losing silently.
    await expectViolation(
      db.delete(permissions).where(eq(permissions.code, addedLater.code)),
      PG.restrictViolation,
    );
  });

  it('rejects a code that is not resource.action', async () => {
    await expectViolation(
      db.insert(permissions).values({ code: 'Orders.Read', description: 'shouting' }),
      PG.checkViolation,
    );
    await expectViolation(
      db.insert(permissions).values({ code: 'orders', description: 'no action' }),
      PG.checkViolation,
    );
  });

  it('will not let a system group be tidied away', async () => {
    const [system] = await db
      .insert(groups)
      .values({ code: `admin_${tag}`, nameTh: 'ผู้ดูแลระบบ', isSystem: true })
      .returning({ id: groups.id });
    if (!system) throw new Error('could not create the system group');

    await expectViolation(
      db.delete(groups).where(eq(groups.id, system.id)),
      PG.restrictViolation,
    );

    await db.update(groups).set({ isSystem: false }).where(eq(groups.id, system.id));
    await db.delete(groups).where(eq(groups.id, system.id));
  });

  it('reaches a permission from a user through exactly one path', async () => {
    const user = await createUser(db, 'sales person');
    await db.insert(userGroups).values({ userId: user, groupId });

    const first = known[0];
    if (!first) throw new Error('the known permission list is empty');

    const held = await db
      .select({ code: groupPermissions.permissionCode })
      .from(userGroups)
      .innerJoin(groupPermissions, eq(groupPermissions.groupId, userGroups.groupId))
      .where(eq(userGroups.userId, user));

    // One join, one answer, and no second table granting straight to a user — so "why can
    // this person refund?" has an answer a support conversation can reach.
    expect(held.map((row) => row.code).sort()).toEqual(
      [first.code, addedLater.code].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stored secrets
// ─────────────────────────────────────────────────────────────────────────────

describeDb('nothing in a dump of this database can be replayed', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
  });

  /*
   * Every user this file created, in one cascade. It lives in the last suite of the file
   * rather than at file level because the shared pool is closed by an `afterAll` this
   * module registered at import time, and a suite hook is guaranteed to run before it.
   */
  afterAll(async () => {
    if (createdUsers.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
  });

  it('holds every token as a SHA-256 digest and refuses anything else', async () => {
    const columns = await db.execute<{
      table_name: string;
      data_type: string;
      character_maximum_length: number;
    }>(sql`
      select table_name, data_type, character_maximum_length
        from information_schema.columns
       where table_schema = 'public'
         and column_name in ('token_hash', 'state_hash', 'binding_hash')
       order by table_name
    `);

    expect(columns.rows).toHaveLength(4);
    for (const column of columns.rows) {
      expect(column.data_type).toBe('character');
      expect(column.character_maximum_length).toBe(64);
    }
  });

  it('rejects a password that was not put through argon2id', async () => {
    const user = await createUser(db, 'plaintext');

    for (const passwordHash of [
      'hunter2',
      '$2b$12$abcdefghijklmnopqrstuv',
      createHash('sha256').update('hunter2').digest('hex'),
    ]) {
      await expectViolation(
        db.insert(passwordCredentials).values({ userId: user, passwordHash }),
        PG.checkViolation,
      );
    }

    // The shape it does accept carries its own parameters, so raising the cost factor
    // next year is a re-hash on next login and not a migration.
    await db.insert(passwordCredentials).values({
      userId: user,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$0000000000000000000000',
    });
  });

  it('keeps an email link single-use and pointed at one address', async () => {
    const user = await createUser(db, 'link holder');
    const [email] = await db
      .insert(userEmails)
      .values({ userId: user, address: `link-${tag}@example.test` })
      .returning({ id: userEmails.id });
    if (!email) throw new Error('could not create the email claim');

    const tokenHash = freshDigest();
    await db.insert(authTokens).values({
      purpose: 'email_verification',
      userId: user,
      userEmailId: email.id,
      tokenHash,
      expiresAt: new Date(Date.now() + HOUR),
    });

    const claim = () =>
      db
        .update(authTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(authTokens.tokenHash, tokenHash), sql`${authTokens.consumedAt} is null`))
        .returning({ id: authTokens.id });

    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);

    // And a second attempt that tries to overwrite the stamp instead of respecting it.
    await expectViolation(
      db
        .update(authTokens)
        .set({ consumedAt: new Date(Date.now() + 1000) })
        .where(eq(authTokens.tokenHash, tokenHash)),
      PG.restrictViolation,
    );
  });

  it('will not aim a password reset at an address', async () => {
    const user = await createUser(db, 'resetter');
    const [email] = await db
      .insert(userEmails)
      .values({ userId: user, address: `reset-${tag}@example.test` })
      .returning({ id: userEmails.id });
    if (!email) throw new Error('could not create the email claim');

    await expectViolation(
      db.insert(authTokens).values({
        purpose: 'password_reset',
        userId: user,
        userEmailId: email.id,
        tokenHash: freshDigest(),
        expiresAt: new Date(Date.now() + HOUR),
      }),
      PG.checkViolation,
    );
  });

  it('erases everything an account touched in one delete', async () => {
    const user = await createUser(db, 'to be erased');
    const sessionId = await createSession(db, user);
    await db.insert(refreshTokens).values({
      sessionId,
      tokenHash: freshDigest(),
      expiresAt: new Date(Date.now() + HOUR),
    });
    await db
      .insert(userEmails)
      .values({ userId: user, address: `erase-${tag}@example.test` });
    await db
      .insert(providerIdentities)
      .values({ userId: user, provider: 'line', subject: `erase-${tag}` });

    await db.delete(users).where(eq(users.id, user));

    const leftovers = await db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.sessionId, sessionId));
    expect(leftovers).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓔ A gate that is up must have a way through it
// ─────────────────────────────────────────────────────────────────────────────

describeDb('ⓔ a second factor cannot be enabled without a way past it', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
  });

  /**
   * ⭐ This became load-bearing the day the recovery codes moved to **confirm**.
   *
   * While the codes were issued at `begin`, they were already in the table long before
   * anything set `confirmed_at`, and this trigger could only ever pass. Now one method
   * writes both, in one transaction, in one order — and the failure it is guarding
   * against is no longer hypothetical: a reordering, an early `return`, or a caught
   * exception between the two statements leaves a person behind a factor they cannot
   * satisfy and cannot turn off, on an account nobody can reach to fix it.
   *
   * Which is why the check lives in the database and not in `MfaEnrolmentService`. The
   * service is one caller. A migration, a support script, or the next service to be
   * written is another, and none of them can get past this.
   */
  it('⭐ refuses to confirm a credential that has no recovery codes', async () => {
    const user = await createUser(db, 'enrolling with no way back');

    await expectViolation(
      db.insert(mfaCredentials).values({
        userId: user,
        secretSealed: `v1.${randomBytes(48).toString('base64url')}`,
        confirmedAt: new Date(),
      }),
      PG.restrictViolation,
    );
  });

  it('⚠️ refuses on one code as firmly as on none', async () => {
    /*
     * The off-by-one worth spending a test on. A single code is a way through that is
     * spent the first time it is used — after which the account is in exactly the state
     * the rule above exists to prevent, only a day later and with nothing to point at.
     */
    const user = await createUser(db, 'enrolling with one code');
    await db.insert(mfaRecoveryCodes).values({ userId: user, codeHash: freshDigest() });

    await expectViolation(
      db.insert(mfaCredentials).values({
        userId: user,
        secretSealed: `v1.${randomBytes(48).toString('base64url')}`,
        confirmedAt: new Date(),
      }),
      PG.restrictViolation,
    );
  });

  it('⚠️ does not count a code that has already been spent', async () => {
    /*
     * `used_at IS NULL` in the trigger, not `count(*)`. Ten redeemed codes are ten rows
     * and zero ways in, and a regeneration that failed halfway would otherwise look
     * exactly like a healthy account.
     */
    const user = await createUser(db, 'enrolling on spent codes');
    await db.insert(mfaRecoveryCodes).values([
      { userId: user, codeHash: freshDigest(), usedAt: new Date() },
      { userId: user, codeHash: freshDigest(), usedAt: new Date() },
    ]);

    await expectViolation(
      db.insert(mfaCredentials).values({
        userId: user,
        secretSealed: `v1.${randomBytes(48).toString('base64url')}`,
        confirmedAt: new Date(),
      }),
      PG.restrictViolation,
    );
  });

  it('lets an enrolment begin with no codes at all — the gate is not up yet', async () => {
    /*
     * The other half, and the reason the trigger tests `confirmed_at` rather than simply
     * existing. `begin` writes a sealed secret and nothing else; refusing that would make
     * the new order impossible to implement.
     */
    const user = await createUser(db, 'merely enrolling');

    await db.insert(mfaCredentials).values({
      userId: user,
      secretSealed: `v1.${randomBytes(48).toString('base64url')}`,
    });

    const [row] = await db
      .select({ confirmedAt: mfaCredentials.confirmedAt })
      .from(mfaCredentials)
      .where(eq(mfaCredentials.userId, user));

    expect(row?.confirmedAt).toBeNull();
  });

  it('confirms once the codes are there', async () => {
    const user = await createUser(db, 'enrolling properly');
    await db.insert(mfaRecoveryCodes).values(
      Array.from({ length: 10 }, () => ({ userId: user, codeHash: freshDigest() })),
    );

    await db.insert(mfaCredentials).values({
      userId: user,
      secretSealed: `v1.${randomBytes(48).toString('base64url')}`,
      confirmedAt: new Date(),
    });

    const [row] = await db
      .select({ confirmedAt: mfaCredentials.confirmedAt })
      .from(mfaCredentials)
      .where(eq(mfaCredentials.userId, user));

    expect(row?.confirmedAt).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⓕ A telephone number is an identity, on the same terms an address is
// ─────────────────────────────────────────────────────────────────────────────

describeDb('ⓕ a number is owned by whoever proved it, and by nobody else', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
  });

  /**
   * ⭐ Block ⓐ, re-run against `user_phones`.
   *
   * Plan 6(a) does not care which field carries the identity, so this block is deliberately
   * the same four tests one field over. Copying them rather than parameterising is the point:
   * if somebody adds a third identity kind, the way to find out what it owes is to read what
   * these two have in common, and a shared helper would hide it.
   *
   * ⚠️ The new failure mode, which addresses do not have: **one telephone has several
   * spellings.** `081-234-5678` and `+66 81 234 5678` are the same number, and the unique
   * index compares bytes — so the canonical form is not tidiness, it is the thing that makes
   * the index mean anything. That is what `user_phones_number_e164` refuses to let go wrong.
   */
  const number = (tail: string): string => `+66811${tail}`;

  it('lets the attack be *set up* — two accounts may both claim a number unverified', async () => {
    const claimed = number('00001');
    const attacker = await createUser(db, 'phone attacker');
    const victim = await createUser(db, 'phone victim');

    await db.insert(userPhones).values({ userId: attacker, number: claimed });
    await db.insert(userPhones).values({ userId: victim, number: claimed });

    // Not an oversight, and the same reasoning as for addresses: refusing the second claim
    // would let the first person to type a number lock everyone else out of using it. What
    // must be impossible is *acting* on one.
    const rows = await db.select().from(userPhones).where(eq(userPhones.number, claimed));
    expect(rows).toHaveLength(2);
  });

  it('⭐ strips the number from every unverified account when somebody proves it', async () => {
    const claimed = number('00002');
    const attacker = await createUser(db, 'phone attacker');
    const victim = await createUser(db, 'phone victim');

    await db.insert(userPhones).values({ userId: attacker, number: claimed });
    const [victimPhone] = await db
      .insert(userPhones)
      .values({ userId: victim, number: claimed })
      .returning({ id: userPhones.id });
    if (!victimPhone) throw new Error('could not create the victim claim');

    await db
      .update(userPhones)
      .set({ verifiedAt: new Date() })
      .where(eq(userPhones.id, victimPhone.id));

    const survivors = await db
      .select({ userId: userPhones.userId, verifiedAt: userPhones.verifiedAt })
      .from(userPhones)
      .where(eq(userPhones.number, claimed));

    // MUTATION: `DROP TRIGGER user_phones_strip_unverified ON user_phones` — the attacker's
    // row survives, and a lookup that forgets `verified_at` finds two answers.
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.userId).toBe(victim);
    expect(survivors[0]?.verifiedAt).not.toBeNull();
  });

  it('refuses a second verified owner outright', async () => {
    const claimed = number('00003');
    const first = await createUser(db, 'phone first');
    const second = await createUser(db, 'phone second');

    await db.insert(userPhones).values({ userId: first, number: claimed, verifiedAt: new Date() });

    await expectViolation(
      db.insert(userPhones).values({ userId: second, number: claimed, verifiedAt: new Date() }),
      PG.uniqueViolation,
    );
  });

  it('⚠️ refuses to un-verify, so a proven number cannot be quietly re-claimed', async () => {
    const claimed = number('00004');
    const user = await createUser(db, 'phone owner');
    const [row] = await db
      .insert(userPhones)
      .values({ userId: user, number: claimed, verifiedAt: new Date() })
      .returning({ id: userPhones.id });
    if (!row) throw new Error('could not create the phone');

    await expectViolation(
      db.update(userPhones).set({ verifiedAt: null }).where(eq(userPhones.id, row.id)),
      PG.restrictViolation,
    );
    await expectViolation(
      db.update(userPhones).set({ number: number('00099') }).where(eq(userPhones.id, row.id)),
      PG.restrictViolation,
    );
  });

  it('⭐ refuses a number that is not already canonical', async () => {
    /*
     * The constraint addresses do not need. `@wewin/core/phone` produces `+66812345678` and
     * nothing else; a row written by a script, a migration or psql must obey the same rule,
     * or the unique index above stops meaning "one owner per telephone" and starts meaning
     * "one owner per way of writing a telephone".
     */
    const user = await createUser(db, 'phone spellings');

    for (const written of ['0812345678', '081-234-5678', '+66 81 234 5678', '66812345678']) {
      await expectViolation(
        db.insert(userPhones).values({ userId: user, number: written }),
        PG.checkViolation,
      );
    }
  });

  it('⚠️ refuses a primary number that nobody has proved', async () => {
    const user = await createUser(db, 'phone primary');

    await expectViolation(
      db.insert(userPhones).values({ userId: user, number: number('00005'), isPrimary: true }),
      PG.checkViolation,
    );
  });

  it('⚠️ refuses a voucher on a number with no verification', async () => {
    /*
     * `verified_by_user_id` says "a member of staff asserted this". Set without
     * `verified_at`, it is a half-finished write that reads as an endorsement of nothing.
     */
    const user = await createUser(db, 'phone vouchee');
    const staff = await createUser(db, 'phone voucher');

    await expectViolation(
      db.insert(userPhones).values({ userId: user, number: number('00006'), verifiedByUserId: staff }),
      PG.checkViolation,
    );
  });

  it('records who vouched, since it is a person and not a code', async () => {
    /*
     * Until an OTP exists, verification is a member of staff on the telephone. That is a
     * weaker proof than possession of the handset and the row says which kind it was: a
     * non-null voucher means a human asserted it.
     */
    const user = await createUser(db, 'phone vouchee');
    const staff = await createUser(db, 'phone voucher');

    await db.insert(userPhones).values({
      userId: user,
      number: number('00007'),
      verifiedAt: new Date(),
      verifiedByUserId: staff,
    });

    const [row] = await db
      .select({ by: userPhones.verifiedByUserId })
      .from(userPhones)
      .where(eq(userPhones.userId, user));

    expect(row?.by).toBe(staff);
  });
});
