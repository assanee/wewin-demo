import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guestCookieName } from '../../src/rbac/identity';
import { bootRbacApp, type BootedRbacApp, type PermissionTable } from './support/boot';
import { GuardedModule, TEST_USER_HEADER } from './fixtures/guarded.module';

/** The guard is booted with `cookieSecure: false` below, so this is the bare name. */
const GUEST_COOKIE_NAME = guestCookieName(false);

/**
 * The secret half of the guest cookie.
 *
 * `readGuestCookie` refuses a cookie that carries only an id (see `rbac/guest-cookie.ts`: a
 * name is not a capability), so every fixture here has to present a well-formed one. Whether
 * it *matches* is `GuestRepository`'s question and is proved against Postgres in
 * `tests/rbac/guest-capability.pg.test.ts`; these files are about the guard's policy matrix.
 */
const GUEST_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const guestCookieValue = (guestId: string): string => `${guestId}.${GUEST_SECRET}`;

/**
 * What the guard does with each principal on each kind of route.
 *
 * The responses carry the *resolved scope*, not just a status, because the interesting
 * failures are not "allowed when it should not be" — those are loud. They are "allowed as
 * the wrong principal": a guest served as `public` loses their cart, and a `public` caller
 * served as a guest reads somebody else's.
 */

const CLERK = '3f1c2d4e-0000-4000-8000-000000000001';
const MANAGER = '3f1c2d4e-0000-4000-8000-000000000002';
const NOBODY = '3f1c2d4e-0000-4000-8000-000000000003';
const GUEST = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e12';

const SUSPENDED = '3f1c2d4e-0000-4000-8000-000000000004';

const PERMISSIONS: PermissionTable = new Map([
  [CLERK, { permissions: ['orders.read'] as const }],
  [MANAGER, { permissions: ['orders.read', 'orders.refund'] as const }],
  [NOBODY, {}],
  // Suspended, and deliberately still carrying a permission: the point is that the ban wins
  // over the grant, not that a banned account happens to have nothing.
  [SUSPENDED, { permissions: ['orders.read', 'orders.refund'] as const, status: 'suspended' }],
]);

