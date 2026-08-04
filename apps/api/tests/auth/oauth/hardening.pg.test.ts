import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { guestCookieName } from '../../../src/rbac/guest-cookie';
import { CookieJar, signIn } from './support/browser';
import { FakeProvider } from './support/fake-provider';
import { RUN_TAG, TestDb, databaseUrl, emailFor, subjectFor } from './support/db';
import { WEB_BASE_URL, bootOAuthApp, freePort, type BootedOAuthApp } from './support/oauth-app';

/**
 * The sign-in path against the things a red-team pass got past it.
 *
 * Every test here is a specific attack that worked, written as the property that now holds.
 * They live beside `account-linking.pg.test.ts` and `state-binding.pg.test.ts` rather than
 * in a directory of their own, because "this was once exploitable" stops being a useful
 * organising principle the day after it is fixed — what matters is that a change to the
 * linking rule or the cookie profile fails something.
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('sign-in hardening', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  let google: FakeProvider;
  let app: BootedOAuthApp;

  beforeAll(async () => {
    google = new FakeProvider('google');
    await google.listen();
    app = await bootOAuthApp({ databaseUrl: url, provider: google, port: await freePort() });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await google.close();
    await db.cleanUp();
    await db.close();
  });

  beforeEach(() => {
    google.reset();
    app.sessions.reset();
  });

  const returnTo = (label: string): string => `/after/${RUN_TAG}/${label}`;

  /**
   * A ban that nothing reads is not a ban.
   *
   * `users.status`, `users.suspended_at` and `session_revocation_reason.revoked_by_admin`
   * all existed, so "suspend this account" was a modelled operation with no enforcement
   * anywhere on the sign-in path. An administrator could suspend somebody, revoke every
   * session they had, and watch them sign straight back in.
   */
  describe('a suspended account', () => {
    it('cannot sign in through an identity it already has', async () => {
      const address = emailFor('suspend-returning');
      const subject = subjectFor('suspend-returning');

      google.account = { subject, email: address, emailVerified: true };
      await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar: new CookieJar() });
      const userId = app.sessions.lastUserId;
      expect(userId).toBeDefined();

      await db.suspend(userId ?? '');
      app.sessions.reset();

      const second = await signIn({
        apiBaseUrl: app.baseUrl,
        provider: google,
        jar: new CookieJar(),
        returnTo: returnTo('suspend-returning'),
      });

      expect(app.sessions.lastUserId).toBeUndefined();
      // The same opaque failure every other refusal gets. A login page must not tell a
      // stranger that an address belongs to a suspended account, or tell the account holder
      // anything an administrator's email should be telling them.
      expect(second.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    });

    it('cannot be reached by a new provider identity on an address it proved', async () => {
      const address = emailFor('suspend-owner');
      const ownerId = await db.createVerifiedAccount(address);
      await db.suspend(ownerId);

      google.account = { subject: subjectFor('suspend-owner'), email: address, emailVerified: true };
      const outcome = await signIn({
        apiBaseUrl: app.baseUrl,
        provider: google,
        jar: new CookieJar(),
        returnTo: returnTo('suspend-owner'),
      });

      expect(app.sessions.lastUserId).toBeUndefined();
      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);

      /*
       * And no *second* account was created holding the address instead. Falling through to
       * "make a fresh account" would collide with `user_emails_one_verified_owner`, retry,
       * collide again, and turn a suspended account into a 500 on the login page.
       */
      const rows = await db.emailsFor(address);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(ownerId);
    });
  });

  /**
   * The guest cart, and what a planted cookie is worth afterwards.
   *
   * Two independent things make a stolen cookie worthless, and they are worth naming apart.
   *
   *   **The secret.** `wewin_guest` is `id.secret`; knowing an id — from a log line, an old
   *   cookie, a shared browser — is not holding the capability. That is what stops the
   *   attack outright, and it had to be added the moment claiming began *attributing the
   *   guest's orders to the account* (`IdentityLinkService.claimGuest`), because from then
   *   on an id was a bearer token for somebody's contract.
   *
   *   **The claim ends the id's power anyway.** `guests.claimed_by_user_id` is set and every
   *   reader refuses a claimed row from then on, so even a genuinely leaked live cookie
   *   stops working the moment its owner signs in. That is what the second half below still
   *   proves, and it is the one that does not depend on the secret staying secret.
   */
  describe('the guest cart', () => {
    it('claims the visitor’s cart and stops honouring the id afterwards', async () => {
      const cart = await db.createGuest();
      const jar = new CookieJar();
      jar.set(guestCookieName(false), cart.cookie);

      google.account = { subject: subjectFor('cart'), email: emailFor('cart'), emailVerified: true };
      await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar, returnTo: returnTo('cart') });

      const userId = app.sessions.lastUserId;
      expect(userId).toBeDefined();
      expect((await db.guest(cart.id))?.claimed_by_user_id).toBe(userId);

      /*
       * The half that makes a planted cookie worthless. A second sign-in presenting the same
       * id — which is what an attacker who kept a copy would do — carries no cart at all:
       * `OAuthStateService.knownGuest` refuses a claimed row, so `oauth_states.guest_id` is
       * null and there is nothing to re-point.
       */
      const attacker = new CookieJar();
      attacker.set(guestCookieName(false), cart.cookie);
      google.reset();
      google.account = {
        subject: subjectFor('cart-attacker'),
        email: emailFor('cart-attacker'),
        emailVerified: true,
      };
      await signIn({
        apiBaseUrl: app.baseUrl,
        provider: google,
        jar: attacker,
        returnTo: returnTo('cart-attacker'),
      });

      const [state] = await db.statesForReturnTo(returnTo('cart-attacker'));
      expect(state?.guest_id).toBeNull();
      // Still the first account's. The claim guard is `claimed_by_user_id IS NULL`, and it
      // held even though the id was presented by somebody else entirely.
      expect((await db.guest(cart.id))?.claimed_by_user_id).toBe(userId);
    });

    it('carries no cart for a guest id that names no row', async () => {
      const jar = new CookieJar();
      jar.set(guestCookieName(false), '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e12');

      google.account = { subject: subjectFor('ghost'), email: emailFor('ghost'), emailVerified: true };
      await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar, returnTo: returnTo('ghost') });

      const [state] = await db.statesForReturnTo(returnTo('ghost'));
      // A stale cookie from a wiped database is `null`, not a foreign-key violation
      // surfacing as a 500 on the login page.
      expect(state?.guest_id).toBeNull();
      expect(app.sessions.lastUserId).toBeDefined();
    });
  });

  /**
   * ⓐ One mailbox, one verified owner — including when it is spelled two ways.
   *
   * `user_emails_one_verified_owner` is a btree on the raw text, so it compares bytes. `å`
   * precomposed and `a` + combining ring are different bytes naming one mailbox, and before
   * `normaliseEmail` composed to NFC a provider spelling it the other way landed the
   * customer in a *second* account while the index that the whole of ⓐ rests on noticed
   * nothing.
   */
  it('lands both Unicode spellings of one address in the same account', async () => {
    /*
     * Written as escapes on purpose. These two strings differ by one byte sequence and are
     * indistinguishable in every editor, so a literal `å` here would be at the mercy of
     * whatever normalisation the last tool to touch this file applied — and the test would
     * pass by comparing a string to itself.
     */
    const composed = `\u00e5${RUN_TAG}unicode@wewin.test`;
    const decomposed = `a\u030a${RUN_TAG}unicode@wewin.test`;
    expect(composed).not.toBe(decomposed);
    expect(decomposed.normalize('NFC')).toBe(composed);

    google.account = { subject: subjectFor('nfc-first'), email: composed, emailVerified: true };
    await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar: new CookieJar() });
    const first = app.sessions.lastUserId;
    expect(first).toBeDefined();

    google.reset();
    google.account = { subject: subjectFor('nfc-second'), email: decomposed, emailVerified: true };
    await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar: new CookieJar() });

    expect(app.sessions.lastUserId).toBe(first);

    const rows = await db.emailsFor(composed);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(first);
    // Stored composed, so a future writer that skips normalising is refused by
    // `user_emails_address_nfc` rather than quietly creating the second owner.
    expect(rows[0]?.address).toBe(composed);
    expect(await db.emailsFor(decomposed)).toHaveLength(0);
  });
});

