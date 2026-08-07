import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { bootLifecycleApp, client, lifecycleEnv, type LifecycleApp } from '../../orders/support/lifecycle-app';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ REGISTERING WITH A TELEPHONE NUMBER, AND GETTING IN.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until this route there was no self-service account at all: one came from OAuth, an
 * administrator, or the CLI. A Thai customer with no email address had no way to have one.
 *
 * ── ⚠️ A number only, and the refusal is the honest part ─────────────────────
 *
 * An address is refused here, which reads like an omission and is not. Email verification is
 * **not implemented** — no route redeems the `email_verification` token purpose — and
 * `findByVerifiedEmail` requires `verified_at`. An account registered with an address would
 * therefore be one nobody could ever sign into: the exact dead end that phone-as-username was
 * built to remove, moved one field over.
 *
 * The day the verification email exists, this refusal is what should be deleted.
 *
 * ── The three properties ─────────────────────────────────────────────────────
 *
 *   ⓵ registering signs you **in**, immediately, with no verification step — the whole point;
 *   ⓶ the number is **canonical**, so the person who registered on a laptop and signs in on a
 *     phone keyboard reaches the same account;
 *   ⓷ a number already claimed is refused, because `user_phones_number_key` says one account
 *     per telephone and sign-in depends on that being true.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);
const PASSWORD = 'ลมพัดผ่านหน้าต่างบานกระทุ้ง 2569';

describeWithPg('⭐ self-service registration', () => {
  let pool: Pool;
  let db: Database;
  let app: LifecycleApp;
  let call: ReturnType<typeof client>;

  /**
   * Distinct per test, and outside every other suite's range.
   *
   * ⚠️ **Exactly nine subscriber digits** after `+66`, starting `85`. A Thai mobile is `08x`
   * plus seven more, and two versions of this helper got the arithmetic wrong in opposite
   * directions before this one — eight digits, then ten. `@wewin/core/phone` refused both,
   * correctly: eight starting with `8` is a mobile with one missing, and ten is not a Thai
   * number at all. The fixture was wrong twice and the normaliser was right twice.
   *
   * `85` rather than `81`/`82`, which `packages/db/tests/auth.test.ts` and the sign-in pg
   * suite already use — one database, and a collision here would read as this file's bug.
   */
  let next = 0;
  const freshNumber = (): string => {
    next += 1;
    return `+6685${String(next).padStart(7, '0')}`;
  };

  const register = (username: string, password = PASSWORD) =>
    call('POST', '/auth/register', { body: { username, password } });

  const signIn = (username: string, password = PASSWORD) =>
    call('POST', '/auth/password', { body: { email: username, password } });

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootLifecycleApp(lifecycleEnv(url ?? ''));
    call = client(app.baseUrl);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('⭐ mints an account and signs the person in, with nothing to verify first', async () => {
    /*
     * ⓵. `user_phones.verified_at` stays null — nobody has proved possession and nothing
     * pretends they have — and the session is issued anyway, because verification answers a
     * different question. See the table's own comment.
     */
    const number = freshNumber();

    const answer = await register(number);

    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect((answer.body as { accessToken?: string }).accessToken).toBeTypeOf('string');

    const rows = await db.execute(
      sql`select verified_at, is_primary from user_phones where number = ${number}`,
    );
    const row = (rows as unknown as { rows: { verified_at: Date | null; is_primary: boolean }[] })
      .rows[0];

    expect(row?.verified_at, 'registering must not pretend the number was proved').toBeNull();
    /* `user_phones_primary_is_verified` — an unproved number is not the number of record. */
    expect(row?.is_primary).toBe(false);
  });

  it('⭐ the account can sign in afterwards, which is the whole point', async () => {
    const number = freshNumber();
    await register(number);

    const answer = await signIn(number);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as { accessToken?: string }).accessToken).toBeTypeOf('string');
  });

  it('⭐ stores the number canonically, however it was typed', async () => {
    /*
     * ⓶. Registered from a laptop as `081-…`, signed in from a phone keyboard as `081…`. If
     * the two produced different strings the second would be a stranger — and the CHECK would
     * have refused the first anyway, as a 500.
     */
    const answer = await register('082-200-9001');
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);

    for (const written of ['0822009001', '+66822009001', '082 200 9001']) {
      expect((await signIn(written)).status, written).toBe(200);
    }
  });

  it('⭐ refuses a number somebody already claimed', async () => {
    /*
     * ⓷. One account per telephone is what makes the sign-in lookup unambiguous, and the
     * lookup no longer filters on `verified_at` — so a second claim would leave two accounts
     * answering to one number with nothing to choose between them.
     *
     * ⚠️ This does disclose that the number is registered, which every signup form does and
     * cannot avoid: a person who cannot be told refuses to proceed. The message points at the
     * two things that help — sign in, or telephone if it is not yours.
     */
    const number = freshNumber();
    await register(number);

    const again = await register(number, 'a completely different passphrase 2569');

    expect(again.status).toBe(409);
    expect((again.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'number-already-registered',
    );
  });

  it('⭐ leaves no orphan account when the number turns out to be taken', async () => {
    /*
     * ⚠️ The case the transaction is actually for, and the one a status-code assertion misses.
     *
     * The three writes go user → claim → credential, and the collision fires on the *second*.
     * Without a transaction the `users` row from the first has already committed: an account
     * with no number, no password and no way to ever be reached, created by somebody else's
     * typo, once per attempt.
     *
     * MUTATION: replace `this.db.transaction(...)` with three statements on `this.db` — every
     * other test in this file stays green and this one goes red, because nothing else makes a
     * write fail after another has succeeded.
     */
    const number = freshNumber();
    await register(number);

    const before = await db.execute(sql`select count(*)::int as n from users`);
    const countOf = (result: unknown): number =>
      (result as { rows: { n: number }[] }).rows[0]?.n ?? -1;

    expect((await register(number, 'another entirely different passphrase 2569')).status).toBe(409);

    const after = await db.execute(sql`select count(*)::int as n from users`);
    expect(countOf(after), 'a refused registration created a user row').toBe(countOf(before));
  });

  it('⭐ refuses an email address, because such an account could never sign in', async () => {
    /*
     * Not an omission. `findByVerifiedEmail` requires `verified_at`, and no route sets it —
     * `email_verification` is a token purpose nothing redeems. Accepting an address here
     * would mint accounts that are permanently locked out.
     */
    const answer = await register(`someone-${tag}@probe.invalid`);

    /* 422 — `AppError.validationFailed`. The body was well-formed; the value is not usable. */
    expect(answer.status).toBe(422);
    expect((answer.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
      'phone-only',
    );
  });

  it('⚠️ refuses a number it cannot place, without guessing', async () => {
    expect((await register('08123')).status).toBe(422);
    expect((await register('hello')).status).toBe(422);
  });

  it('⚠️ refuses a password the sign-in rules would reject', async () => {
    /*
     * The minimum belongs here rather than only at sign-in: an account created under a weaker
     * rule is an account whose owner can never be told why their password stopped being
     * acceptable.
     */
    const answer = await register(freshNumber(), 'สั้นไป');

    expect(answer.status).toBe(422);
  });

  it('⭐ writes nothing at all when it refuses', async () => {
    /*
     * ⚠️ The half a status code misses. A route that created the `users` row, then failed the
     * password rule, would leave an account with no credential and a claim on a number
     * nobody can now register — a denial of service produced by a validation error.
     */
    const number = freshNumber();

    expect((await register(number, 'สั้นไป')).status).toBe(422);

    const rows = await db.execute(sql`select 1 from user_phones where number = ${number}`);
    expect((rows as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });
});
