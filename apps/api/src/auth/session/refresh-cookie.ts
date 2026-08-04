/**
 * How a refresh token travels, and nothing about where.
 *
 * The endpoint path, the mount prefix and the response shape belong to whichever
 * controller signs users in. What belongs *here* is the set of attributes without which
 * the refresh token stops being a secret — so they are a constant, not an options object,
 * and there is no parameter that can turn one of them off.
 *
 * `__Host-` is the whole design. The prefix is refused by the browser unless the cookie is
 * `Secure`, has `Path=/`, and carries no `Domain`, and that last one is the point: without
 * it, anything that can set a cookie on a sibling subdomain — a forgotten staging host, a
 * CMS on the same registrable domain — can plant a refresh cookie for the parent domain
 * and sign the victim into an account it controls. That is session fixation, and no
 * amount of care on this side prevents it. The price is `Path=/`: the cookie is sent on
 * every request to the API rather than only to the refresh endpoint. It is `HttpOnly`, so
 * "sent more often" means "sent to us more often", which is a smaller cost than a subdomain
 * that can overwrite it.
 *
 * `SameSite=Lax` and not `None`: refreshing is a same-site XHR from the dashboard or the
 * web app, so `Lax` costs nothing and removes cross-site POSTs to the refresh endpoint. The
 * cookie that genuinely needs `SameSite=None` is the OAuth binding cookie, because Apple
 * posts its callback cross-site — a different cookie, in a different module, for a reason
 * that does not apply to this one.
 */

/** The `__Host-` prefix is load-bearing; renaming this without it removes a guarantee. */
export const REFRESH_COOKIE_NAME = '__Host-wewin_rt';

const FIXED_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

/**
 * `Max-Age` and not `Expires`: it is relative, so a client whose clock is wrong keeps the
 * cookie for the right duration. It is derived from the token's own expiry rather than
 * passed in, so a cookie cannot be made to outlive the credential inside it — a browser
 * holding a token the database has already expired produces a 401 nobody can explain.
 */
export function refreshCookie(token: string, expiresAt: Date, now: Date = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${REFRESH_COOKIE_NAME}=${token}; ${FIXED_ATTRIBUTES}; Max-Age=${String(maxAge)}`;
}

/**
 * Deleting it. Same attributes, because a browser matches the cookie to overwrite on name,
 * path and domain — a clearing header that drops `Path=/` clears a different cookie, or
 * none, and leaves the real one in place.
 */
export function clearedRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; ${FIXED_ATTRIBUTES}; Max-Age=0`;
}
