import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeAccess, isRouteAccess, principalAccess } from '../../src/rbac/access';
import { guestCookieName } from '../../src/rbac/identity';
import { PrincipalModule } from './fixtures/principal.module';
import { TEST_USER_HEADER } from './fixtures/guarded.module';
import { bootRbacApp, type BootedRbacApp, type PermissionTable } from './support/boot';

/**
 * `RequirePrincipal` — the route policy the order lifecycle needs and the other three
 * cannot express.
 *
 * Phase 5a added it, and the reason is worth restating where it is tested. An order route
 * is reachable by a guest: plan section 6 says the anonymous visitor is the main funnel,
 * and a visitor configures, is quoted and submits before there is an account.
 *
 *   `RequireAuthenticated` refuses the guest — the funnel closed.
 *   `AllowAnonymous` admits the public *and*, worse, prints as an anonymous route in the
 *     boot audit. An order endpoint listed under "deliberately anonymous" is the exact
 *     misreading plan 7.4 trap 2 is about: it looks like a decision to publish.
 *   `RequirePermissions` is the staff answer. A customer holds no permission over their own
 *     order and never will.
 *
 * What the policy asserts is narrow: **there is a principal with a referent to scope rows
 * by.** Which rows is `src/orders/scope`'s question, answered in a WHERE clause. The last
 * test here says so out loud, because a policy named after ownership is a policy somebody
 * will eventually read as *proving* ownership.
 */

const CUSTOMER = '3f1c2d4e-0000-4000-8000-000000000011';
const SUSPENDED = '3f1c2d4e-0000-4000-8000-000000000012';
const GUEST = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e21';
const CLAIMED_GUEST = '0190bd3f-9e6a-7c2b-8f11-2a4b6c8d0e22';

const GUEST_COOKIE = guestCookieName(false);

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

const PERMISSIONS: PermissionTable = new Map([
  [CUSTOMER, {}],
  [SUSPENDED, { status: 'suspended' }],
]);

describe('RequirePrincipal', () => {
  let booted: BootedRbacApp;

  beforeAll(async () => {
    booted = await bootRbacApp({
      modules: [PrincipalModule],
      permissions: PERMISSIONS,
      // Only the first is a live, unclaimed row. The second stands for a guest that signed
      // in: `isOpenGuest` refuses it, which is what revokes the planted-cookie capability.
      openGuests: [GUEST],
    });
  });

  afterAll(async () => {
    await booted.close();
  });

  const get = (headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${booted.baseUrl}/fixture/principal`, { headers });

  const scopeOf = async (response: Response): Promise<string> => {
    const body = (await response.json()) as { scope: string };
    return body.scope;
  };

  it('admits a signed-in customer holding no permission at all', async () => {
    /*
     * The whole point of not using `RequirePermissions` here. A customer's authority over
     * their own order is ownership, not a grant; if this needed a permission there would
     * have to be a row in `group_permissions` per customer.
     */
    const response = await get({ [TEST_USER_HEADER]: CUSTOMER });
    expect(response.status).toBe(200);
    expect(await scopeOf(response)).toBe(`user:${CUSTOMER}`);
  });

  it('admits a guest as that guest — the funnel, with its referent intact', async () => {
    const response = await get({ cookie: `${GUEST_COOKIE}=${guestCookieValue(GUEST)}` });
    expect(response.status).toBe(200);
    // Not merely 200: served as `public` the caller would be admitted and then own nothing,
    // which is a cart that vanishes rather than an error anybody sees.
    expect(await scopeOf(response)).toBe(`guest:${GUEST}`);
  });

  it('refuses a caller with no principal at all', async () => {
    const response = await get();
    expect(response.status).toBe(401);
  });

  it('refuses a guest cookie that has been claimed, falling back to public', async () => {
    /*
     * The claim is what revokes the capability (`rbac/guest-cookie.ts`), and this route must
     * not become the place that honours it anyway. 401 rather than 200-as-somebody: after
     * signing in the browser has a session, and that is what it should be using.
     */
    const response = await get({ cookie: `${GUEST_COOKIE}=${guestCookieValue(CLAIMED_GUEST)}` });
    expect(response.status).toBe(401);
  });

  it('refuses a suspended account, as every other policy does', async () => {
    // The ban is applied while the scope is resolved, so it holds for every policy at once
    // rather than for the ones somebody remembered.
    const response = await get({ [TEST_USER_HEADER]: SUSPENDED });
    expect(response.status).toBe(401);
  });

  it('is a policy the audit and the guard both understand', () => {
    expect(isRouteAccess(principalAccess())).toBe(true);
    expect(describeAccess(principalAccess())).toContain('guest');
  });

  it('says nothing about which rows the principal may see', async () => {
    /*
     * Stated as an assertion so it cannot rot into an assumption. Two different principals
     * are both admitted by this policy and both get a 200; the policy has drawn no
     * distinction between them, and anything that treats "passed the guard" as "owns the
     * row" is plan 7.4 trap 2 with a decorator in front of it.
     */
    const user = await get({ [TEST_USER_HEADER]: CUSTOMER });
    const guest = await get({ cookie: `${GUEST_COOKIE}=${guestCookieValue(GUEST)}` });

    expect([user.status, guest.status]).toStrictEqual([200, 200]);
    expect(await scopeOf(user)).not.toBe(await scopeOf(guest));
  });
});
