'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  getAccessToken,
  serverAccessTokenSnapshot,
  setAccessToken,
  subscribeToAccessToken,
} from '@/lib/api/access-token';
import { apiFetch, refreshAccessToken } from '@/lib/api/client';
import { fetchPrincipal, isSignedIn, type Principal } from '@/lib/auth/principal';
import { holdsAll, type PermissionCode } from '@/lib/auth/permissions';

/**
 * Who is signed in, held in one place for the whole app.
 *
 * **Why this is a client provider and not a server one.** The obvious Next.js shape — read
 * the session in `middleware.ts`, redirect before the page renders — cannot work here, and
 * it is worth writing down so nobody spends an afternoon rediscovering it. The refresh
 * cookie is `__Host-` prefixed, which means it carries no `Domain` and belongs to the API's
 * host alone; this server is a different host and the browser will never send it here. A
 * middleware that "checks the session" would be checking a cookie it cannot see. It would
 * either always redirect or always pass, and the second one is a gate that looks like a gate
 * and is not.
 *
 * That is not a gap. The gate is `RbacGuard` in apps/api, on every endpoint, with a
 * boot-time audit that refuses to start the process on a route nobody declared. Everything
 * in this file is about not showing somebody a screen that is going to 403 at them.
 *
 * **The sign-in handshake, in order.**
 *   1. `POST /auth/refresh`. The browser has the refresh cookie or it does not; this is the
 *      only way to find out, and after an OAuth callback it is also how the first access
 *      token is obtained at all — the callback deliberately drops it rather than putting a
 *      bearer credential in a URL or a readable cookie.
 *   2. `GET /me`. Anonymous on the server, so a 200 is not proof of anything: `kind` is.
 *   3. Anything other than `kind: 'user'` is signed out, including the `guest` a storefront
 *      visitor would get. A guest has a cart and no permissions, which is the correct
 *      principal for the shop and useless here.
 */

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly principal: Principal };

export interface SessionContextValue {
  readonly state: SessionState;
  /** `true` only for a signed-in principal holding every code listed. */
  readonly can: (...required: readonly PermissionCode[]) => boolean;
  readonly signOut: () => Promise<void>;
  /**
   * Re-read the session from the refresh cookie, and settle to `signed-in` or `signed-out`.
   *
   * Exposed for the password form, which leaves the browser holding a fresh cookie and no
   * way to say so. The alternative — letting the form set `signed-in` itself from the token
   * it just received — would be a *second* place that decides what being signed in means,
   * and the two would drift the first time `/me` gained a field this one did not read.
   *
   * It is the same function the provider runs on mount, so a password sign-in and a page
   * load reach the identical state by the identical path.
   */
  readonly refreshSession: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * How long before expiry the proactive refresh fires.
 *
 * apps/api's `RefreshResponse` says the client "refreshes before this, rather than waiting
 * for a 401 to tell it". Sixty seconds is comfortably longer than any request this app
 * makes and a sixth of the ten-minute access-token lifetime, so it costs one extra rotation
 * per ten minutes of an idle open tab and removes the visible stall of a request that has to
 * fail before it can succeed.
 *
 * This timer does not replace the 401 handling in `apiFetch`, and both existing is the
 * point: a laptop that was asleep wakes up with an expired token and a timer that fired
 * into nothing, and the reactive path is what recovers it.
 */
const REFRESH_LEAD_MS = 60_000;

/** setTimeout stores its delay in a signed 32-bit int; anything larger fires immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function SessionProvider({ children }: { readonly children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  /*
   * Subscribed to rather than read once, so the proactive timer below re-arms after every
   * rotation — including the ones `apiFetch` performs behind a 401 without telling anybody.
   */
  const token = useSyncExternalStore(
    subscribeToAccessToken,
    getAccessToken,
    serverAccessTokenSnapshot,
  );

  /**
   * Spend the refresh cookie, then ask `/me` who that is.
   *
   * One function for both callers — the mount effect below and `refreshSession` on the
   * context — so there is exactly one definition of how this browser decides it is signed
   * in. `isCancelled` rather than a boolean argument, so the mount effect can abandon a
   * request whose component has gone while a form-driven call never does.
   */
  const bootstrap = useCallback(async (isCancelled: () => boolean = () => false) => {
    const refreshed = await refreshAccessToken();
    if (isCancelled()) return;
    if (refreshed === null) {
      setState({ status: 'signed-out' });
      return;
    }

    try {
      const principal = await fetchPrincipal();
      if (isCancelled()) return;
      setState(isSignedIn(principal) ? { status: 'signed-in', principal } : { status: 'signed-out' });
    } catch {
      /*
       * A refresh that worked followed by a `/me` that did not is the API being unwell, not
       * this browser being signed out. Reported as signed out anyway, because the
       * alternative is a shell that renders a menu from a permission set it does not have —
       * and the sign-in page is at least a place where the person can act.
       */
      if (!isCancelled()) setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void bootstrap(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  useEffect(() => {
    /*
     * The token was cleared by something other than this component — a refresh that the API
     * refused inside `apiFetch`, most likely, which is what reuse detection looks like from
     * here. Guarded on `signed-in` so that the null token every mount starts with does not
     * turn the initial `loading` into `signed-out` before the handshake has run.
     */
    if (token !== null) return;
    setState((previous) => (previous.status === 'signed-in' ? { status: 'signed-out' } : previous));
  }, [token]);

  useEffect(() => {
    if (token === null) return undefined;

    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(0, token.expiresAt.getTime() - Date.now() - REFRESH_LEAD_MS),
    );
    const timer = setTimeout(() => {
      void refreshAccessToken();
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [token]);

  const signOut = useCallback(async () => {
    try {
      /*
       * Best effort, and the local half happens either way. `POST /auth/logout` revokes the
       * session and clears the refresh cookie server-side; if it fails, dropping the access
       * token still ends this tab's access within the ten minutes the API documents as the
       * price of signature-only verification.
       */
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      setAccessToken(null);
      setState({ status: 'signed-out' });
    }
  }, []);

  const value = useMemo<SessionContextValue>(() => {
    const held: ReadonlySet<string> =
      state.status === 'signed-in' ? new Set(state.principal.permissions) : new Set<string>();

    return {
      state,
      can: (...required: readonly PermissionCode[]) =>
        state.status === 'signed-in' && holdsAll(held, required),
      signOut,
      refreshSession: () => bootstrap(),
    };
  }, [state, signOut, bootstrap]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}
