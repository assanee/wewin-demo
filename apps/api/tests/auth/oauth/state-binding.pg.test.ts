import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OAuthStateService } from '../../../src/auth/oauth/oauth-state.service';
import { CookieJar, authorizeAt, get, signIn } from './support/browser';
import { FakeProvider } from './support/fake-provider';
import { RUN_TAG, TestDb, databaseUrl, emailFor, subjectFor } from './support/db';
import { WEB_BASE_URL, bootOAuthApp, freePort, type BootedOAuthApp } from './support/oauth-app';

/**
 * ⓑ The attack in plan 6(b), written as the attack.
 *
 * > A server-side row alone removes CSRF protection entirely: the attacker starts the flow,
 * > signs in as themselves, and gets the victim's browser to open the callback — logging the
 * > victim into the attacker's account.
 *
 * Every check on the server passes in that scenario, because the `state` is genuine. It just
 * belongs to somebody else's browser. So the test below is two `CookieJar`s — two browsers —
 * and the assertion is that the one which did not start the flow gets nothing.
 *
 * The rest of the suite is the other ways the same row could be spent: replayed, expired,
 * cross-provider, or presented with a cookie from a different flow. All four answer
 * identically, which is deliberate: a distinguishable "expired" versus "wrong browser" is an
 * oracle for somebody probing a `state` they hold.
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('OAuth state is bound to the browser', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  let google: FakeProvider;
  let line: FakeProvider;
  let app: BootedOAuthApp;
  let lineApp: BootedOAuthApp;

  beforeAll(async () => {
    google = new FakeProvider('google');
    line = new FakeProvider('line');
    await google.listen();
    await line.listen();
    app = await bootOAuthApp({ databaseUrl: url, provider: google, port: await freePort() });
    lineApp = await bootOAuthApp({ databaseUrl: url, provider: line, port: await freePort() });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await lineApp.close();
    await google.close();
    await line.close();
    await db.cleanUp();
    await db.close();
  });

  beforeEach(() => {
    google.reset();
    line.reset();
    app.sessions.reset();
    lineApp.sessions.reset();
    google.account = { subject: subjectFor('binding'), email: emailFor('binding'), emailVerified: true };
    line.account = { subject: subjectFor('binding-line'), email: emailFor('binding-line') };
  });

  const returnTo = (label: string): string => `/after/${RUN_TAG}/${label}`;

  it('refuses a callback delivered to a browser that did not start the flow', async () => {
    const attacker = new CookieJar();
    const victim = new CookieJar();

    // The attacker starts the flow themselves and holds a perfectly genuine `state`.
    const outcome = await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar: attacker,
      callbackJar: victim,
      returnTo: returnTo('csrf'),
    });

    expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    // The victim is not signed in — not as themselves, and above all not as the attacker.
    expect(app.sessions.issued).toHaveLength(0);
    expect(outcome.callback.setCookie.some((cookie) => cookie.startsWith('wewin_session='))).toBe(false);

    /*
     * And the row was never claimed, which is the part that names *which* check refused.
     *
     * Worth being precise about, because mutation testing showed this scenario is closed
     * four times over — the binding digest, the local PKCE check, the derived nonce, and
     * PKCE at the provider — so "the victim was not signed in" stays true with any one of
     * them removed and says nothing about which. `consumed_at` is still null only if the
     * consume's WHERE clause refused, which is fix ⓑ itself and nothing downstream of it.
     */
    const [row] = await db.statesForReturnTo(returnTo('csrf'));
    expect(row?.consumed_at).toBeNull();
  });

  it('signs in when the same browser completes the flow, which is the control for the test above', async () => {
    const jar = new CookieJar();
    const outcome = await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: returnTo('control'),
    });

    expect(outcome.callback.location).toBe(`${WEB_BASE_URL}${returnTo('control')}`);
    expect(app.sessions.issued).toHaveLength(1);
  });

  it('refuses a callback whose cookie carries the wrong binding secret', async () => {
    /*
     * The check the two tests around this one do not reach, and the one plan 6(b) is really
     * about. The cookie is this flow's — right name, right PKCE verifier, so every other
     * check passes — and only the binding half is somebody else's. If `binding_hash` were
     * not in the consume's WHERE clause, this would sign the browser in.
     *
     * Written as a mutation exercise found it: the first version of this suite proved the
     * binding check only in company with the cookie-presence check and the verifier check,
     * so removing `binding_hash` from the statement failed nothing.
     */
    const jar = new CookieJar();
    const other = new CookieJar();

    const start = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);
    await get(`${app.baseUrl}/auth/oauth/google/start`, other);

    const name = jar.names().find((cookie) => cookie.startsWith('wewin_oauth_'));
    const otherName = other.names().find((cookie) => cookie.startsWith('wewin_oauth_'));
    if (name === undefined || otherName === undefined) throw new Error('no state cookie was set');

    const foreignBinding = (other.get(otherName) ?? '').split('.')[0] ?? '';
    const ownVerifier = (jar.get(name) ?? '').split('.')[1] ?? '';
    jar.set(name, `${foreignBinding}.${ownVerifier}`);

    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const before = google.tokenRequests.length;
    const callback = await get(handback.callbackUrl, jar);

    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    // Refused by the row, before the authorisation code was spent.
    expect(google.tokenRequests).toHaveLength(before);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('refuses a second delivery of the same callback', async () => {
    const jar = new CookieJar();
    const start = await get(
      `${app.baseUrl}/auth/oauth/google/start?returnTo=${encodeURIComponent(returnTo('replay'))}`,
      jar,
    );
    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    // A second jar with the same cookies: the replay is not defeated by the cookie having
    // been cleared in the browser, it is defeated by the row.
    const replayJar = new CookieJar();
    replayJar.store(start.setCookie);

    const first = await get(handback.callbackUrl, jar);
    const afterFirst = google.tokenRequests.length;
    const second = await get(handback.callbackUrl, replayJar);

    expect(first.location).toBe(`${WEB_BASE_URL}${returnTo('replay')}`);
    expect(second.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    /*
     * Refused by `consumed_at IS NULL`, not by the provider refusing a spent code. Without
     * this assertion the test passes even with the consume check removed, because the fake —
     * like a real provider — will not exchange the same code twice. That makes the test look
     * like it covers replay while covering nothing this code does.
     */
    expect(google.tokenRequests).toHaveLength(afterFirst);
    expect(app.sessions.issued).toHaveLength(1);
  });

  it('refuses a flow whose row has expired', async () => {
    const jar = new CookieJar();
    const start = await get(
      `${app.baseUrl}/auth/oauth/google/start?returnTo=${encodeURIComponent(returnTo('expired'))}`,
      jar,
    );
    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const [row] = await db.statesForReturnTo(returnTo('expired'));
    if (row === undefined) throw new Error('the flow wrote no oauth_states row');
    await db.expireState(row.id);

    const callback = await get(handback.callbackUrl, jar);
    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('refuses a binding cookie from a different flow', async () => {
    const jar = new CookieJar();
    const other = new CookieJar();

    const start = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);
    await get(`${app.baseUrl}/auth/oauth/google/start`, other);

    // Keep this flow's cookie *name* and put the other flow's secrets inside it — a stolen
    // cookie value is worth nothing unless it is the value this row was minted with.
    const name = jar.names().find((cookie) => cookie.startsWith('wewin_oauth_'));
    const stolen = other.get(other.names().find((cookie) => cookie.startsWith('wewin_oauth_')) ?? '');
    if (name === undefined || stolen === undefined) throw new Error('no state cookie was set');
    jar.set(name, stolen);

    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const callback = await get(handback.callbackUrl, jar);
    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('refuses a cookie whose binding is right and whose PKCE verifier is not', async () => {
    /*
     * The narrow case the binding check alone does not cover: the cookie belongs to this
     * flow, so the row is claimed, and only then does the verifier turn out to be somebody
     * else's. The provider's token endpoint would refuse it too — the point of refusing here
     * is that the authorisation code is never spent, so nothing leaves this service.
     */
    const jar = new CookieJar();
    const other = new CookieJar();

    const start = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);
    await get(`${app.baseUrl}/auth/oauth/google/start`, other);

    const name = jar.names().find((cookie) => cookie.startsWith('wewin_oauth_'));
    const otherName = other.names().find((cookie) => cookie.startsWith('wewin_oauth_'));
    if (name === undefined || otherName === undefined) throw new Error('no state cookie was set');

    const binding = (jar.get(name) ?? '').split('.')[0] ?? '';
    const foreignVerifier = (other.get(otherName) ?? '').split('.')[1] ?? '';
    jar.set(name, `${binding}.${foreignVerifier}`);

    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const before = google.tokenRequests.length;
    const callback = await get(handback.callbackUrl, jar);

    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    expect(google.tokenRequests).toHaveLength(before);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('refuses a callback with no cookie at all', async () => {
    const jar = new CookieJar();
    const start = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);
    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const callback = await get(handback.callbackUrl, new CookieJar());
    expect(callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('refuses a state minted for one provider and presented to another', async () => {
    // Both apps share the jar because a real browser would: the cookie is scoped by name,
    // not by which provider the callback belongs to.
    const jar = new CookieJar();
    const start = await get(`${lineApp.baseUrl}/auth/oauth/line/start`, jar);
    const handback = await authorizeAt(start.location);
    if (handback.kind !== 'redirect') throw new Error('expected a redirect handback');

    const minted = new URL(handback.callbackUrl);
    const stateFromLine = minted.searchParams.get('state') ?? '';

    const before = google.tokenRequests.length;
    const crossed = await get(
      `${app.baseUrl}/auth/oauth/google/callback?code=whatever&state=${encodeURIComponent(stateFromLine)}`,
      jar,
    );

    expect(crossed.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
    /*
     * Refused by `provider = $3` in the consume, not by Google's token endpoint rejecting a
     * made-up code. The distinction matters: without the provider column in the WHERE clause,
     * a `state` minted for LINE claims a row here and this service goes on to trust whatever
     * the *other* provider's adapter makes of the response.
     */
    expect(google.tokenRequests).toHaveLength(before);
    expect(app.sessions.issued).toHaveLength(0);
  });

  it('clears the state cookie on success and on failure', async () => {
    const success = new CookieJar();
    await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar: success });
    expect(success.names().filter((name) => name.startsWith('wewin_oauth_'))).toEqual([]);

    const failure = new CookieJar();
    const victim = new CookieJar();
    await signIn({ apiBaseUrl: app.baseUrl, provider: google, jar: failure, callbackJar: victim });
    // The attacker's own jar keeps its cookie (it never saw the callback); the browser that
    // did see it is left holding nothing.
    expect(victim.names()).toEqual([]);
  });

  it('stores digests and the public challenge, and never a secret', async () => {
    const jar = new CookieJar();
    const start = await get(
      `${app.baseUrl}/auth/oauth/google/start?returnTo=${encodeURIComponent(returnTo('digests'))}`,
      jar,
    );

    const [row] = await db.statesForReturnTo(returnTo('digests'));
    if (row === undefined) throw new Error('the flow wrote no oauth_states row');

    const cookieName = jar.names().find((name) => name.startsWith('wewin_oauth_')) ?? '';
    const [binding, verifier] = (jar.get(cookieName) ?? '').split('.');
    const state = new URL(start.location).searchParams.get('state') ?? '';

    expect(row.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.binding_hash).toMatch(/^[0-9a-f]{64}$/);
    // A dump of this table completes nobody's flow: the URL half is hashed and the cookie
    // half never reached the server's disk.
    const asText = JSON.stringify(row);
    expect(asText).not.toContain(state);
    expect(asText).not.toContain(binding ?? 'binding-was-missing');
    expect(asText).not.toContain(verifier ?? 'verifier-was-missing');
  });

  it('claims a row once and answers "nothing" the second time, rather than raising', async () => {
    /*
     * Straight at the statement, because the HTTP flow cannot tell the two failures apart.
     * With `consumed_at IS NULL` removed from the WHERE clause, the second call still fails —
     * `auth_consume_once` in 0003_auth_guards.sql refuses to rewrite the column — but it
     * fails by *raising*, and a raise is a 500 waiting for a caller that does not catch it.
     * The predicate is what makes a replay an ordinary "no", and this is where that shows.
     */
    const states = app.app.get(OAuthStateService);
    const minted = await states.mint({
      provider: 'google',
      returnTo: returnTo('consume-twice'),
      guestCookie: undefined,
      ttlSeconds: 600,
    });

    const first = await states.consume({
      provider: 'google',
      state: minted.state,
      binding: minted.binding,
    });
    const second = await states.consume({
      provider: 'google',
      state: minted.state,
      binding: minted.binding,
    });

    expect(first?.returnTo).toBe(returnTo('consume-twice'));
    expect(second).toBeUndefined();
  });

  it('marks the row consumed exactly once', async () => {
    const jar = new CookieJar();
    await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: returnTo('consumed'),
    });

    const [row] = await db.statesForReturnTo(returnTo('consumed'));
    expect(row?.consumed_at).not.toBeNull();
  });

  it('lets two tabs sign in at once, because the cookie is named after the flow', async () => {
    // One fixed cookie name would make the second tab overwrite the first, and the first
    // tab's callback would then fail in a way indistinguishable from an attack.
    const jar = new CookieJar();
    const firstStart = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);
    const secondStart = await get(`${app.baseUrl}/auth/oauth/google/start`, jar);

    expect(jar.names().filter((name) => name.startsWith('wewin_oauth_'))).toHaveLength(2);

    const first = await authorizeAt(firstStart.location);
    const second = await authorizeAt(secondStart.location);
    if (first.kind !== 'redirect' || second.kind !== 'redirect') throw new Error('expected redirects');

    const firstCallback = await get(first.callbackUrl, jar);
    const secondCallback = await get(second.callbackUrl, jar);

    expect(firstCallback.location).toContain(WEB_BASE_URL);
    expect(firstCallback.location).not.toContain('error=');
    expect(secondCallback.location).not.toContain('error=');
    expect(app.sessions.issued).toHaveLength(2);
  });

  it('carries a guest through the round trip and claims it on the way back', async () => {
    const cart = await db.createGuest();
    const guestId = cart.id;
    const jar = new CookieJar();
    jar.set('wewin_guest', cart.cookie);

    await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: returnTo('guest'),
    });

    const [row] = await db.statesForReturnTo(returnTo('guest'));
    expect(row?.guest_id).toBe(guestId);

    const guest = await db.guest(guestId);
    expect(guest?.claimed_by_user_id).toBe(app.sessions.lastUserId);
    expect(app.sessions.issued[0]?.guestId).toBe(guestId);
  });

  it('ignores a guest cookie that names no row rather than failing the login', async () => {
    const jar = new CookieJar();
    jar.set('wewin_guest', '00000000-0000-4000-8000-000000000000');

    await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: returnTo('ghost-guest'),
    });

    const [row] = await db.statesForReturnTo(returnTo('ghost-guest'));
    expect(row?.guest_id).toBeNull();
    expect(app.sessions.issued).toHaveLength(1);
  });

  it('ignores a guest cookie that is not a uuid', async () => {
    const jar = new CookieJar();
    jar.set('wewin_guest', "'; drop table guests; --");

    await signIn({
      apiBaseUrl: app.baseUrl,
      provider: google,
      jar,
      returnTo: returnTo('bad-guest'),
    });

    const [row] = await db.statesForReturnTo(returnTo('bad-guest'));
    expect(row?.guest_id).toBeNull();
    expect(app.sessions.issued).toHaveLength(1);
  });
});