/**
 * ⓑ The shipping cookie profile, exercised rather than asserted as a string.
 *
 * Every other integration test in this directory runs `cookieSecure: false`, because there
 * is no TLS terminator in the harness — which meant no end-to-end test had ever run the
 * profile that production runs. This one does: the app is booted with `cookieSecure: true`,
 * so the binding cookie is `__Host-` prefixed, `Secure` and `SameSite=None`, and the whole
 * round trip has to work through it.
 *
 * What this still does not prove is that a *browser* honours those attributes — no browser
 * is in the loop and there is no https origin here. It proves the two profiles are the same
 * code path and that nothing in the flow depends on the development spelling.
 */
describeWithPg('the secure cookie profile', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  let google: FakeProvider;
  let app: BootedOAuthApp;

  beforeAll(async () => {
    google = new FakeProvider('google');
    await google.listen();
    app = await bootOAuthApp({
      databaseUrl: url,
      provider: google,
      port: await freePort(),
      cookieSecure: true,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await google.close();
    await db.cleanUp();
    await db.close();
  });

  it('signs a customer in with a __Host-, Secure, SameSite=None binding cookie', async () => {
    google.account = {
      subject: subjectFor('secure'),
      email: emailFor('secure'),
      emailVerified: true,
    };

    const jar = new CookieJar();
    const outcome = await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: `/after/${RUN_TAG}/secure`,
    });

    const [binding] = outcome.start.setCookie;
    expect(binding).toBeDefined();
    expect(binding).toContain('__Host-wewin_oauth_');
    expect(binding).toContain('HttpOnly');
    expect(binding).toContain('Secure');
    expect(binding).toContain('SameSite=None');
    expect(binding).toContain('Path=/');
    // `__Host-` requires the absence of Domain as much as the presence of Secure.
    expect(binding).not.toContain('Domain=');

    expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/after/${RUN_TAG}/secure`);
    expect(app.sessions.lastUserId).toBeDefined();

    // And the flow's secret does not outlive it: the callback clears the same name.
    expect(jar.names().filter((name) => name.startsWith('__Host-wewin_oauth_'))).toEqual([]);
  });

  it('refuses the same callback delivered to a browser that did not start the flow', async () => {
    google.reset();
    app.sessions.reset();
    google.account = {
      subject: subjectFor('secure-attack'),
      email: emailFor('secure-attack'),
      emailVerified: true,
    };

    // ⓑ, in the profile that ships: the attacker starts the flow in their own browser and
    // gets the victim's browser to open the callback. The victim's jar has no binding cookie.
    const outcome = await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar: new CookieJar(),
      callbackJar: new CookieJar(),
      returnTo: `/after/${RUN_TAG}/secure-attack`,
    });

    expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    expect(app.sessions.lastUserId).toBeUndefined();
  });
});
