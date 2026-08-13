import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { hashPassword } from '../../src/auth/password/password-hash';
import { AccessTokenService } from '../../src/auth/session/access-token';
import {
  bootLifecycleApp,
  client,
  lifecycleEnv,
  makeActor,
  type Actor,
  type LifecycleApp,
} from '../orders/support/lifecycle-app';

/**
 * A person's own account settings, over real HTTP.
 *
 * `credentials.test.ts` states the "always one way in" rule against pure functions. This
 * file answers what a fake cannot: whether the *counts* feeding it are read correctly — a
 * password row, a provider row, and a **verified** address are three different queries, and
 * the third is the one an implementation forgets, because an unverified address looks like
 * an address.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/**
 * One row of `phones` on `AccountWire`, as the profile tab reads it.
 *
 * ⚠️ Spelled out here rather than inlined per assertion so that a field *renamed* on the wire is
 * one compile error instead of three tests silently asserting `undefined === undefined`.
 */
interface PhoneRow {
  readonly number: string;
  readonly isPrimary: boolean;
  readonly verifiedAt: string | null;
  readonly verifiedByStaff: boolean;
}

const PASSWORD = 'รหัสผ่านเดิมที่ยาวพอสำหรับกฎ';
const NEW_PASSWORD = 'รหัสผ่านใหม่ที่ยาวพอเช่นกัน';

