import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq, sql } from '@wewin/db/sql';
import { passwordCredentials, userEmails, userPhones, users } from '@wewin/db/schema';

import { hashPassword, ARGON2ID_PARAMETERS } from '../../../src/auth/password/password-hash';
import { REFRESH_COOKIE_NAME } from '../../../src/auth/session/refresh-cookie';
import { bootLifecycleApp, client, lifecycleEnv, type LifecycleApp } from '../../orders/support/lifecycle-app';

/**
 * Password sign-in over real HTTP, against a real Postgres, with a real session.
 *
 * `password-sign-in.test.ts` states each branch against fakes; this file answers the two
 * questions fakes cannot:
 *
 *   **Is the session actually usable?** A sign-in that returns a well-formed token nobody
 *   accepts is the failure mode that unit tests are structurally blind to — the middleware
 *   that verifies the token is a different object from the service that signs it, and
 *   "signed with a second key" is exactly what a second `SessionModule.forRoot` produces.
 *
 *   **Does the row shape hold?** `password_credentials_argon2id` and
 *   `user_emails_one_verified_owner` are CHECKs and a partial unique index. A hash written
 *   by this code either satisfies them or the INSERT fails here, where the message names
 *   the constraint.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/**
 * An error body with the two fields that are *supposed* to differ removed.
 *
 * `requestId` and `timestamp` are unique per request by design — they are what an operator
 * correlates a report with — so comparing whole bodies would fail for the right reason at
 * the wrong time and hide the comparison that matters. Everything else must be identical:
 * code, status, message, messageKey, locale, details.
 */
const comparable = (body: unknown): unknown => {
  const { error } = body as { error?: Record<string, unknown> };
  if (error === undefined) return body;
  const { requestId: _requestId, timestamp: _timestamp, path: _path, ...rest } = error;
  return rest;
};
const PASSWORD = 'ลมพัดผ่านหน้าต่างบานกระทุ้ง 2569';

