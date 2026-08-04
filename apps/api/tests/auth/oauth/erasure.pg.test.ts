import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar, signIn } from './support/browser';
import { FakeProvider } from './support/fake-provider';
import { TestDb, databaseUrl, emailFor, subjectFor } from './support/db';
import { bootOAuthApp, freePort, type BootedOAuthApp } from './support/oauth-app';

/**
 * What happens when somebody who asked to be forgotten comes back.
 *
 * ── The failure this file is written against ────────────────────────────────────
 *
 * "Deletion is a status flag" (plan 7.15 item 1) has a shape that looks harmless and is not:
 * flag the account, keep the credentials. `IdentityLinkService` branch 1 refuses any
 * non-active status by `sub`; branch 2 refuses it by proven address and deliberately does
 * not fall through; `OAuthService` turns both into one deliberately opaque `failed`
 * redirect. So a flag-only "deletion" makes the person's own mailbox a dead zone across
 * *every* provider, forever, with no error message naming a cause and no operator surface to
 * fix it — `users.read`/`users.write` have no routes at all.
 *
 * The design answers that with two states, and both halves are exercised here:
 *
 *   `closed`   keeps the credentials and is genuinely reversible: proving control of the
 *              account again through the provider reinstates it. That is a real
 *              re-authentication by the same mechanism that would have signed them in.
 *   `erased`   deletes the credentials, so branch 1 and branch 2 cannot match at all and the
 *              returning person lands in branch 3 with a fresh account and none of the
 *              tombstone's orders.
 *
 * ── Mutations, run and reported in plan 7.15 ────────────────────────────────────
 *
 *   `signInDisposition`: `closed → 'refuse'`  → the reinstatement test goes red.
 *   `signInDisposition`: `suspended → 'reinstate'` → the suspension test goes red.
 *   `erase_user`: stop deleting `provider_identities` → the fresh-account test goes red
 *   (and the erasure itself is refused by `users_erasure_is_earned`, which is the point).
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('closure, erasure, and the customer who comes back', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  /*
   * Two providers, because they prove different things. LINE never asserts a proven address
   * (`line.provider.ts` hard-codes `emailProven: false`), so a LINE sign-in is recognised by
   * `sub` alone — which is exactly the reinstatement path, and the one that would keep
   * working if the address release were broken. Google proves the address, so it is the only
   * one that can show `user_emails_one_verified_owner` being released and re-taken.
   */
  let line: FakeProvider;
  let google: FakeProvider;
  let app: BootedOAuthApp;
  let googleApp: BootedOAuthApp;

  beforeAll(async () => {
    line = new FakeProvider('line');
    google = new FakeProvider('google');
    await line.listen();
    await google.listen();
    app = await bootOAuthApp({ databaseUrl: url, provider: line, port: await freePort() });
    googleApp = await bootOAuthApp({ databaseUrl: url, provider: google, port: await freePort() });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await googleApp.close();
    await line.close();
    await google.close();
    await db.cleanUp();
    await db.close();
  });

  beforeEach(() => {
    line.reset();
    google.reset();
    app.sessions.reset();
    googleApp.sessions.reset();
  });

  const statusOf = async (userId: string): Promise<string | undefined> => {
    const [row] = await db.query<{ status: string }>('select status from users where id = $1', [userId]);
    return row?.status;
  };

  it('reopens a closed account when the customer proves it again', async () => {
    const subject = subjectFor('closed-returns');
    line.account = { subject, email: emailFor('closed-returns'), emailVerified: true, name: 'สมชาย' };

    await signIn({ apiBaseUrl: app.baseUrl, provider: line, jar: new CookieJar() });
    const userId = app.sessions.lastUserId;
    expect(userId).toBeDefined();

    await db.query('select close_user($1::uuid)', [userId]);
    expect(await statusOf(userId ?? '')).toBe('closed');

    app.sessions.reset();
    await signIn({ apiBaseUrl: app.baseUrl, provider: line, jar: new CookieJar() });

    // The same account, not a second one. `closed` retains the verified address and the
    // provider identity precisely so this is possible; that retention is the whole
    // difference between the two non-active states.
    expect(app.sessions.lastUserId).toBe(userId);
    expect(await statusOf(userId ?? '')).toBe('active');

    // The date they asked survives the reopening. `users_closed_at_present` is a one-way
    // implication so that history outlives the state it describes.
    const [row] = await db.query<{ closed_at: Date | null }>('select closed_at from users where id = $1', [userId]);
    expect(row?.closed_at).not.toBeNull();
  });

  it('does not reopen a suspended account, because an administrator decided that one', async () => {
    const subject = subjectFor('suspended-returns');
    line.account = { subject, email: emailFor('suspended-returns'), emailVerified: true };

    await signIn({ apiBaseUrl: app.baseUrl, provider: line, jar: new CookieJar() });
    const userId = app.sessions.lastUserId ?? '';

    await db.suspend(userId);
    app.sessions.reset();

    const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider: line, jar: new CookieJar() });

    // A decision the subject can undo by signing in is not a suspension. The refusal is the
    // same opaque redirect every other one gets — a suspended person must not learn from the
    // login page that their suspension is the reason.
    expect(outcome.callback.location).toContain('error=failed');
    expect(app.sessions.lastUserId).toBeUndefined();
    expect(await statusOf(userId)).toBe('suspended');
  });

  it('gives an erased customer a fresh account rather than an opaque dead end', async () => {
    const subject = subjectFor('erased-returns');
    const address = emailFor('erased-returns');
    google.account = { subject, email: address, emailVerified: true, name: 'มาลี แสนดี' };

    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });
    const tombstone = googleApp.sessions.lastUserId ?? '';
    expect(await db.emailsFor(address)).toHaveLength(1);

    await db.query('select close_user($1::uuid)', [tombstone]);
    await db.query(
      `select erase_user($1::uuid, null::uuid, 'self_service', 'PDPA s.33 right to erasure')`,
      [tombstone],
    );

    googleApp.sessions.reset();
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });

    const reborn = googleApp.sessions.lastUserId;
    expect(reborn, 'the erased customer was refused instead of being given a new account').toBeDefined();
    expect(reborn).not.toBe(tombstone);

    // Branch 3 ran, which means `verifiedOwnerOf` found nothing — the release of
    // `user_emails_one_verified_owner` is what made that true. The tombstone keeps its id and
    // therefore keeps whatever orders point at it; the new account reaches none of them,
    // because ownership is `orders.customer_user_id` and was never an address.
    const rows = await db.emailsFor(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(reborn);

    const identity = await db.identity('google', subject);
    expect(identity?.user_id).toBe(reborn);

    const [stone] = await db.query<{ status: string; display_name: string | null }>(
      'select status, display_name from users where id = $1',
      [tombstone],
    );
    expect(stone?.status).toBe('erased');
    expect(stone?.display_name).toBeNull();
  });
});
