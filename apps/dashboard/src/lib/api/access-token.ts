import 'client-only';

/**
 * The access token, in memory, in the tab that owns it — and nowhere else.
 *
 * Not `localStorage`, not `sessionStorage`, not a readable cookie. apps/api went to some
 * trouble to make sure the credential a page can read is the *short-lived* one: the OAuth
 * callback deliberately drops the access token and sets only the `httpOnly`, `__Host-`
 * refresh cookie (session-issuer.adapter.ts spells this out), so the long-lived half never
 * exists anywhere script can reach it. Putting the access token in storage would hand the
 * ten-minute half back to any script on the page and survive the reload that would
 * otherwise have ended it. A reload costs one round trip to `/auth/refresh`; that is the
 * price, and it is small.
 *
 * `import 'client-only'` is what keeps this a fact rather than a convention. This module
 * holds process-wide mutable state, and a Next server process is shared by every visitor —
 * one import from a Server Component and one operator's token would be handed to the next
 * person who loaded a page. The package's `react-server` export condition makes that import
 * a build error instead of an incident.
 */

export interface AccessToken {
  readonly value: string;
  /** From the API's `accessTokenExpiresAt`. Used to refresh *before* a 401, not after. */
  readonly expiresAt: Date;
}

let current: AccessToken | null = null;

const listeners = new Set<() => void>();

export function getAccessToken(): AccessToken | null {
  return current;
}

/**
 * Setting the same value still notifies, because "the token was replaced" is the event the
 * proactive-refresh timer re-arms on — and after a rotation the replacement is a different
 * string with a different expiry every time.
 */
export function setAccessToken(next: AccessToken | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeToAccessToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What `useSyncExternalStore` reads during server rendering.
 *
 * A constant `null` rather than `getAccessToken`, and not because the module variable would
 * be wrong on the server — `client-only` already means nothing on the server writes it.
 * It is because a snapshot that *could* differ between the server render and the first
 * client render is a hydration mismatch, and a token is exactly the kind of value that
 * would produce one silently.
 */
export function serverAccessTokenSnapshot(): null {
  return null;
}