describeWithPg('signing in with a password', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  /** A user with a verified address and a password. Returns the address. */
  const makeAccount = async (
    who: string,
    options: { password?: string | null; verified?: boolean; status?: string } = {},
  ): Promise<string> => {
    const address = `pw-${who}-${tag}@probe.invalid`;
    const [user] = await db
      .insert(users)
      .values({ displayName: `password probe ${who} ${tag}` })
      .returning({ id: users.id });
    if (!user) throw new Error('fixture insert returned nothing');

    /*
     * `isPrimary` follows `verified`, because `user_emails_primary_is_verified` is a CHECK:
     * an address nobody has proven control of may not be the one the company writes to. The
     * fixture found that by trying — which is the constraint doing its job in the layer that
     * can actually enforce it.
     */
    const verified = options.verified !== false;
    await db.insert(userEmails).values({
      userId: user.id,
      address,
      isPrimary: verified,
      verifiedAt: verified ? new Date() : null,
    });

    const password = options.password === undefined ? PASSWORD : options.password;
    if (password !== null) {
      await db
        .insert(passwordCredentials)
        .values({ userId: user.id, passwordHash: await hashPassword(password) });
    }

    if (options.status !== undefined) {
      // `users_suspended_at_present` — a suspension without the moment it happened is a
      // record nobody can audit, so the CHECK refuses one. Same shape as `frozen_at`.
      await db.execute(
        sql`update users set status = ${options.status}, suspended_at = now() where id = ${user.id}::uuid`,
      );
    }

    return address;
  };

  const signIn = (email: string, password: string) =>
    call('POST', '/auth/password', { body: { email, password } });

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

  it('⭐ issues a token the application actually accepts', async () => {
    const address = await makeAccount('happy');

    const answer = await signIn(address, PASSWORD);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const { accessToken } = answer.body as { accessToken: string };
    expect(accessToken).toBeTruthy();

    /*
     * The assertion the unit tests cannot make. `GET /me` runs through
     * `AuthenticationMiddleware`, which verifies the signature with the key
     * `SessionModule.forRoot` was built with — so this fails if `PasswordModule` ever ends up
     * holding a second `SessionService`. It is the reason `password.module.ts` takes the
     * session module as an argument rather than importing it.
     */
    const me = await call('GET', '/me', { token: accessToken });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect((me.body as { kind?: string }).kind).toBe('user');
  });

  it('sets a refresh cookie that can be spent, and does not put it in the body', async () => {
    const address = await makeAccount('refresh');

    const answer = await signIn(address, PASSWORD);
    const cookies = answer.headers.getSetCookie();
    // The constant, not the word "refresh": the cookie is called `__Host-wewin_rt`, and a
    // test that searched for a substring of a name it assumed would pass against no cookie
    // at all the day the name changed.
    const refresh = cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));

    expect(refresh).toBeDefined();
    expect(refresh).toContain('HttpOnly');
    // The body carries the short-lived half only. A refresh token a page can read is a
    // refresh token an injected script can take, and it lasts ninety days.
    const token = refresh?.split(';')[0]?.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(answer.body)).not.toContain(token);

    const rotated = await call('POST', '/auth/refresh', {
      cookie: refresh?.split(';')[0] ?? '',
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
  });

  it('never caches the response that carries a bearer token', async () => {
    const address = await makeAccount('nostore');
    const answer = await signIn(address, PASSWORD);

    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses an unverified address, exactly as it refuses an unknown one', async () => {
    /*
     * ⭐ The attack `user_emails_one_verified_owner` exists for. An attacker adds the
     * victim's address to their own account; the row is allowed to exist because the index
     * is partial, and it is *unverified*. If this lookup matched on address alone it would
     * find that row and sign the attacker in — as themselves, with their own password,
     * having chosen which account somebody else's address resolves to.
     */
    const unverified = await makeAccount('unverified', { verified: false });

    const refused = await signIn(unverified, PASSWORD);
    const unknown = await signIn(`nobody-${tag}@probe.invalid`, PASSWORD);

    expect(refused.status).toBe(401);
    expect(comparable(refused.body)).toEqual(comparable(unknown.body));
  });

  it('refuses an account with no password the same way', async () => {
    const google = await makeAccount('googleonly', { password: null });

    const refused = await signIn(google, PASSWORD);
    const unknown = await signIn(`nobody2-${tag}@probe.invalid`, PASSWORD);

    expect(refused.status).toBe(401);
    expect(comparable(refused.body)).toEqual(comparable(unknown.body));
  });

  it('refuses a suspended account even with the right password', async () => {
    const suspended = await makeAccount('suspended', { status: 'suspended' });

    const refused = await signIn(suspended, PASSWORD);
    expect(refused.status).toBe(401);
    expect((refused.body as { error?: { messageKey?: string } }).error?.messageKey).toBe(
      'error.auth.credentials_rejected',
    );
  });

  it('finds the account whatever case the address was typed in', async () => {
    const address = await makeAccount('casing');

    const answer = await signIn(address.toUpperCase(), PASSWORD);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  });

  it('renders its refusal in the language the caller asked for', async () => {
    // The whole point of routing this through `error.auth.credentials_rejected` rather than
    // a literal: the key travels, so a client can render it and a future catalogue can
    // translate it. Today only Thai is authored, and the envelope says so honestly.
    const answer = await signIn(`nobody3-${tag}@probe.invalid`, PASSWORD);
    const body = answer.body as { error?: { messageKey?: string; message?: string } };

    expect(body.error?.messageKey).toBe('error.auth.credentials_rejected');
    expect(body.error?.message).toBe('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  });

  it('upgrades a weak hash in the database, and the new one still opens the account', async () => {
    const address = `pw-upgrade-${tag}@probe.invalid`;
    const [user] = await db
      .insert(users)
      .values({ displayName: `password upgrade ${tag}` })
      .returning({ id: users.id });
    if (!user) throw new Error('fixture insert returned nothing');

    await db.insert(userEmails).values({ userId: user.id, address, verifiedAt: new Date() });
    const weak = await hashPassword(PASSWORD, { ...ARGON2ID_PARAMETERS, timeCost: 1 });
    await db.insert(passwordCredentials).values({ userId: user.id, passwordHash: weak });

    expect((await signIn(address, PASSWORD)).status).toBe(200);

    const [row] = await db
      .select({ hash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, user.id));

    expect(row?.hash).not.toBe(weak);
    expect(row?.hash).toContain(`t=${String(ARGON2ID_PARAMETERS.timeCost)}`);
    /*
     * And it still works. The write went through `password_credentials_argon2id`, so a hash
     * of the wrong thing would have been stored happily — the CHECK constrains the *shape*,
     * not the content. This is the assertion that would have caught the first draft's
     * `hashPassword('')`, in the layer where it would actually have locked people out.
     */
    expect((await signIn(address, PASSWORD)).status).toBe(200);
  });

  it('throttles the sixth wrong password and says how long to wait', async () => {
    const address = await makeAccount('throttled');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn(address, 'definitely wrong')).status).toBe(401);
    }

    const refused = await signIn(address, 'definitely wrong');
    expect(refused.status).toBe(429);
    expect((refused.body as { error?: { messageKey?: string } }).error?.messageKey).toBe(
      'error.auth.too_many_attempts',
    );

    // ⚠️ And the correct password is refused too, which is the documented cost of the limiter.
    expect((await signIn(address, PASSWORD)).status).toBe(429);
  });

  /* ================================================================= *
   * ⭐ A telephone number as a username — against the real query
   * ================================================================= */

  /**
   * ⚠️ These are here because the unit suite cannot see them.
   *
   * `password-sign-in.test.ts` drives a fake store, so it asserts what the *service* does
   * with whatever the store returns. Whether the store's query filters on `verified_at` is
   * invisible to it — a mutation putting that filter back passed all twenty-nine of its
   * tests, while breaking the property the whole design turns on.
   *
   * So the number is claimed in Postgres and the sign-in goes over HTTP.
   */
  const makePhoneAccount = async (
    who: string,
    options: { verified?: boolean } = {},
  ): Promise<string> => {
    const number = `+6681${who}`;
    const [user] = await db
      .insert(users)
      .values({ displayName: `phone probe ${who} ${tag}` })
      .returning({ id: users.id });
    if (!user) throw new Error('fixture insert returned nothing');

    await db.insert(userPhones).values({
      userId: user.id,
      number,
      /* `user_phones_primary_is_verified` — an unproved number may not be the one of record. */
      isPrimary: options.verified === true,
      verifiedAt: options.verified === true ? new Date() : null,
    });
    await db
      .insert(passwordCredentials)
      .values({ userId: user.id, passwordHash: await hashPassword(PASSWORD) });

    return number;
  };

  it('⭐ signs in on a claim nobody has proved', async () => {
    /*
     * The property the whole split exists for. Verification means possession of the handset
     * and costs money to establish, so requiring it would mean somebody who registered with a
     * number waited for a telephone call before they could get in.
     *
     * MUTATION: add `and(… userPhones.verifiedAt is not null)` back to `findByClaimedPhone`
     * — this goes red and the unit suite stays green, which is why it is written here.
     */
    const number = await makePhoneAccount('1230001');

    const answer = await signIn(number, PASSWORD);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as { accessToken?: string }).accessToken).toBeTypeOf('string');
  });

  it('signs in on a proved one too', async () => {
    const number = await makePhoneAccount('1230002', { verified: true });

    expect((await signIn(number, PASSWORD)).status).toBe(200);
  });

  it('⭐ reaches the same account however the number is written', async () => {
    /*
     * `user_phones_number_e164` stores one spelling; `@wewin/core/phone` produces it from
     * whatever a person typed. Both halves have to agree or a customer who registered on a
     * laptop and signs in on a phone keyboard is refused.
     */
    const number = await makePhoneAccount('1230003');

    for (const written of ['0811230003', '081-123-0003', '081 123 0003', number]) {
      expect((await signIn(written, PASSWORD)).status, written).toBe(200);
    }
  });

  it('⚠️ refuses a number nobody claimed, exactly like a wrong password', async () => {
    const claimed = await makePhoneAccount('1230004');

    const wrongPassword = await signIn(claimed, 'entirely the wrong password');
    const unclaimed = await signIn('+66819990004', PASSWORD);

    expect(unclaimed.status).toBe(wrongPassword.status);
    expect((unclaimed.body as { error?: { code?: string } }).error?.code).toBe(
      (wrongPassword.body as { error?: { code?: string } }).error?.code,
    );
  });
});
