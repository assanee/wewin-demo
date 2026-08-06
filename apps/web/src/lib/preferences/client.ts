import { decodePreferences, type Preferences, type PreferencesRequest } from './wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE ONLY MODULE IN apps/web THAT CALLS `fetch`, AND IT MUST STAY THAT WAY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before this file, `grep -rn "fetch(" apps/web/src` returned nothing — `ProductCard` says so
 * in as many words, and the reason is plan 8.2. This app prerenders 683 documents, serves them
 * with `revalidate = false`, and gets its catalogue from `@wewin/core/fixtures` compiled in by
 * `tsc`. A fetch on a *server* render path would be a per-request call in front of pages whose
 * entire point is that they are static, and a fetch whose *response depends on who is asking*
 * would be plan 8.2's third trap in its purest form: one reader's preference baked into a
 * shared cache entry and served to everybody behind them.
 *
 * So:
 *
 *   - every function here runs in the browser, after hydration, in an event handler or an
 *     effect. Nothing on a render path calls it, on either side of the boundary.
 *   - `tests/preferences-cache.test.ts` walks the whole of `src/` and fails if any module that
 *     is not `'use client'` imports this file, and separately if a server component anywhere
 *     gains a `fetch(` or a request-time API.
 *   - the page that mounts the island is a plain server component that renders words and no
 *     preference at all. What it prerenders is identical for every visitor of its locale.
 *
 * ⚠️ **There is deliberately no `import 'client-only'` here**, and that is a stated trade
 * rather than an omission. The dashboard declares that package and uses it; this app does not
 * depend on it, and adding a dependency means a `package.json` and a lockfile change in a
 * workspace two other rounds are writing to right now. The scan above is the stronger of the
 * two guards anyway — it names the offending file and line at test time, where
 * `client-only`'s failure is a build error with a module-resolution stack — and it is
 * mutation-tested against a planted violation, which a package import cannot be. If the
 * dependency lands for another reason, add the import; do not remove the scan.
 *
 * ── What "reaching the reader" means here, since nothing is fetched on the server ──
 *
 * A signed-in preference reaches the reader through the *same two mechanisms an anonymous
 * visitor already uses*, and that is the whole answer to "how does a preference reach the
 * reader without undoing the cache":
 *
 *   **language** → the `wewin.locale` cookie plus a navigation. The locale is the first path
 *   segment, so it is in every cache key structurally; the preference does not change what
 *   `/th/products` renders, it changes which URL you are on. `src/proxy.ts` reads that cookie
 *   on unprefixed requests only, under `Cache-Control: no-store` with the `Vary` that says why.
 *
 *   **display unit** → `DisplayUnitProvider`'s `localStorage` key. The server already rendered
 *   all five units into the cached HTML (`components/catalog/unitVariants.ts`); the island only
 *   ever chooses between strings that are already there.
 *
 * The account is therefore not a *channel* for the preference — it is **durable storage for
 * it**. Signing in is what makes the choice survive a new device; it changes nothing about how
 * the choice is applied, which is why nothing about the cached pages had to move.
 *
 * ── No token store, no session provider, no retry ────────────────────────────────
 *
 * The dashboard has all three (`lib/api/client.ts`, `lib/auth/session.tsx`) because every one
 * of its screens is behind a session. This app has exactly one screen that cares, the visitor
 * may perfectly well have no account at all, and a session provider mounted in `AppShell`
 * would put a `POST /auth/refresh` in front of every first paint on a storefront whose whole
 * pitch is that you can price a window without signing in.
 *
 * So: one refresh, on demand, from the settings screen. A browser with no refresh cookie gets
 * `null` — which is not an error, it is the ordinary state of a visitor — and the screen keeps
 * working on local storage alone.
 */

const DEVELOPMENT_FALLBACK = 'http://localhost:3000';

/**
 * Where apps/api is.
 *
 * `NEXT_PUBLIC_` because the browser is what calls it, so the value is inlined at build time
 * and there is no later moment at which it could be read — which makes "the deployment forgot
 * to set it" a build failure rather than a bundle that calls localhost from production. Same
 * arrangement, same reasoning, as `apps/dashboard/src/lib/api/config.ts`.
 */
function resolveApiBaseUrl(): string {
  const configured = process.env['NEXT_PUBLIC_API_BASE_URL'];

  if (configured !== undefined && configured !== '') {
    // Trailing slash stripped once: every URL here is `base + '/something'`, and `//something`
    // is read by a browser as a protocol-relative URL to the host `something`.
    return configured.replace(/\/+$/, '');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL is required for a production build of @wewin/web. ' +
        'It is inlined into the browser bundle, so there is no later moment at which it can be read.',
    );
  }

  return DEVELOPMENT_FALLBACK;
}

const apiUrl = (path: string): string => `${resolveApiBaseUrl()}${path}`;

/** `null` is "this browser has no session", which is the ordinary state here and not an error. */
export type AccessToken = string | null;

/**
 * Spend the refresh cookie for an access token, or find out there is no session.
 *
 * The refresh cookie is `__Host-` prefixed, so it carries no `Domain` and belongs to the API's
 * origin alone — this app can neither read it nor forge one, and a middleware here that
 * "checked the session" would be checking a cookie the browser will never send it. The only
 * way to find out is to ask, which is what this does.
 *
 * `credentials: 'include'` is what lets the cookie travel at all, and it requires this app's
 * origin to be in the API's `CORS_ORIGINS`. Every failure — no cookie, an expired session, a
 * refused preflight, no network — is one `null`, because there is exactly one thing this screen
 * can do about any of them and it is the same thing: carry on as a visitor.
 */
export async function refreshAccessToken(): Promise<AccessToken> {
  try {
    const response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      /* A credential exchange must never be served from the browser's cache. */
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const token = (body as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * A response the caller can act on, or a reason it could not.
 *
 * `'signed-out'` is separated from `'failed'` on purpose. The first is a state — most visitors
 * to this storefront are in it, and the screen says "sign in to keep these on your other
 * devices". The second is a fault, and the screen has to say that the *save* did not happen,
 * because the local half of the change already did and a silent partial success is how somebody
 * ends up believing a setting is stored when it is not.
 */
export type PreferencesResult =
  | { readonly kind: 'ok'; readonly preferences: Preferences }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'failed' };

async function request(
  token: AccessToken,
  method: 'GET' | 'PUT' | 'DELETE',
  payload?: PreferencesRequest,
): Promise<PreferencesResult> {
  if (token === null) return { kind: 'signed-out' };

  let response: Response;
  try {
    response = await fetch(apiUrl('/me/preferences'), {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    return { kind: 'failed' };
  }

  // A 401 here means the token this call was made with has expired between the refresh and
  // now, or the account stopped being usable. Reported as signed out rather than retried: the
  // dashboard retries once because it has a session to keep alive, and this screen has one
  // request to make.
  if (response.status === 401 || response.status === 403) return { kind: 'signed-out' };
  if (!response.ok) return { kind: 'failed' };

  try {
    return { kind: 'ok', preferences: decodePreferences(await response.json()) };
  } catch {
    // The body did not match what this build knows. `failed` and not `ok` with a guess — see
    // the header of `wire.ts` on why nothing here is cast.
    return { kind: 'failed' };
  }
}

export const fetchPreferences = async (token: AccessToken): Promise<PreferencesResult> =>
  request(token, 'GET');

export const savePreferences = async (
  token: AccessToken,
  payload: PreferencesRequest,
): Promise<PreferencesResult> => request(token, 'PUT', payload);

export const forgetPreferences = async (token: AccessToken): Promise<PreferencesResult> =>
  request(token, 'DELETE');
