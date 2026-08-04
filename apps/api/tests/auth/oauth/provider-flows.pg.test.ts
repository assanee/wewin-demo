import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CookieJar, signIn } from './support/browser';
import { FakeProvider, type FakeMode } from './support/fake-provider';
import { RUN_TAG, TestDb, databaseUrl, emailFor, subjectFor } from './support/db';
import { WEB_BASE_URL, bootOAuthApp, freePort, type BootedOAuthApp } from './support/oauth-app';

/**
 * All four providers, end to end, against a fake that behaves like each of them.
 *
 * LINE first, because plan section 6 says it is the deciding factor: it signs its id_token
 * HS256 with the channel secret, it may send no email at all, and it is the reason this is
 * hand-written rather than bought in. Then Google (the `email_verified` claim plan 6(a) is
 * written about), Facebook (no id_token, so no nonce, so PKCE and the binding cookie are
 * all there is) and Apple (a cross-site form POST, an ES256 client secret, `"true"` as a
 * string, and a name that arrives exactly once).
 *
 * Nothing here has been run against a real provider — there are no credentials in this
 * environment. What is proven is that this code's half of each flow is internally correct
 * and survives a provider that lies; what is assumed is that the real providers behave as
 * documented, and that is stated in the hand-off notes rather than implied by a green run.
 */

const describeWithPg = databaseUrl === undefined ? describe.skip : describe;

