import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { readCookie } from '../common/cookies';

/**
 * The cookie an anonymous visitor carries their cart in — its name, its attributes, and the
 * one place either is decided.
 *
 * Plan section 6's fourth scope variant, `{ kind: 'guest', guestId }`, needs a referent that
 * survives a page load, and this is it. The value is `guests.id` **and a 256-bit secret**,
 * joined by a dot.
 *
 * ── The secret was added, and the argument against it was wrong ──────────────────
 *
 * This file used to carry the id alone, with a reason: a cart you can build without signing
 * in is by definition owned by whoever holds the browser, and signing the value would not
 * change that, because an attacker who wants a valid signed cookie visits the site and is
 * given one. That is still true *about the cart*, and it is beside the point about
 * everything the id came to be worth.
 *
 * Signing in claims the guest. Claiming now attributes that guest's orders to the account
 * (`IdentityLinkService.claimGuest`). So the id alone was enough to: put somebody else's
 * guest id in your own cookie jar, sign in, and have their submitted order — with their
 * name, telephone number and totals on it — attributed to you, while their cookie stopped
 * working for ever, with no unclaim path and nothing recording that it had happened. Guest
 * ids are not secret in practice; two log lines print them.
 *
 * A secret costs one column and closes all of that: the capability now has to be *held*, not
 * *known*. It is not a signature — there is no key and nothing to verify — it is 32 random
 * bytes compared against `guests.secret_hash`, which is the smallest thing that makes
 * "knowing the id" and "holding the cart" different facts.
 *
 * The other two rules below stay exactly as they were, and they are the fix for a real attack.
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
 * `POST /orders` mints it (`OrdersController.create`), and the name, the attributes and the
 * shape check all live here rather than there: a writer that invents its own name silently
 * disables `__Host-`, and a writer that invents its own value format silently disables the
 * secret.
 */

const GUEST_COOKIE_BASE_NAME = 'wewin_guest';

/** Any uuid version — `guests.id` is v4 today, and a switch to v7 must not be a sign-in bug. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** base64url of 32 random bytes: 43 characters, no padding. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Bytes of entropy in the secret half. 32 is the same size as the session signing key. */
const SECRET_BYTES = 32;

/**
 * The two halves of the cookie, once it has been read and checked for shape.
 *
 * Both travel together everywhere, and that is the point: there is no function in this
 * codebase that takes a guest id out of a cookie without the secret that proves it, so no
 * caller can accidentally act on the id alone. The type is what enforces it.
 */
export interface GuestCookie {
  readonly guestId: string;
  /** Presented, never stored. `guests.secret_hash` holds SHA-256 of it. */
  readonly secret: string;
}

export function guestCookieName(cookieSecure: boolean): string {
  return cookieSecure ? `__Host-${GUEST_COOKIE_BASE_NAME}` : GUEST_COOKIE_BASE_NAME;
}

/** A fresh capability. The only producer; `OrderRepository.createGuest` is the only caller. */
export function mintGuestSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * SHA-256, hex — what the database stores.
 *
 * A plain digest and not a password KDF, deliberately: this is a 256-bit random value, not
 * something a person chose, so there is nothing to guess and nothing for a work factor to
 * slow down. What the hash buys is that a database dump is not a drawer full of live
 * capabilities. `guests_secret_hash_shape` pins the format at the table.
 */
export function guestSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The digest of an attacker-supplied secret is compared against a stored one, and `===` on
 * strings returns at the first differing byte. That is a real oracle in principle; it costs
 * one function call to remove, and the alternative is an argument about how many round trips
 * an attacker would need, which is not an argument worth having.
 */
export function guestSecretMatches(presentedHash: string, storedHash: string): boolean {
  const a = Buffer.from(presentedHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GuestCookieOptions {
  readonly cookieSecure: boolean;
  readonly maxAgeSeconds: number;
}

export function serialiseGuestCookie(cookie: GuestCookie, options: GuestCookieOptions): string {
  return [
    /*
     * `id.secret`. A dot because neither half can contain one — a uuid is hex and dashes,
     * base64url is letters, digits, `-` and `_` — so the split is unambiguous without
     * encoding, and a cookie carrying only the id (which is every cookie issued before this
     * change) fails the shape check rather than being read as a secretless capability.
     */
    `${guestCookieName(options.cookieSecure)}=${cookie.guestId}.${cookie.secret}`,
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
export function readGuestCookie(
  header: string | undefined,
  cookieSecure: boolean,
): GuestCookie | undefined {
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

  const dot = value.indexOf('.');
  if (dot < 0) return undefined;

  const guestId = value.slice(0, dot);
  const secret = value.slice(dot + 1);

  // Both halves checked before either is believed, so a hand-written cookie becomes `public`
  // rather than a string that reaches a query or a digest.
  if (!UUID.test(guestId) || !SECRET.test(secret)) return undefined;

  return { guestId: guestId.toLowerCase(), secret };
}