describeWithPg('my own account', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /** An actor with the credentials asked for. Returns the actor and its verified address. */
  const person = async (
    who: string,
    options: {
      readonly password?: boolean;
      readonly providers?: readonly string[];
      readonly verifiedEmail?: boolean;
    } = {},
  ): Promise<{ actor: Actor; address: string }> => {
    const actor = await makeActor(db, app, `account ${who} ${tag}`, []);
    const address = `acct-${who}-${tag}@probe.invalid`;
    const verified = options.verifiedEmail !== false;

    await db.execute(sql`
      insert into user_emails (user_id, address, is_primary, verified_at)
      values (${actor.userId}::uuid, ${address}, ${verified}, ${verified ? sql`now()` : sql`null`})
    `);

    if (options.password === true) {
      await db.execute(sql`
        insert into password_credentials (user_id, password_hash)
        values (${actor.userId}::uuid, ${await hashPassword(PASSWORD)})
      `);
    }

    for (const provider of options.providers ?? []) {
      await db.execute(sql`
        insert into provider_identities (user_id, provider, subject, asserted_email, asserted_email_verified)
        values (${actor.userId}::uuid, ${provider}, ${`${provider}-${who}-${tag}`}, ${address}, true)
      `);
    }

    return { actor, address };
  };

  const overview = async (actor: Actor) => call('GET', '/me/account', { token: actor.token });

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  it('shows the addresses, providers and the count of ways in', async () => {
    const { actor } = await person('overview', { password: true, providers: ['google'] });

    const answer = await overview(actor);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const body = answer.body as {
      hasPassword: boolean;
      providers: { provider: string }[];
      waysIn: number;
      emails: unknown[];
    };
    expect(body.hasPassword).toBe(true);
    expect(body.providers.map((row) => row.provider)).toEqual(['google']);
    expect(body.emails).toHaveLength(1);
    expect(body.waysIn).toBe(2);
  });

  it('⚠️ counts a password with no verified address as no way in', async () => {
    /*
     * ⭐ The case a fake cannot construct honestly and an implementation forgets. The
     * password signs them in *today* — so `hasPassword` is true and the screen looks fine —
     * but forget it and the reset link has nowhere to go. `waysIn` is the number the unlink
     * guard reads, so getting this wrong is what lets somebody unlink their last provider.
     */
    const { actor } = await person('nomail', { password: true, verifiedEmail: false });

    const body = (await overview(actor)).body as { hasPassword: boolean; waysIn: number };
    expect(body.hasPassword).toBe(true);
    expect(body.waysIn).toBe(0);
  });

  it('never lists an unverified address as one of mine', async () => {
    const { actor } = await person('unverified', { password: true, verifiedEmail: false });
    expect((( await overview(actor)).body as { emails: unknown[] }).emails).toHaveLength(0);
  });

  it('⭐ shows a phone even though nobody has verified it', async () => {
    /*
     * The opposite rule from the address above, and deliberately so: `RegistrationService`
     * leaves every self-registered number with `verified_at` null, so filtering to verified
     * rows the way `emails` does would answer "no phone" for almost every customer who ever
     * signs up the only way this storefront offers. `isPrimary` stays false here for the
     * same reason — the schema refuses it any other way for an unverified row.
     */
    const { actor } = await person('phone', { password: true });
    await db.execute(sql`
      insert into user_phones (user_id, number) values (${actor.userId}::uuid, '+66811111111')
    `);

    const body = (await overview(actor)).body as { phones: PhoneRow[] };
    expect(body.phones).toEqual([
      /*
       * ⭐ `verifiedAt` and `verifiedByStaff` are on this wire as of the profile-tab round, and
       * this row is the reason: a self-registered number is a *claim*, and the storefront now
       * shows it back to its owner with a word beside it. Before these two fields the only
       * verification signal here was `isPrimary`, which the screen would have had to read as
       * "verified" — sound for the primary number and wrong for every verified number that is
       * not primary. See `PhoneWire`.
       */
      { number: '+66811111111', isPrimary: false, verifiedAt: null, verifiedByStaff: false },
    ]);
  });

  it('⭐ says a staff-verified number was verified by staff, without naming the staff member', async () => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * The distinction `user_phones.verified_by_user_id` exists to carry.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * Its schema comment asks that "a reader of this row should be able to tell the two apart"
     * — a member of staff asserting a number over the telephone, versus possession proved
     * directly by an OTP. This wire carries that as a boolean, so the customer's own screen can
     * say which happened.
     *
     * ⚠️ **And the assertion that the id is absent is the one that matters.** `/admin/users`
     * carries `verifiedByUserId` for a staff reader who may see it; this endpoint answers the
     * customer whose number it is, and a staff member's user UUID is not theirs to receive.
     *
     * There is a second reason, found while writing this: `ERASURE_TREATMENTS` declares
     * `'user_phones.verified_by_user_id': 'scrub'`, but no version of `erase_user()` contains
     * the statement, and `erasure.test.ts`'s generic loop only checks the `delete` treatments.
     * So that id can outlive the erasure that promised to remove it. A boolean cannot: "a person
     * vouched" is the part of the column erasure is entitled to keep.
     */
    const { actor } = await person('vouched', { password: true });
    const staff = await makeActor(db, app, `account voucher ${tag}`, []);

    await db.execute(sql`
      insert into user_phones (user_id, number, verified_at, verified_by_user_id, is_primary)
      values (${actor.userId}::uuid, '+66833333333', now(), ${staff.userId}::uuid, true)
    `);

    const answer = await overview(actor);
    const phones = (answer.body as { phones: PhoneRow[] }).phones;

    expect(phones).toHaveLength(1);
    expect(phones[0]?.number).toBe('+66833333333');
    expect(phones[0]?.verifiedAt).toBeTypeOf('string');
    expect(phones[0]?.verifiedByStaff).toBe(true);

    // The id itself, in any spelling, must not be anywhere in the response.
    const raw = JSON.stringify(answer.body);
    expect(raw).not.toContain(staff.userId);
    expect(raw).not.toContain('verifiedByUserId');
    expect(raw).not.toContain('verified_by_user_id');
  });

  it('answers no phones for an account that never claimed one', async () => {
    const { actor } = await person('nophone', { password: true });
    expect((( await overview(actor)).body as { phones: unknown[] }).phones).toEqual([]);
  });

  it('⭐⭐ answers with the caller’s own row and never another account’s', async () => {
    /*
     * ─────────────────────────────────────────────────────────────────────────
     * ⭐ The assertion the profile tab rests on.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * The storefront's `ข้อมูลผู้ใช้งาน` tab renders whatever this endpoint returns: a name, a
     * telephone number, an email address. If the scoping were ever wrong, the failure is not a
     * blank screen — it is one customer being shown another customer's name and number, on a
     * page that looks entirely normal.
     *
     * ⚠️ **Two people with everything different**, asserted in both directions rather than one.
     * A one-directional check ("A sees A's number") passes against an implementation that
     * returns *every* row, which is exactly the bug a `WHERE user_id = …` omitted from one of
     * the four sub-queries would produce. So each half asserts both what is present and what is
     * absent.
     *
     * ⚠️ `overview` is scoped by construction rather than by a filter — the id comes from the
     * verified access token and there is no path segment, body field or query parameter on this
     * route that names a user. The last two expectations are about that: an id offered in the
     * URL must not be read, in either shape a client might try.
     */
    const alice = await person('own-alice', { password: true });
    const bob = await person('own-bob', { password: true });

    await db.execute(sql`
      insert into user_phones (user_id, number) values (${alice.actor.userId}::uuid, '+66844444444')
    `);
    await db.execute(sql`
      insert into user_phones (user_id, number) values (${bob.actor.userId}::uuid, '+66855555555')
    `);

    const seen = async (actor: Actor): Promise<string> => JSON.stringify((await overview(actor)).body);

    const asAlice = await seen(alice.actor);
    const asBob = await seen(bob.actor);

    /* Alice sees Alice: her id, her number, her address — and none of Bob's. */
    expect(asAlice).toContain(alice.actor.userId);
    expect(asAlice).toContain('+66844444444');
    expect(asAlice).toContain(alice.address);
    expect(asAlice).not.toContain(bob.actor.userId);
    expect(asAlice).not.toContain('+66855555555');
    expect(asAlice).not.toContain(bob.address);

    /* And the same in the other direction, which is what makes "own row" mean one row. */
    expect(asBob).toContain(bob.actor.userId);
    expect(asBob).toContain('+66855555555');
    expect(asBob).toContain(bob.address);
    expect(asBob).not.toContain(alice.actor.userId);
    expect(asBob).not.toContain('+66844444444');
    expect(asBob).not.toContain(alice.address);

    /*
     * ⭐ There is no id to offer. A path segment is a route that does not exist, and a query
     * parameter is read by nothing — both must answer about Alice, or not at all.
     */
    const byPath = await call('GET', `/me/account/${bob.actor.userId}`, { token: alice.actor.token });
    expect(byPath.status, JSON.stringify(byPath.body)).toBe(404);

    const byQuery = await call('GET', `/me/account?userId=${bob.actor.userId}`, {
      token: alice.actor.token,
    });
    expect(byQuery.status).toBe(200);
    expect(JSON.stringify(byQuery.body)).not.toContain(bob.actor.userId);
    expect(JSON.stringify(byQuery.body)).toContain(alice.actor.userId);
  });

  it('refuses a caller with no session at all', async () => {
    expect((await call('GET', '/me/account', {})).status).toBe(401);
  });

  /* ---------------------------------------------------------------- *
   * ⭐ Never leaving somebody outside
   * ---------------------------------------------------------------- */

  it('refuses to unlink the only provider when there is no password', async () => {
    const { actor } = await person('googleonly', { providers: ['google'] });

    const attempt = await call('DELETE', '/me/account/providers/google', { token: actor.token });
    expect(attempt.status).toBe(409);
    expect((attempt.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'last-way-in',
    );

    // And nothing was removed on the way to refusing.
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from provider_identities where user_id = ${actor.userId}::uuid
    `);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('allows unlinking when a resettable password remains', async () => {
    const { actor } = await person('both', { password: true, providers: ['google'] });

    const removed = await call('DELETE', '/me/account/providers/google', { token: actor.token });
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
  });

  it('allows unlinking when another provider remains', async () => {
    const { actor } = await person('two', { providers: ['google', 'line'] });
    expect((await call('DELETE', '/me/account/providers/line', { token: actor.token })).status).toBe(204);
  });

  it('⭐ refuses when the remaining password could never be reset', async () => {
    // A password *and* a provider, but no verified address — so the provider is the only
    // real way back. "You still have a password" is the answer that would be wrong here.
    const { actor } = await person('trap', {
      password: true,
      providers: ['google'],
      verifiedEmail: false,
    });

    const attempt = await call('DELETE', '/me/account/providers/google', { token: actor.token });
    expect(attempt.status).toBe(409);
  });

  it('answers 404 for a provider that was never linked', async () => {
    const { actor } = await person('nolink', { password: true });
    expect((await call('DELETE', '/me/account/providers/apple', { token: actor.token })).status).toBe(404);
  });

  /* ---------------------------------------------------------------- *
   * Changing my own password
   * ---------------------------------------------------------------- */

  it('changes it when the current one is right', async () => {
    const { actor, address } = await person('change', { password: true });

    const changed = await call('POST', '/me/account/password', {
      token: actor.token,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    expect(
      (await call('POST', '/auth/password', { body: { email: address, password: NEW_PASSWORD } })).status,
    ).toBe(200);
    expect(
      (await call('POST', '/auth/password', { body: { email: address, password: PASSWORD } })).status,
    ).toBe(401);
  });

  it('⭐ refuses without the current password, even from a live session', async () => {
    /*
     * The unlocked-laptop case. Without this, whoever finds the machine changes the password
     * and owns the account — and the owner's own password stops working, so they cannot take
     * it back.
     */
    const { actor } = await person('nocurrent', { password: true });

    const attempt = await call('POST', '/me/account/password', {
      token: actor.token,
      body: { newPassword: NEW_PASSWORD },
    });
    expect(attempt.status).toBe(401);
    expect((attempt.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'current-password-rejected',
    );
  });

  it('refuses a wrong current password', async () => {
    const { actor } = await person('wrongcurrent', { password: true });
    const attempt = await call('POST', '/me/account/password', {
      token: actor.token,
      body: { currentPassword: 'ไม่ใช่รหัสผ่านเดิมแน่ๆ', newPassword: NEW_PASSWORD },
    });
    expect(attempt.status).toBe(401);
  });

  it('lets somebody with no password set their first one, with nothing to prove', async () => {
    // The Google sign-up. Demanding a `currentPassword` they do not have would make the
    // field impossible rather than safe — and which branch it is comes from the database.
    const { actor, address } = await person('first', { providers: ['google'] });

    const set = await call('POST', '/me/account/password', {
      token: actor.token,
      body: { newPassword: NEW_PASSWORD },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(
      (await call('POST', '/auth/password', { body: { email: address, password: NEW_PASSWORD } })).status,
    ).toBe(200);
  });

  it('applies the length rule and does not write a short one', async () => {
    const { actor } = await person('short', { password: true });
    const attempt = await call('POST', '/me/account/password', {
      token: actor.token,
      body: { currentPassword: PASSWORD, newPassword: 'สั้นไป' },
    });
    expect(attempt.status).toBe(422);
  });

  /* ---------------------------------------------------------------- *
   * Devices
   * ---------------------------------------------------------------- */

  it('⭐ ends every other session on a password change, and keeps this one', async () => {
    const { actor } = await person('sessions', { password: true });

    /*
     * Two other devices, and the session this request arrives on. `makeActor` signs a token
     * against a session id that has no row, so the current one is inserted explicitly —
     * otherwise "keeps this one" would be a claim about a row that never existed.
     */
    const mine = await db.execute<{ id: string }>(sql`
      insert into sessions (user_id, expires_at)
      values (${actor.userId}::uuid, now() + interval '30 days') returning id
    `);
    const currentId = mine.rows[0]?.id ?? '';

    for (let other = 0; other < 2; other += 1) {
      await db.execute(sql`
        insert into sessions (user_id, expires_at)
        values (${actor.userId}::uuid, now() + interval '30 days')
      `);
    }

    /*
     * A token whose `sessionId` names the row above. `makeActor` signs against a random id
     * with no row behind it — fine for authenticating, useless for "keep *this* session",
     * which is the property under test.
     */
    const token = app.app
      .get(AccessTokenService)
      .sign({ userId: actor.userId, sessionId: currentId }).token;

    const changed = await call('POST', '/me/account/password', {
      token,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((changed.body as { otherSessionsEnded: number }).otherSessionsEnded).toBe(2);

    const live = await db.execute<{ id: string }>(sql`
      select id from sessions where user_id = ${actor.userId}::uuid and revoked_at is null
    `);
    // Exactly the one the request came in on. Signing somebody out of the tab they are
    // typing in would be a punishment for good housekeeping.
    expect(live.rows.map((row) => row.id)).toEqual([currentId]);
  });

  it('marks the current device and refuses to revoke it from here', async () => {
    const { actor } = await person('devices', { password: true });
    const mine = await db.execute<{ id: string }>(sql`
      insert into sessions (user_id, expires_at)
      values (${actor.userId}::uuid, now() + interval '30 days') returning id
    `);
    const currentId = mine.rows[0]?.id ?? '';

    const token = app.app
      .get(AccessTokenService)
      .sign({ userId: actor.userId, sessionId: currentId }).token;

    const listed = (await call('GET', '/me/account', { token })).body as {
      sessions: { id: string; current: boolean }[];
    };
    expect(listed.sessions.find((row) => row.id === currentId)?.current).toBe(true);

    const attempt = await call('DELETE', `/me/account/sessions/${currentId}`, { token });
    expect(attempt.status).toBe(409);
  });

  it('⭐ cannot revoke somebody else’s session', async () => {
    const { actor: mine } = await person('owner', { password: true });
    const { actor: theirs } = await person('stranger', { password: true });

    const hers = await db.execute<{ id: string }>(sql`
      insert into sessions (user_id, expires_at)
      values (${theirs.userId}::uuid, now() + interval '30 days') returning id
    `);

    /*
     * 404 and not 403: `user_id` is in the UPDATE's WHERE clause, so the statement simply
     * matches nothing. Answering "forbidden" would confirm the session id names something
     * real, which is an oracle over a table of everybody's devices.
     */
    const attempt = await call('DELETE', `/me/account/sessions/${hers.rows[0]?.id ?? ''}`, {
      token: mine.token,
    });
    expect(attempt.status).toBe(404);

    const still = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from sessions
       where user_id = ${theirs.userId}::uuid and revoked_at is null
    `);
    expect(still.rows[0]?.n).toBe(1);
  });
});
