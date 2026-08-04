import 'client-only';

import { getAccessToken, setAccessToken, type AccessToken } from './access-token';
import { apiUrl } from './config';
import { ApiError, apiErrorFromResponse, networkError } from './errors';

/**
 * Every call this dashboard makes to apps/api goes through here.
 *
 * Three things it does, and one thing it deliberately does not.
 *
 * **`credentials: 'include'`, always.** The refresh cookie belongs to the API's origin —
 * `__Host-` prefixed, so no `Domain`, so it cannot be shared with this one — and it is
 * `SameSite=Lax`. `Lax` is not an obstacle: the dashboard and the API are the same *site*
 * (ports are not part of a site, so `localhost:3001` → `localhost:3000` qualifies, and so
 * does `dashboard.example` → `api.example`), which is precisely the arrangement
 * apps/api/src/auth/session/refresh-cookie.ts says it chose `Lax` for. What this does
 * require is that the dashboard's origin appears in the API's `CORS_ORIGINS`, because
 * `credentials: true` there is what allows a cross-origin call to carry a cookie at all.
 *
 * **The bearer token is attached, never stored.** See access-token.ts.
 *
 * **One retry on 401, and only one.** A 401 means the access token expired; a second 401
 * after a successful refresh means something else, and retrying that is a loop against a
 * server that is already saying no.
 *
 * ── What it does not do: serialise refreshes ──────────────────────────────────
 *
 * There is no mutex here, no in-flight promise shared between callers, no "if a refresh is
 * already running, await it". That omission is the load-bearing part of this file.
 *
 * apps/api fixed plan 6(c) by making rotation a single atomic statement with a ~15 second
 * grace window, so that a dashboard with six panels whose tokens all expire in the same
 * millisecond gets six successors instead of one accusation of token theft. Six children of
 * one parent in `refresh_tokens` is the *correct* outcome, and `SessionService.refresh`
 * spends a paragraph saying so because it looks like a bug in a database dump.
 *
 * A client that quietly funnels every refresh through one promise never sends the second
 * request. The race stops happening, the grace window stops being exercised, and the day it
 * regresses — a migration that drops the grace clause, an `AUTH_REFRESH_GRACE_SECONDS=0` in
 * an environment file — nothing here notices, because this client had been papering over it
 * for months. The bug would then surface in whichever client did *not* dedupe.
 *
 * So each caller refreshes for itself. The cost is a handful of extra rows per expiry; the
 * benefit is that the property apps/api claims is the property this app actually depends on.
 * If a future maintainer wants deduplication, the thing to change is not this file — it is
 * to prove the grace window still works somewhere that fails when it does not.
 */

/** The refresh endpoint's success body. */
interface RefreshBody {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
}

function parseRefreshBody(body: unknown): AccessToken | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Partial<RefreshBody>;
  if (typeof candidate.accessToken !== 'string' || typeof candidate.accessTokenExpiresAt !== 'string') {
    return null;
  }
  const expiresAt = new Date(candidate.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return { value: candidate.accessToken, expiresAt };
}

/**
 * Spend the refresh cookie for a successor and a fresh access token.
 *
 * Returns `null` for every refusal rather than throwing, because there is exactly one thing
 * a caller can do about any of them and it is the same thing: treat this browser as signed
 * out. The API is deliberately incapable of telling us more — a replayed token and an
 * expired one are one 401 with one body, so that a thief learns nothing from the difference.
 *
 * The token store is cleared on failure. A stale token left in memory would be attached to
 * the next request, which turns one 401 into two.
 */
export async function refreshAccessToken(): Promise<AccessToken | null> {
  let response: Response;
  try {
    response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      /* A credential exchange must never be served from the browser's cache. */
      cache: 'no-store',
    });
  } catch {
    /*
     * Not a sign-out. The network failed, or CORS refused the preflight; the session on the
     * server is very likely still alive and clearing the token here would sign somebody out
     * of a working session because their wifi dropped.
     */
    return null;
  }

  if (!response.ok) {
    setAccessToken(null);
    return null;
  }

  const token = parseRefreshBody(await response.json().catch(() => undefined));
  if (token === null) {
    setAccessToken(null);
    return null;
  }

  setAccessToken(token);
  return token;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'credentials'> {
  /**
   * Send no `Authorization` header and do not retry on 401.
   *
   * For the handful of endpoints that are anonymous by design — `/auth/oauth/providers` on
   * the sign-in page, most obviously — where a 401 would mean something is wrong rather
   * than something is expired.
   */
  readonly anonymous?: boolean;
}

/**
 * A raw `Response`, so a caller can read headers (`x-wewin-contract-version`) or a 409's
 * body without this function having decided what shape it is. Errors that are not the
 * caller's business — the network, a refused CORS preflight — still throw.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { anonymous = false, ...init } = options;

  const send = async (token: AccessToken | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set('Authorization', `Bearer ${token.value}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    try {
      return await fetch(apiUrl(path), { ...init, headers, credentials: 'include' });
    } catch (cause) {
      throw networkError(cause);
    }
  };

  const first = await send(anonymous ? null : getAccessToken());
  if (anonymous || first.status !== 401) return first;

  /*
   * The refresh happens per call, not per app — see the header of this file for why that is
   * deliberate and must stay that way.
   */
  const refreshed = await refreshAccessToken();
  if (refreshed === null) return first;

  return send(refreshed);
}

/**
 * `apiFetch` plus "a non-2xx is an exception" and "the body is checked, not assumed".
 *
 * `decode` is a required parameter rather than a type argument on purpose. The shorthand
 * — `apiJson<Product>(...)` returning `body as Product` — is a cast on a value that arrived
 * over a network from a service that is versioned separately from this bundle, and it is
 * how a field that was renamed six weeks ago becomes `undefined` three components deep
 * instead of a message at the point it was read. apps/api narrows rather than casts
 * everywhere it reads something it did not construct (`isRouteAccess`, `isPermissionCode`,
 * `stringsOnly`); this is the same rule facing the other way.
 */
export async function apiJson<T>(
  path: string,
  decode: (body: unknown) => T,
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) throw await apiErrorFromResponse(response);

  const body: unknown = await response.json().catch(() => undefined);
  try {
    return decode(body);
  } catch (cause) {
    throw new ApiError({
      status: response.status,
      code: 'MALFORMED',
      message: `เซิร์ฟเวอร์ตอบกลับสำเร็จ แต่เนื้อหาไม่ตรงกับที่แดชบอร์ดรู้จัก (${path})`,
      details: cause,
    });
  }
}
