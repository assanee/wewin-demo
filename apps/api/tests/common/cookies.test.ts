import { describe, expect, it } from 'vitest';

import { readCookie } from '../../src/common/cookies';
import { guestCookieName, readGuestCookie } from '../../src/rbac/guest-cookie';
import { readCookie as readCookieViaOAuth } from '../../src/auth/oauth/state-cookie';

/**
 * One parser, one answer.
 *
 * There were two parsers with two rules. `rbac/identity.ts` returned the *first* occurrence
 * of a name and gave up at the first malformed one; `auth/oauth/state-cookie.ts` kept going
 * and returned the *last*, with a comment saying so on purpose. Both were handed the same
 * `Cookie:` header on the same request, and both read `wewin_guest` — the guard to decide
 * which cart a request may touch, `OAuthController.start` to decide which cart the sign-in
 * permanently claims.
 *
 * A browser sends two cookies of one name as soon as a second is set at a different `Path`
 * or `Domain`. So an attacker with a foothold on any sibling subdomain could plant a second
 * one and make the two readers disagree: the visitor shops into cart A while their sign-in
 * transfers cart B into their account. The second test below is the quieter half — one
 * malformed `wewin_guest` first in the header blinded the guard completely while the OAuth
 * path found a perfectly good id further along.
 */
describe('the Cookie header parser', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '11111111-1111-4111-8111-11111111111b';
  const NAME = guestCookieName(false);

  it('is literally the same function on both sides', () => {
    // Not a behavioural assertion: the point is that there is nothing to keep in step.
    expect(readCookieViaOAuth).toBe(readCookie);
  });

  it('treats a duplicated name as absent rather than picking a winner', () => {
    const header = `${NAME}=${A}; ${NAME}=${B}`;

    expect(readCookie(header, NAME)).toBeUndefined();
    expect(readGuestCookie(header, false)).toBeUndefined();
  });

  it('treats a duplicated name as absent however the two are ordered', () => {
    expect(readCookie(`${NAME}=not-a-uuid; ${NAME}=${B}`, NAME)).toBeUndefined();
    expect(readGuestCookie(`${NAME}=not-a-uuid; ${NAME}=${B}`, false)).toBeUndefined();
    expect(readGuestCookie(`${NAME}=${B}; ${NAME}=not-a-uuid`, false)).toBeUndefined();
  });

  it('reads a single occurrence out of a jar with other cookies in it', () => {
    const header = `locale=th; ${NAME}=${A}; theme=dark`;
    expect(readCookie(header, NAME)).toBe(A);
    expect(readGuestCookie(header, false)).toBe(A);
  });

  it('answers undefined for a header that has none of the name', () => {
    expect(readCookie('locale=th; theme=dark', NAME)).toBeUndefined();
    expect(readCookie(undefined, NAME)).toBeUndefined();
  });

  /**
   * `__Host-` is only a guarantee if nothing accepts the unprefixed spelling.
   *
   * A sibling subdomain cannot write `__Host-wewin_guest` — the browser refuses it — but it
   * can write `wewin_guest`. A reader that took either name would have bought nothing.
   */
  it('reads only the name that matches this deployment’s cookie profile', () => {
    const bare = `wewin_guest=${A}`;
    const hosted = `__Host-wewin_guest=${A}`;

    expect(guestCookieName(true)).toBe('__Host-wewin_guest');
    expect(readGuestCookie(bare, true)).toBeUndefined();
    expect(readGuestCookie(hosted, true)).toBe(A);
    expect(readGuestCookie(hosted, false)).toBeUndefined();
  });

  it('refuses a guest id that is not a uuid, whatever else the header says', () => {
    expect(readGuestCookie(`${NAME}=' or 1=1--`, false)).toBeUndefined();
    expect(readGuestCookie(`${NAME}=%ZZ`, false)).toBeUndefined();
  });
});
