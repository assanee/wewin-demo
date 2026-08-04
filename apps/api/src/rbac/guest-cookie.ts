import { readCookie } from '../common/cookies';

/**
 * The cookie an anonymous visitor carries their cart in — its name, its attributes, and the
 * one place either is decided.
 *
 * Plan section 6's fourth scope variant, `{ kind: 'guest', guestId }`, needs a referent that
 * survives a page load, and this is it. The value is `guests.id`: a bearer capability, plain
 * and unsigned, because a cart you can build without signing in is by definition owned by
 * whoever is holding the browser. Signing it would not change that — an attacker who wants a
 * valid signed cookie visits the site and is given one.
 *
 * What *does* change it is the pair of rules below, and they are the fix for a real attack.
 *
 *   **`__Host-`.** Without the prefix, anything that can set a cookie on a sibling subdomain
 *   — a forgotten staging host, a CMS on the same registrable domain — can plant a guest id
 *   in a victim's browser. The prefix makes the browser refuse any such write: it requires
 *   `Secure`, `Path=/`, and *no* `Domain`, so only an exact-host https response can set it.
 *   The same reasoning, and the same prefix, as the refresh cookie in ../auth/session.
 *
 *   **Claiming revokes the capability.** A planted cookie's remaining payoff was that the
 *   victim's sign-in permanently transferred the attacker's cart into the victim's account
 *   while the attacker still held the id. So a `guests` row with `claimed_by_user_id` set is
 *   no longer an anonymous capability at all — `GuestRepository.isOpenGuest` refuses it and
 *   the request falls back to `public`. The transfer still costs the victim the cart they
 *   built in that browser, which is a nuisance; it no longer costs them anything an attacker
 *   can read.
 *
 * Development gets the bare name without `Secure`, for the same reason the OAuth binding
 * cookie does: there is no https on a laptop, and a `__Host-` cookie without `Secure` is
 * refused by every current browser. `cookieSecure` is one flag across the whole process
 * (`COOKIE_SECURE` in src/config/env.ts) so the three cookies cannot drift into two profiles.
 *
 * Nothing mints this cookie yet — the cart module does not exist. `serialiseGuestCookie` is
 * here rather than waiting for it because the *reader* has to agree with the writer about
 * the name, and a writer that invents its own name silently disables `__Host-`.
 */

const GUEST_COOKIE_BASE_NAME = 'wewin_guest';

/** Any uuid version — `guests.id` is v4 today, and a switch to v7 must not be a sign-in bug. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function guestCookieName(cookieSecure: boolean): string {
  return cookieSecure ? `__Host-${GUEST_COOKIE_BASE_NAME}` : GUEST_COOKIE_BASE_NAME;
}

export interface GuestCookieOptions {
  readonly cookieSecure: boolean;
  readonly maxAgeSeconds: number;
}

export function serialiseGuestCookie(guestId: string, options: GuestCookieOptions): string {
  return [
    `${guestCookieName(options.cookieSecure)}=${guestId}`,
    'Path=/',
    `Max-Age=${String(options.maxAgeSeconds)}`,
    /*
     * `HttpOnly`, even though the cart is not a secret: the id is the capability, and a
     * script that can read it can hand it to somebody else. The cart's *contents* reach the
     * page through the API, which is where the scope check is.
     */
    'HttpOnly',
    // `Lax` and not `None`: a cart is only ever read by same-site navigation and XHR. The
    // cookie that needs `None` is the OAuth binding cookie, because Apple posts back
    // cross-site — a different cookie for a reason that does not apply here.
    ...(options.cookieSecure ? ['Secure', 'SameSite=Lax'] : ['SameSite=Lax']),
  ].join('; ');
}

/**
 * The guest id a request carries, or nothing.
 *
 * Only the name that matches this deployment's profile is read. Accepting the unprefixed
 * name when `cookieSecure` is on would hand back exactly the write `__Host-` exists to
 * refuse — a sibling subdomain cannot set `__Host-wewin_guest`, but it can set
 * `wewin_guest`, and a reader that takes either has bought nothing.
 *
 * Shape is checked before the value is believed, so a hand-written cookie becomes `public`
 * rather than a string that reaches a query. Existence and ownership are checked separately
 * and against the database — see `GuestRepository`.
 */
export function readGuestCookie(header: string | undefined, cookieSecure: boolean): string | undefined {
  const raw = readCookie(header, guestCookieName(cookieSecure));
  if (raw === undefined) return undefined;

  // Cookie values are percent-encoded by most client libraries; one that fails to decode is
  // a malformed cookie, which is the same answer as a missing one.
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }

  return UUID.test(value) ? value.toLowerCase() : undefined;
}