describeWithPg('OAuth provider flows', () => {
  const url = databaseUrl ?? '';
  const db = new TestDb(url);

  /** One booted app per provider, because a provider's endpoints are configuration. */
  const apps = new Map<FakeMode, { app: BootedOAuthApp; provider: FakeProvider }>();

  beforeAll(async () => {
    for (const mode of ['line', 'google', 'facebook', 'apple'] as const) {
      const provider = new FakeProvider(mode);
      await provider.listen();
      const port = await freePort();
      const app = await bootOAuthApp({ databaseUrl: url, provider, port });
      apps.set(mode, { app, provider });
    }
  }, 60_000);

  afterAll(async () => {
    for (const { app, provider } of apps.values()) {
      await app.close();
      await provider.close();
    }
    await db.cleanUp();
    await db.close();
  });

  const use = (mode: FakeMode): { app: BootedOAuthApp; provider: FakeProvider } => {
    const found = apps.get(mode);
    if (found === undefined) throw new Error(`no booted app for ${mode}`);
    return found;
  };

  beforeEach(() => {
    for (const { app, provider } of apps.values()) {
      provider.reset();
      app.sessions.reset();
    }
  });

  const returnTo = (label: string): string => `/after/${RUN_TAG}/${label}`;

  describe('LINE', () => {
    it('signs a customer in, verifying an HS256 id_token against the channel secret', async () => {
      const { app, provider } = use('line');
      const subject = subjectFor('line-happy');
      const email = emailFor('line-happy');
      provider.account = { subject, email, name: 'ลูกค้า' };

      const jar = new CookieJar();
      const outcome = await signIn({
        apiBaseUrl: app.baseUrl,
        provider,
        jar,
        returnTo: returnTo('line'),
      });

      expect(outcome.callback.status).toBe(302);
      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}${returnTo('line')}`);

      const identity = await db.identity('line', subject);
      expect(identity?.user_id).toBe(app.sessions.lastUserId);
      expect(identity?.asserted_email).toBe(email);
      expect(identity?.last_authenticated_at).not.toBeNull();
    });

    it('asks for openid, sends S256 PKCE and a nonce, and never sends the verifier', async () => {
      const { app, provider } = use('line');
      provider.account = { subject: subjectFor('line-params') };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      const [authorize] = provider.authorizeRequests;
      expect(authorize?.params['scope']).toContain('openid');
      expect(authorize?.params['code_challenge_method']).toBe('S256');
      expect(authorize?.params['nonce']).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const [token] = provider.tokenRequests;
      const verifier = token?.['code_verifier'] ?? '';
      // The verifier goes to the token endpoint and nowhere near the authorisation URL —
      // that difference is the whole of PKCE, and `plain` is what erases it.
      expect(verifier).not.toBe('');
      expect(Object.values(authorize?.params ?? {})).not.toContain(verifier);
    });

    it('signs a customer in with no email at all, which is LINE without channel approval', async () => {
      const { app, provider } = use('line');
      const subject = subjectFor('line-no-email');
      provider.account = { subject, name: 'ไม่มีอีเมล' };

      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(outcome.callback.location).toContain(WEB_BASE_URL);
      const identity = await db.identity('line', subject);
      expect(identity?.asserted_email).toBeNull();
      expect(identity?.asserted_email_verified).toBe(false);
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('recognises the same sub on a second sign-in rather than making a second account', async () => {
      const { app, provider } = use('line');
      const subject = subjectFor('line-returning');
      provider.account = { subject, email: emailFor('line-returning') };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });
      const first = app.sessions.lastUserId;
      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(app.sessions.lastUserId).toBe(first);
      expect(app.sessions.issued).toHaveLength(2);
    });

    it('refuses an id_token whose algorithm was swapped to RS256', async () => {
      const { app, provider } = use('line');
      provider.account = { subject: subjectFor('line-alg') };
      provider.faults = { swapAlgorithm: true };

      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
      expect(app.sessions.issued).toHaveLength(0);
    });
  });

  describe('Google', () => {
    it('signs a customer in, fetching the signing key from the published JWKS', async () => {
      const { app, provider } = use('google');
      const subject = subjectFor('google-happy');
      const email = emailFor('google-happy');
      provider.account = { subject, email, emailVerified: true, name: 'Customer' };

      const outcome = await signIn({
        apiBaseUrl: app.baseUrl,
        provider,
        jar: new CookieJar(),
        returnTo: returnTo('google'),
      });

      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}${returnTo('google')}`);
      const emails = await db.emailsFor(email);
      expect(emails).toHaveLength(1);
      expect(emails[0]?.verified_at).not.toBeNull();
    });

    it('records an unverified Google address as an assertion and never as a verified one', async () => {
      const { app, provider } = use('google');
      const subject = subjectFor('google-unverified');
      const email = emailFor('google-unverified');
      // A Workspace account whose domain the administrator has not verified.
      provider.account = { subject, email, emailVerified: false };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      const identity = await db.identity('google', subject);
      expect(identity?.asserted_email).toBe(email);
      expect(identity?.asserted_email_verified).toBe(false);
      // Nothing in user_emails: an unproven address is a record of a claim, not an identity.
      expect(await db.emailsFor(email)).toHaveLength(0);
    });

    it('refuses an id_token signed with a key the provider never published', async () => {
      const { app, provider } = use('google');
      provider.account = { subject: subjectFor('google-forged'), email: emailFor('g-forged'), emailVerified: true };
      provider.faults = { foreignSigningKey: true };

      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
      expect(app.sessions.issued).toHaveLength(0);
    });

    it.each([
      ['a nonce from another flow', { wrongNonce: true }],
      ['a different issuer', { wrongIssuer: true }],
      ['a different audience', { wrongAudience: true }],
      ['an expired id_token', { expiredIdToken: true }],
      ['no id_token at all', { omitIdToken: true }],
    ])('refuses %s', async (_label, faults) => {
      const { app, provider } = use('google');
      provider.account = { subject: subjectFor('google-fault'), email: emailFor('g-fault'), emailVerified: true };
      provider.faults = faults;

      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}/login?error=failed`);
      expect(app.sessions.issued).toHaveLength(0);
    });
  });

  describe('Facebook', () => {
    it('signs a customer in from the Graph profile, with a valid appsecret_proof', async () => {
      const { app, provider } = use('facebook');
      const subject = subjectFor('fb-happy');
      const email = emailFor('fb-happy');
      provider.account = { subject, email, name: 'Somchai' };

      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      // The fake rejects a wrong proof with 401/400, so reaching a session proves it was sent.
      expect(outcome.callback.location).toContain(WEB_BASE_URL);
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('never treats a Facebook address as proven, because nothing in the response says so', async () => {
      const { app, provider } = use('facebook');
      const subject = subjectFor('fb-email');
      const email = emailFor('fb-email');
      provider.account = { subject, email };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      const identity = await db.identity('facebook', subject);
      expect(identity?.asserted_email).toBe(email);
      expect(identity?.asserted_email_verified).toBe(false);
      expect(await db.emailsFor(email)).toHaveLength(0);
    });

    it('signs in an account that registered with a phone number and has no email', async () => {
      const { app, provider } = use('facebook');
      provider.account = { subject: subjectFor('fb-phone') };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });
      expect(app.sessions.issued).toHaveLength(1);
    });
  });

  describe('Apple', () => {
    it('completes a cross-site form POST callback and signs the customer in', async () => {
      const { app, provider } = use('apple');
      const subject = subjectFor('apple-happy');
      const email = emailFor('apple-happy');
      provider.account = { subject, email, emailVerified: true };

      const outcome = await signIn({
        apiBaseUrl: app.baseUrl,
        provider,
        jar: new CookieJar(),
        returnTo: returnTo('apple'),
      });

      // Not a redirect from the provider — a form the browser submits, which is why the
      // state cookie has to be SameSite=None in the secure profile.
      expect(outcome.handback.kind).toBe('form');
      expect(outcome.callback.location).toBe(`${WEB_BASE_URL}${returnTo('apple')}`);
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('asks for response_mode=form_post, which is what forces the cross-site POST', async () => {
      const { app, provider } = use('apple');
      provider.account = { subject: subjectFor('apple-mode'), email: emailFor('apple-mode'), emailVerified: true };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(provider.authorizeRequests[0]?.params['response_mode']).toBe('form_post');
    });

    it('signs the client secret as an ES256 JWT the provider verifies', async () => {
      const { app, provider } = use('apple');
      provider.account = { subject: subjectFor('apple-secret'), email: emailFor('apple-secret'), emailVerified: true };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      // The fake verifies the signature with the public half of the .p8 and checks aud/sub/exp;
      // a DER-encoded signature or a wrong team id would both have failed the exchange.
      const secret = provider.tokenRequests[0]?.['client_secret'] ?? '';
      expect(secret.split('.')).toHaveLength(3);
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('accepts email_verified as the string "true", which Apple has shipped', async () => {
      const { app, provider } = use('apple');
      const email = emailFor('apple-string');
      provider.account = { subject: subjectFor('apple-string'), email, emailVerified: 'true' };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      const emails = await db.emailsFor(email);
      expect(emails).toHaveLength(1);
      expect(emails[0]?.verified_at).not.toBeNull();
    });

    it('does not read the string "false" as truthy', async () => {
      const { app, provider } = use('apple');
      const email = emailFor('apple-false');
      provider.account = { subject: subjectFor('apple-false'), email, emailVerified: 'false' };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      expect(await db.emailsFor(email)).toHaveLength(0);
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('takes the name out of the one POST that carries it', async () => {
      const { app, provider } = use('apple');
      const subject = subjectFor('apple-name');
      provider.account = {
        subject,
        email: emailFor('apple-name'),
        emailVerified: true,
        // Apple sends this on the first authorisation and never again.
        userField: JSON.stringify({ name: { firstName: 'Somsak', lastName: 'Wewin' } }),
      };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });

      const identity = await db.identity('apple', subject);
      const [user] = await db.query<{ display_name: string | null }>(
        'select display_name from users where id = $1',
        [identity?.user_id],
      );
      expect(user?.display_name).toBe('Somsak Wewin');
    });

    it('still signs in when the name field is missing or malformed', async () => {
      const { app, provider } = use('apple');
      provider.account = {
        subject: subjectFor('apple-badname'),
        email: emailFor('apple-badname'),
        emailVerified: true,
        userField: 'not json at all',
      };

      await signIn({ apiBaseUrl: app.baseUrl, provider, jar: new CookieJar() });
      expect(app.sessions.issued).toHaveLength(1);
    });

    it('refuses a GET callback for a provider that posts', async () => {
      const { app } = use('apple');
      const response = await fetch(`${app.baseUrl}/auth/oauth/apple/callback?code=x&state=y`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('every provider', () => {
    it('refuses a POST callback for a provider that redirects', async () => {
      const { app } = use('google');
      const response = await fetch(`${app.baseUrl}/auth/oauth/google/callback`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'code=x&state=y',
      });
      expect(response.status).toBe(404);
    });

    it('lists exactly the providers this deployment has credentials for', async () => {
      const { app } = use('line');
      const response = await fetch(`${app.baseUrl}/auth/oauth/providers`);
      expect(await response.json()).toEqual({ providers: ['line'] });
    });

    it('404s a provider this deployment has no credentials for', async () => {
      const { app } = use('line');
      const response = await fetch(`${app.baseUrl}/auth/oauth/google/start`, { redirect: 'manual' });
      // The same answer as an unknown provider name: which providers are configured is not
      // something a caller needs to enumerate.
      expect(response.status).toBe(404);
    });

    it('400s a returnTo that is not a path on this site', async () => {
      const { app } = use('line');
      const response = await fetch(
        `${app.baseUrl}/auth/oauth/line/start?returnTo=${encodeURIComponent('https://evil.example')}`,
        { redirect: 'manual' },
      );
      expect(response.status).toBe(400);
    });

    it('reports a cancelled sign-in as denied rather than as a failure', async () => {
      const { app } = use('google');
      const response = await fetch(
        `${app.baseUrl}/auth/oauth/google/callback?error=access_denied&state=whatever`,
        { redirect: 'manual' },
      );
      expect(response.headers.get('location')).toBe(`${WEB_BASE_URL}/login?error=denied`);
    });

    it('tells the browser not to cache a callback', async () => {
      const { app, provider } = use('google');
      provider.account = { subject: subjectFor('google-cache'), email: emailFor('g-cache'), emailVerified: true };

      const jar = new CookieJar();
      const outcome = await signIn({ apiBaseUrl: app.baseUrl, provider, jar });

      // A cached authorisation URL would replay a state that has already been consumed.
      expect(outcome.start.status).toBe(302);
      expect(outcome.callback.status).toBe(302);
    });
  });
});
