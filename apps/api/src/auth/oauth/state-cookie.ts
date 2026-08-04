/**
 * ⓑ The browser half of the OAuth state — plan 6(b).
 *
 * The row in `oauth_states` proves the flow started on this server. It does not prove it
 * started in *this browser*, and that gap is the whole vulnerability: the attacker runs
 * the flow themselves, signs in as themselves, then gets the victim to open the resulting
 * callback URL. Every server-side check passes, because the `state` really was issued
 * here — it just belongs to somebody else's browser, and the victim ends up silently
 * inside the attacker's account with the attacker reading whatever they do next.
 *
 * So the callback needs a second secret that the attacker cannot put in the victim's
 * browser. This file is that secret's carrier, and the attributes on it are load-bearing:
 *
 *   `HttpOnly`         script on any page cannot read it, so an XSS elsewhere on the site
 *                      does not become a login-as-anyone.
 *   `Secure`           it is a bearer credential; over http it is readable in transit.
 *   `SameSite=None`    the counter-intuitive one, and the reason it is not `Lax`: Apple
 *                      returns the callback by cross-site `POST` (`response_mode=
 *                      form_post`), and a `Lax` cookie is not sent on a cross-site POST.
 *                      `Lax` would therefore work for LINE, Google and Facebook and fail
 *                      *only on Apple* — an inconsistent, provider-specific failure that
 *                      looks like an Apple integration bug and would very plausibly be
 *                      "fixed" by dropping the binding check. `None` requires `Secure`,
 *                      which is why the two move together below.
 *   `__Host-` prefix   this is the attribute that closes the last hole. Without it, an
 *                      attacker with any foothold on a sibling subdomain can set a cookie
 *                      scoped to the parent domain, plant their own binding secret in the
 *                      victim's browser, and the callback matches again. The prefix makes
 *                      the browser refuse any such cookie: `__Host-` requires `Secure`,
 *                      `Path=/` and *no* `Domain`, so only an exact-host, https response
 *                      can write it. It costs `Path=/` — a narrower path would have been
 *                      tidier, and is worth less than this.
 *
 * Development, where there is no https, gets `SameSite=Lax` without `Secure` and without
 * the prefix, because a `SameSite=None` cookie with no `Secure` is dropped by every
 * current browser — the choice is between `Lax` locally or no binding at all locally.
 * Apple is not exercised against localhost anyway; it will not register an http redirect
 * URI. `cookieSecure` is one flag rather than four so the two profiles cannot drift.
 */

/** Value shape: two base64url secrets, joined. Both alphabets are cookie-safe, so nothing needs escaping. */
export interface StateCookieValue {
  /** Hashed into `oauth_states.binding_hash` at mint. Never leaves the browser otherwise. */
  readonly binding: string;
  /** The PKCE verifier. Deliberately not stored server-side — see schema/auth.ts on `pkce_challenge`. */
  readonly verifier: string;
}

const COOKIE_BASE_NAME = 'wewin_oauth';

/** base64url, so a value that has been through a proxy that re-encoded it will not match. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * One cookie per flow in flight, named after the flow.
 *
 * A single fixed cookie name breaks two ordinary things: a customer who opens login in two
 * tabs (the second mint overwrites the first, and the first tab's callback then fails for a
 * reason indistinguishable from an attack), and a customer who hits Back and retries. The
 * suffix is the first 16 hex characters of `sha256(state)`, so the callback can find the
 * right cookie from the `state` it was given without storing a cookie name anywhere.
 *
 * The suffix is not a secret and does not need to be: `state` itself travels in the URL.
 * The secret is the cookie's *value*.
 */
export function stateCookieName(stateHash: string, cookieSecure: boolean): string {
  const name = `${COOKIE_BASE_NAME}_${stateHash.slice(0, 16)}`;
  return cookieSecure ? `__Host-${name}` : name;
}

export function encodeStateCookieValue(value: StateCookieValue): string {
  return `${value.binding}.${value.verifier}`;
}

export function decodeStateCookieValue(raw: string | undefined): StateCookieValue | undefined {
  if (raw === undefined) return undefined;

  const separator = raw.indexOf('.');
  if (separator < 0) return undefined;

  const binding = raw.slice(0, separator);
  const verifier = raw.slice(separator + 1);
  // Shape-checked before either half is hashed or compared: a cookie is attacker-supplied
  // input, and the only thing downstream of it should be a value that could have been
  // minted here.
  if (!SECRET_SHAPE.test(binding) || !SECRET_SHAPE.test(verifier)) return undefined;

  return { binding, verifier };
}

export interface StateCookieOptions {
  readonly cookieSecure: boolean;
  readonly maxAgeSeconds: number;
}

export function serialiseStateCookie(
  name: string,
  value: string,
  options: StateCookieOptions,
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${String(options.maxAgeSeconds)}`,
    'HttpOnly',
    ...(options.cookieSecure ? ['Secure', 'SameSite=None'] : ['SameSite=Lax']),
  ].join('; ');
}

/**
 * Sent on every callback, successful or not.
 *
 * The row is consumed exactly once by the database; the cookie is the other half of a
 * credential and there is no reason for it to outlive the flow. Cleared with the same
 * attributes it was set with, because a browser matches a deletion by name, path and
 * domain — a `Max-Age=0` on a different `Path` leaves the original in place.
 */
export function clearStateCookie(name: string, cookieSecure: boolean): string {
  return serialiseStateCookie(name, '', { cookieSecure, maxAgeSeconds: 0 });
}

/**
 * Re-exported so this module's callers keep reading cookies from beside the cookie they are
 * about, and so there is exactly one parser in the process.
 *
 * It used to live here and return the *last* occurrence of a name, while `rbac/identity.ts`
 * had a second copy returning the first — see src/common/cookies.ts for the attack that
 * disagreement enabled and why a duplicate name is now treated as absent. A duplicated
 * binding cookie therefore fails the callback closed, which is the correct direction: a
 * second `__Host-` cookie of the same name cannot be planted by a sibling subdomain, so if
 * one appears, something is wrong and no sign-in should complete.
 */
export { readCookie } from '../../common/cookies';
