import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdentityLinkService } from '../../../src/auth/oauth/identity-link.service';
import { CookieJar, signIn } from './support/browser';
import { FakeProvider } from './support/fake-provider';
import { RUN_TAG, TestDb, databaseUrl, emailFor, subjectFor } from './support/db';
import { WEB_BASE_URL, bootOAuthApp, freePort, type BootedOAuthApp } from './support/oauth-app';

/**
 * ⓐ Account pre-hijacking, written as the attack — plan 6(a).
 *
 * > An attacker registers first with the victim's address and leaves it unverified; the
 * > victim then signs in with Google on the same address, and merging hands over the
 * > account.
 *
 * The first test is that sentence, executed. The attacker's account is created directly in
 * the database because that is what a signup is — a claim on an address, unproven — and then
 * the victim goes through the real Google flow. The assertions are all about what the
 * attacker can reach afterwards, which is nothing.
 *
 * The three tests after it exist because "always create a new account" would pass the first
 * one and be wrong. Branch 2 has to link to an account that *did* prove the address, or
 * signing in with Google never reaches the account you made with a password; branch 1 has to
 * ignore the email entirely for a returning `sub`; and an address the provider merely
 * asserted must not strip anything, because nothing was proved.
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('account linking', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  let google: FakeProvider;
  let facebook: FakeProvider;
  let line: FakeProvider;
  let googleApp: BootedOAuthApp;
  let facebookApp: BootedOAuthApp;
  let lineApp: BootedOAuthApp;

  beforeAll(async () => {
    google = new FakeProvider('google');
    facebook = new FakeProvider('facebook');
    line = new FakeProvider('line');
    await google.listen();
    await facebook.listen();
    await line.listen();
    googleApp = await bootOAuthApp({ databaseUrl: url, provider: google, port: await freePort() });
    facebookApp = await bootOAuthApp({ databaseUrl: url, provider: facebook, port: await freePort() });
    lineApp = await bootOAuthApp({ databaseUrl: url, provider: line, port: await freePort() });
  }, 60_000);

  afterAll(async () => {
    await googleApp.close();
    await facebookApp.close();
    await lineApp.close();
    await google.close();
    await facebook.close();
    await line.close();
    await db.cleanUp();
    await db.close();
  });

  beforeEach(() => {
    google.reset();
    facebook.reset();
    line.reset();
    googleApp.sessions.reset();
    facebookApp.sessions.reset();
    lineApp.sessions.reset();
  });

  const returnTo = (label: string): string => `/after/${RUN_TAG}/${label}`;

  it('does not hand the victim to an attacker who registered their address first', async () => {
    const address = emailFor('victim');
    const subject = subjectFor('victim-google');

    // The attack's first move, months earlier: register with somebody else's address and
    // never click the link. Nothing prevents this and nothing should — it is what an
    // ordinary signup looks like before verification.
    const attackerUserId = await db.createUnverifiedAccount(address);

    google.account = { subject, email: address, emailVerified: true, name: 'Victim' };
    const outcome = await signIn({
      apiBaseUrl: googleApp.baseUrl,
      provider: google,
      jar: new CookieJar(),
      returnTo: returnTo('prehijack'),
    });

    expect(outcome.callback.location).toBe(`${WEB_BASE_URL}${returnTo('prehijack')}`);

    const victimUserId = googleApp.sessions.lastUserId;
    expect(victimUserId).toBeDefined();

    // 1. A different account. This is the whole fix: merging into the attacker's is the
    //    handover, and it is exactly what a "find the user with this email" lookup does.
    expect(victimUserId).not.toBe(attackerUserId);

    // 2. The address now belongs to one account, verified, and that account is the victim's.
    const rows = await db.emailsFor(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(victimUserId);
    expect(rows[0]?.verified_at).not.toBeNull();

    // 3. The attacker's claim on it is gone — stripped by the trigger inside the INSERT that
    //    proved the address, not by a service method somebody could forget to call.
    const attackerRows = rows.filter((row) => row.user_id === attackerUserId);
    expect(attackerRows).toEqual([]);

    // 4. The attacker's account still exists, and has no route to the victim's. That matters:
    //    deleting it would be destroying somebody's data on the strength of a login.
    expect(await db.userExists(attackerUserId)).toBe(true);

    // 5. The provider identity points at the victim, so the next Google sign-in lands in the
    //    same place and never revisits the address at all.
    const identity = await db.identity('google', subject);
    expect(identity?.user_id).toBe(victimUserId);
  });

  it('strips every unverified claim, not just the first one', async () => {
    const address = emailFor('crowded');
    const first = await db.createUnverifiedAccount(address);
    const second = await db.createUnverifiedAccount(address);
    const third = await db.createUnverifiedAccount(address);

    google.account = { subject: subjectFor('crowded'), email: address, emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });

    const rows = await db.emailsFor(address);
    expect(rows).toHaveLength(1);
    expect([first, second, third]).not.toContain(rows[0]?.user_id);
    expect(rows[0]?.user_id).toBe(googleApp.sessions.lastUserId);
  });

  it('links to an account that already proved the same address, rather than making a second one', async () => {
    // The control for the test above: if the rule were "always create a new account", signing
    // in with Google would never reach the account somebody made with a password.
    const address = emailFor('rightful');
    const ownerId = await db.createVerifiedAccount(address);

    google.account = { subject: subjectFor('rightful'), email: address, emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });

    expect(googleApp.sessions.lastUserId).toBe(ownerId);
    expect(await db.emailsFor(address)).toHaveLength(1);
  });

  it('leaves an unverified claim alone when the provider only asserted the address', async () => {
    // Facebook says nothing about whether it confirmed the address, so nothing was proved and
    // nothing may be stripped. The customer gets their own account and can link later by
    // proving the address themselves.
    const address = emailFor('asserted');
    const otherUserId = await db.createUnverifiedAccount(address);

    facebook.account = { subject: subjectFor('asserted'), email: address };
    await signIn({ apiBaseUrl: facebookApp.baseUrl, provider: facebook, jar: new CookieJar() });

    const rows = await db.emailsFor(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(otherUserId);
    expect(rows[0]?.verified_at).toBeNull();
    expect(facebookApp.sessions.lastUserId).not.toBe(otherUserId);
  });

  it('does not attach to a verified owner on an address the provider only asserted', async () => {
    const address = emailFor('asserted-owner');
    const ownerId = await db.createVerifiedAccount(address);

    facebook.account = { subject: subjectFor('asserted-owner'), email: address };
    await signIn({ apiBaseUrl: facebookApp.baseUrl, provider: facebook, jar: new CookieJar() });

    // A string a provider handed over with no assertion attached is not a key to an account.
    expect(facebookApp.sessions.lastUserId).not.toBe(ownerId);
  });

  it('recognises a returning sub without consulting the email at all', async () => {
    const subject = subjectFor('returning');
    const firstAddress = emailFor('returning-one');
    google.account = { subject, email: firstAddress, emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });
    const userId = googleApp.sessions.lastUserId;

    // The same person changes the address on their Google account. `sub` is what identifies
    // them; the address is a fact about them that happens to have changed.
    const secondAddress = emailFor('returning-two');
    google.account = { subject, email: secondAddress, emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });

    expect(googleApp.sessions.lastUserId).toBe(userId);
    const rows = await db.emailsFor(secondAddress);
    expect(rows[0]?.user_id).toBe(userId);
  });

  it('does not move a returning customer onto an address somebody else has proved', async () => {
    const subject = subjectFor('collide');
    google.account = { subject, email: emailFor('collide-own'), emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });
    const userId = googleApp.sessions.lastUserId;

    const takenAddress = emailFor('collide-taken');
    const ownerId = await db.createVerifiedAccount(takenAddress);

    google.account = { subject, email: takenAddress, emailVerified: true };
    await signIn({ apiBaseUrl: googleApp.baseUrl, provider: google, jar: new CookieJar() });

    // Still signed in as themselves; the other account keeps its address.
    expect(googleApp.sessions.lastUserId).toBe(userId);
    const rows = await db.emailsFor(takenAddress);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(ownerId);
  });

  /**
   * ⓐ LINE asserts an address; it never proves one.
   *
   * An earlier version of `line.provider.ts` inferred proof from the address merely being
   * present in the id_token, reasoning that LINE confirms an address before it becomes the
   * account's. A red-team pass showed what that costs when the reasoning is wrong: an
   * attacker's own LINE `sub`, asserting a victim's address, lands in the linking service's
   * "already proved by an account" branch and is handed a session inside the victim's
   * account with a permanent LINE identity attached to it. One request, no interaction with
   * the victim.
   *
   * So both halves are asserted here. The address does not become a verified claim — which
   * is what stops it stripping anybody's row or being a link key — and it is still recorded
   * on `provider_identities.asserted_email` with `asserted_email_verified = false`, because
   * throwing the assertion away would lose the evidence that LINE said it at all.
   */
  it('never treats a LINE address as proof of control — it is recorded as an assertion', async () => {
    const address = emailFor('line-proof');
    const otherId = await db.createUnverifiedAccount(address);

    const subject = subjectFor('line-proof');
    line.account = { subject, email: address };
    await signIn({ apiBaseUrl: lineApp.baseUrl, provider: line, jar: new CookieJar() });

    const signedInAs = lineApp.sessions.lastUserId;
    expect(signedInAs).toBeDefined();
    expect(signedInAs).not.toBe(otherId);

    // The other account's unverified claim is untouched: nothing was proven, so nothing is
    // stripped. And LINE's sign-in created no verified claim of its own.
    const rows = await db.emailsFor(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(otherId);
    expect(rows[0]?.verified_at).toBeNull();

    const [identity] = await db.identitiesFor('line', subject);
    expect(identity?.asserted_email).toBe(address);
    expect(identity?.asserted_email_verified).toBe(false);
  });

  it('lands two simultaneous first sign-ins on the same address in one account', async () => {
    /*
     * Both callers look, both find no verified owner, and both try to insert one. The partial
     * unique index makes the loser lose with 23505 rather than producing a second verified
     * owner, and the single retry re-runs it into the branch that links. Without the index
     * this is two accounts for one person; without the retry it is a failed login.
     */
    const address = emailFor('race');
    const identities = googleApp.app.get(IdentityLinkService);

    const [first, second] = await Promise.all([
      identities.link({
        provider: 'google',
        subject: subjectFor('race-google'),
        email: address,
        emailProven: true,
        displayName: undefined,
      }),
      identities.link({
        provider: 'line',
        subject: subjectFor('race-line'),
        email: address,
        emailProven: true,
        displayName: undefined,
      }),
    ]);

    expect(first.userId).toBe(second.userId);
    expect(await db.emailsFor(address)).toHaveLength(1);
    // Exactly one of them created the account; the other attached to the address it found.
    expect([first.accountCreated, second.accountCreated].filter(Boolean)).toHaveLength(1);
  });
});
