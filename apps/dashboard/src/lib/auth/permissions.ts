/**
 * The permission codes this UI knows how to *mention*.
 *
 * Not a second source of truth, and the distinction matters. The source of truth is
 * apps/api/src/rbac/permissions.ts, projected into the `permissions` table at boot and
 * enforced by `RbacGuard` on every request. This list exists so that a navigation entry can
 * say which permission it corresponds to in something the compiler checks, instead of a
 * string literal that a typo turns into an item nobody can ever see.
 *
 * It is a copy, so it can drift, so the direction it drifts in is the thing worth designing:
 *
 *   a code renamed in the API and not here  → the item disappears from the menu. The user
 *                                             can still reach the page by URL and the API
 *                                             still answers. A menu that hides too much.
 *   a code added in the API and not here    → no menu entry exists to hide. Nothing.
 *   a code here that the API dropped        → the item never matches and never appears.
 *
 * Every one of those fails towards *less* menu. None of them can produce an item that is
 * visible to somebody the API would refuse, because visibility is computed from the
 * permission list the API itself just sent (`GET /me`) and never from this file. That is the
 * whole reason this is safe to duplicate — and the reason a mismatch is a cosmetic bug
 * rather than an authorisation one.
 *
 * Plan section 6, restated because it is the thing most easily forgotten while writing a
 * sidebar: **hiding a menu item is not authorisation.** Everything below is presentation.
 */
export const PERMISSION_CODES = [
  'catalog.read',
  'catalog.write',
  'catalog.publish',
  'orders.read',
  'orders.write',
  'orders.refund',
  'quotes.read',
  'quotes.write',
  'quotes.approve',
  'payments.read',
  'payments.verify',
  'users.read',
  'users.write',
  'groups.read',
  'groups.write',
  'reviews.moderate',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

/**
 * All of them, not any of them.
 *
 * Deliberately the same rule `@RequirePermissions` uses on the server, which documents
 * itself as "all rather than any, because 'any of these' is how a route ends up reachable by
 * the weakest permission in a list somebody extended later". A menu that used *any* would
 * show items the matching route then refuses, which is the one kind of menu bug that wastes
 * a person's time rather than merely hiding something from them.
 *
 * An empty `required` means "no permission needed" and is true for everybody, including a
 * signed-in user with no groups at all.
 */
export function holdsAll(
  held: ReadonlySet<string>,
  required: readonly PermissionCode[],
): boolean {
  return required.every((code) => held.has(code));
}
