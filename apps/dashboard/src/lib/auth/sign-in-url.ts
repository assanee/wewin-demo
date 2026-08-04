import type { Route } from 'next';

import { apiUrl } from '@/lib/api/config';

/**
 * The two URLs that make up "sign in", and the one deployment fact they depend on.
 *
 * ── The deployment fact, stated where it will be read ────────────────────────
 *
 * apps/api builds every post-sign-in redirect as `OAUTH_WEB_BASE_URL + returnTo`
 * (src/auth/oauth/oauth.service.ts). `returnTo` is a *path*, checked by `isLocalReturnTo`
 * and by a CHECK constraint in packages/db, because a login callback that can be pointed at
 * another origin is a phishing page wearing this company's name. That check is correct and
 * must not be loosened.
 *
 * The consequence for this app: **the OAuth callback lands on whatever origin
 * `OAUTH_WEB_BASE_URL` names, and there is exactly one of them.** Point it at the dashboard
 * and the storefront's sign-in returns to the dashboard; point it at the storefront and
 * this app's sign-in ends on the storefront's home page with a session it cannot use,
 * because the access token only exists after a `/auth/refresh` this app never gets to make.
 *
 * There is no way to fix that from inside apps/dashboard — it is one API-side variable
 * serving two clients — so this file does not pretend to. Locally, set
 * `OAUTH_WEB_BASE_URL=http://localhost:3001` while working on the dashboard. Properly, the
 * API needs a per-client allowlist of return origins (an `OAUTH_RETURN_ORIGINS` the start
 * request selects from, validated the same way `returnTo` is), which is a change to
 * apps/api and belongs to whoever owns it.
 *
 * ── Why the sign-in link is an `<a href>` and not a `fetch` ──────────────────
 *
 * `/auth/oauth/:provider/start` answers 302 and sets the browser-binding cookie that plan
 * 6(b) exists for. A `fetch` would follow the redirect in the background, land on the
 * provider's HTML login page, and store the binding cookie against an XHR the user never
 * sees. The browser has to *navigate*.
 */

const MAX_RETURN_TO_LENGTH = 512;
const SPACE = 0x20;
const DEL = 0x7f;

/**
 * The same three shapes apps/api's `isLocalReturnTo` rejects, checked again here.
 *
 * Not redundant with the server's copy, for the reason that file gives about its own
 * duplication of the database CHECK: the server's is the guarantee, this one is the
 * *answer*. A `next` parameter somebody typed into the address bar should turn into a
 * sign-in link that works, not a 400 from an endpoint the user never chose to call.
 *
 * A loop rather than a regular expression for the control characters, because a character
 * class containing them trips `no-control-regex` however it is spelled — the same call
 * return-to.ts makes.
 */
function isLocalPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= SPACE || code === DEL) return false;
  }
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  return true;
}

export const DEFAULT_RETURN_TO = '/';

/**
 * Anything that is not a path on this site collapses to the home page.
 *
 * The return type is `Route` and the assertion below is the only one in this app, so it is
 * worth being exact about what it does and does not claim. `typedRoutes` gives `Route` the
 * union of routes that exist at build time; this value arrived in a query string, so no
 * amount of checking can place it in that union — `?next=/nope` is a well-formed local path
 * that 404s, which is the right outcome and not something the compiler can know.
 *
 * What the check *does* guarantee is the property that matters: this string can only ever
 * be a path on this origin. That is the same boundary `isPermissionCode` sits on in
 * apps/api — a value from outside, narrowed once, in the one function whose job is to
 * narrow it — rather than a cast sprinkled at each call site to make a type complaint stop.
 */
export function safeReturnTo(raw: string | null | undefined): Route {
  if (raw === null || raw === undefined || !isLocalPath(raw)) return DEFAULT_RETURN_TO;
  return raw as Route;
}

/** `/login?next=…`, for a gate that wants the person back where they were. */
export function signInPath(returnTo: string): Route {
  const safe = safeReturnTo(returnTo);
  if (safe === DEFAULT_RETURN_TO) return '/login';
  return `/login?next=${encodeURIComponent(safe)}`;
}

/** The URL a provider button navigates to. Absolute — it is on the API's origin. */
export function oauthStartUrl(provider: string, returnTo: Route): string {
  const url = new URL(apiUrl(`/auth/oauth/${encodeURIComponent(provider)}/start`));
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}