describe('RbacGuard', () => {
  let booted: BootedRbacApp;

  beforeAll(async () => {
    booted = await bootRbacApp({ modules: [GuardedModule], permissions: PERMISSIONS });
  });

  afterAll(async () => {
    await booted.close();
  });

  const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${booted.baseUrl}${path}`, { headers });

  const scopeOf = async (response: Response): Promise<string> => {
    const body = (await response.json()) as { scope: string };
    return body.scope;
  };

  describe('anonymous routes — the funnel', () => {
    it('serves a caller with nothing at all as public', async () => {
      const response = await get('/fixture/anonymous');
      expect(response.status).toBe(200);
      expect(await scopeOf(response)).toBe('public');
    });

    it('serves a caller carrying a guest cookie as that guest', async () => {
      /*
       * Plan section 6: the anonymous visitor is the main funnel and needs a referent, or
       * the whole path is unrepresentable. This is that referent arriving on a request —
       * the same id a cart row carries a foreign key to.
       */
      const response = await get('/fixture/anonymous', { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}` });
      expect(response.status).toBe(200);
      expect(await scopeOf(response)).toBe(`guest:${GUEST}`);
    });

    it('reads the guest cookie out of a jar with other cookies in it', async () => {
      const response = await get('/fixture/anonymous', {
        cookie: `locale=th; ${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}; theme=dark`,
      });
      expect(await scopeOf(response)).toBe(`guest:${GUEST}`);
    });

    it('treats a hand-written guest cookie as no guest at all', async () => {
      // A guest id is a bearer capability for a cart. Believing a string that is not a
      // uuid would put whatever somebody typed into a query.
      const response = await get('/fixture/anonymous', { cookie: `${GUEST_COOKIE_NAME}=' or 1=1--` });
      expect(response.status).toBe(200);
      expect(await scopeOf(response)).toBe('public');
    });

    it('prefers the signed-in identity over a guest cookie that is still in the jar', async () => {
      const response = await get('/fixture/anonymous', {
        [TEST_USER_HEADER]: CLERK,
        cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}`,
      });
      expect(await scopeOf(response)).toBe(`user:${CLERK}`);
    });
  });

  /**
   * A guest cookie is a claim about a row, and the row has to agree.
   *
   * The guard used to believe any well-formed uuid. Two things follow from checking, and
   * the second is the security one: a request can no longer be scoped to a `guests.id` that
   * is nobody's, and — because signing in sets `claimed_by_user_id` — an id stops being an
   * anonymous capability the moment the cart behind it belongs to an account. That is what
   * makes planting a guest cookie in a victim's browser pointless: after their sign-in
   * claims it, whoever else holds the id is `public`.
   */
  describe('the guest cookie against the guests table', () => {
    const CLAIMED = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e99';

    it('serves a claimed or unknown guest id as public, not as that guest', async () => {
      const app = await bootRbacApp({
        modules: [GuardedModule],
        permissions: PERMISSIONS,
        openGuests: [GUEST],
      });
      try {
        const open = await fetch(`${app.baseUrl}/fixture/anonymous`, {
          headers: { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}` },
        });
        expect(await scopeOf(open)).toBe(`guest:${GUEST}`);

        const claimed = await fetch(`${app.baseUrl}/fixture/anonymous`, {
          headers: { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(CLAIMED)}` },
        });
        expect(claimed.status).toBe(200);
        expect(await scopeOf(claimed)).toBe('public');
      } finally {
        await app.close();
      }
    });

    it('serves the anonymous funnel as public when the guests table cannot be read', async () => {
      // Not 503. A guest scope buys a cart and no permission, so falling back costs an
      // anonymous visitor a cart they could not have loaded during the outage anyway —
      // whereas 503-ing every anonymous route turns a database blip into a dark storefront.
      const app = await bootRbacApp({
        modules: [GuardedModule],
        permissions: PERMISSIONS,
        guestsUnavailable: true,
      });
      try {
        const response = await fetch(`${app.baseUrl}/fixture/anonymous`, {
          headers: { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}` },
        });
        expect(response.status).toBe(200);
        expect(await scopeOf(response)).toBe('public');
      } finally {
        await app.close();
      }
    });
  });

  /**
   * A suspended account is refused on every route that needs a principal.
   *
   * `users.status` was written by the schema and read by nothing: an administrator could
   * suspend somebody, revoke every session, and watch them keep working. Revoking the
   * session is not enough on its own either — an access token is verified by signature
   * alone, so the ones already issued keep verifying for up to their full lifetime. This
   * check rides along on the permission read the request makes anyway, which is what closes
   * that window to the next request rather than the next ten minutes.
   */
  describe('a suspended account', () => {
    it('is refused with 401 on a route that only needs a signed-in user', async () => {
      const response = await get('/fixture/signed-in', { [TEST_USER_HEADER]: SUSPENDED });
      expect(response.status).toBe(401);
    });

    it('is refused on a permission route even though the permission is granted', async () => {
      const response = await get('/fixture/refunds', { [TEST_USER_HEADER]: SUSPENDED });
      expect(response.status).toBe(401);
    });

    it('is refused on an anonymous route rather than being served as themselves', async () => {
      // 401 and not "served as public": the caller presented a credential this service
      // issued, and answering 200 would tell them nothing is wrong.
      const response = await get('/fixture/anonymous', { [TEST_USER_HEADER]: SUSPENDED });
      expect(response.status).toBe(401);
    });
  });

  describe('routes that need a signed-in user', () => {
    it('turns away the public with 401', async () => {
      const response = await get('/fixture/signed-in');
      expect(response.status).toBe(401);
    });

    it('turns away a guest with 401 — a cart is not an account', async () => {
      const response = await get('/fixture/signed-in', { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}` });
      expect(response.status).toBe(401);
    });

    it('lets a signed-in user through even with no permissions at all', async () => {
      const response = await get('/fixture/signed-in', { [TEST_USER_HEADER]: NOBODY });
      expect(response.status).toBe(200);
      expect(await scopeOf(response)).toBe(`user:${NOBODY}`);
    });
  });

  describe('routes that need permissions', () => {
    it('answers 401 for the public, not 403 — there is nobody to forbid yet', async () => {
      expect((await get('/fixture/orders')).status).toBe(401);
    });

    it('answers 403 for a signed-in user who lacks the permission', async () => {
      const response = await get('/fixture/orders', { [TEST_USER_HEADER]: NOBODY });
      expect(response.status).toBe(403);
      // Naming the missing code is what makes this a support answer rather than a ticket.
      expect(JSON.stringify(await response.json())).toContain('orders.read');
    });

    it('lets a user holding the permission through', async () => {
      const response = await get('/fixture/orders', { [TEST_USER_HEADER]: CLERK });
      expect(response.status).toBe(200);
      expect(await scopeOf(response)).toBe(`user:${CLERK}`);
    });

    it('requires every listed permission, not any of them', async () => {
      // The clerk holds orders.read and not orders.refund. "Any of these" is how a route
      // ends up reachable by the weakest permission in a list somebody extended later.
      const partial = await get('/fixture/refunds', { [TEST_USER_HEADER]: CLERK });
      expect(partial.status).toBe(403);
      expect(JSON.stringify(await partial.json())).toContain('orders.refund');

      const full = await get('/fixture/refunds', { [TEST_USER_HEADER]: MANAGER });
      expect(full.status).toBe(200);
    });
  });

  describe('GET /me — what a menu is derived from', () => {
    it('answers a signed-in user with the permissions the guard would enforce', async () => {
      const response = await get('/me', { [TEST_USER_HEADER]: MANAGER });
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        kind: 'user',
        userId: MANAGER,
        guestId: null,
        groupIds: [],
        permissions: ['orders.read', 'orders.refund'],
      });
    });

    it('answers a guest with their cart id and an empty permission set', async () => {
      // The funnel's answer. A menu built from this is the public menu, which is correct —
      // and a client that renders more anyway still gets 403 from the endpoint itself.
      const response = await get('/me', { cookie: `${GUEST_COOKIE_NAME}=${guestCookieValue(GUEST)}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        kind: 'guest',
        userId: null,
        guestId: GUEST,
        groupIds: [],
        permissions: [],
      });
    });

    it('answers a first-time visitor without inventing a guest for them', async () => {
      const response = await get('/me');
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        kind: 'public',
        userId: null,
        guestId: null,
        groupIds: [],
        permissions: [],
      });
    });
  });

  it('never routes an undeclared path — the framework 404 still applies', async () => {
    expect((await get('/fixture/nope')).status).toBe(404);
  });
});

