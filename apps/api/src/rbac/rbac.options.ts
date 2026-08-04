/**
 * The runtime settings this module has, which is one.
 *
 * `cookieSecure` decides which guest-cookie name is read (`__Host-wewin_guest` or the bare
 * one) and therefore whether `__Host-`'s guarantee is in force. It is a separate token from
 * `ENV` because the guard is constructed by Nest and injecting the whole environment into a
 * guard is how a guard grows a dependency on `DATABASE_URL`.
 *
 * There is deliberately no default here. `RbacModule.forRoot` supplies one — the *safe*
 * one — but the value the process runs on comes from `COOKIE_SECURE`, parsed in
 * src/config/env.ts, so all three cookies in this application read one flag.
 */
export const RBAC_OPTIONS = Symbol('wewin.rbac.options');

export interface RbacOptions {
  readonly cookieSecure: boolean;
}