describe('RbacGuard when permissions cannot be read', () => {
  let booted: BootedRbacApp;

  beforeAll(async () => {
    booted = await bootRbacApp({ modules: [GuardedModule], permissionsUnavailable: true });
  });

  afterAll(async () => {
    await booted.close();
  });

  it('answers 503 rather than 403, and does not serve the route', async () => {
    /*
     * A database restart must not read as "your access was revoked". 403 would send a
     * user to an administrator who would find nothing wrong; 503 sends them back in a
     * minute, and is what a client retries on.
     */
    const response = await fetch(`${booted.baseUrl}/fixture/orders`, {
      headers: { [TEST_USER_HEADER]: '3f1c2d4e-0000-4000-8000-000000000001' },
    });
    expect(response.status).toBe(503);
  });

  it('still serves the anonymous funnel — it needs no permission lookup', async () => {
    const response = await fetch(`${booted.baseUrl}/fixture/anonymous`);
    expect(response.status).toBe(200);
  });

  it('does not fail closed into 500 for a signed-in route either', async () => {
    const response = await fetch(`${booted.baseUrl}/fixture/signed-in`, {
      headers: { [TEST_USER_HEADER]: '3f1c2d4e-0000-4000-8000-000000000001' },
    });
    expect(response.status).toBe(503);
  });
});
