/**
 * The permission catalogue — the code half of plan 6(d).
 *
 * This object is the source of truth. The `permissions` table is a *projection* of it
 * that exists so `group_permissions` has something to reference, and boot reconciles the
 * two in one direction only (see permission-sync.service.ts): a code missing from the
 * database is inserted and the process carries on; a code in the database that is not
 * here is logged and left alone. Refusing to boot on the second case is the thing that
 * breaks rollback — release N+1 adds `orders.refund`, N does not know it, and N must
 * still start.
 *
 * `PermissionCode` is derived from the keys, so a guard can only ask for a permission
 * that exists. `@RequirePermissions('order.read')` — singular, a typo — does not compile,
 * which is the difference between a guard that is wrong and a guard that is not written.
 *
 * The codes match the shape `permissions_code_shape` enforces in Postgres
 * (`resource.action`, lower snake segments). permissions.test.ts re-states that regex and
 * checks every code against it; the duplication is deliberate, because the constraint is
 * in a migration that has already run by the time this list is read and a code that
 * violates it would fail the boot-time insert rather than a test.
 */
export const PERMISSIONS = {
  /* Catalogue. Reading the *published* catalogue needs no permission at all — it is the
   * funnel, and its routes are declared anonymous. These are the dashboard's verbs. */
  'catalog.read': 'Read catalogue drafts, including versions that were never published.',
  'catalog.write': 'Create and edit products, option groups and option values.',
  'catalog.publish': 'Publish a product version, freezing its document.',

  'orders.read': 'Read orders belonging to anyone.',
  'orders.write': 'Create and advance orders.',
  'orders.refund': 'Return money that was already received.',

  'quotes.read': 'Read quotations belonging to anyone.',
  'quotes.write': 'Create and edit quotations, including overridden prices.',

  'payments.read': 'Read payments and payment slips.',
  'payments.verify': 'Accept or reject a payment slip.',

  'users.read': 'Read user accounts, their addresses and their sign-in methods.',
  'users.write': 'Suspend, reinstate and edit user accounts.',

  'groups.read': 'Read groups and their permission grants.',
  'groups.write': 'Create groups and change which permissions they carry.',

  'reviews.moderate': 'Hide or restore a customer review.',
} as const satisfies Record<string, string>;

/** Every permission this build knows how to ask for. */
export type PermissionCode = keyof typeof PERMISSIONS;

/**
 * Narrowing rather than casting `Object.keys`, so a string that arrived from Postgres —
 * where a rollback can leave codes this build has never heard of — is checked and not
 * assumed. `Object.hasOwn` and not `in`: `'toString' in PERMISSIONS` is true.
 */
export function isPermissionCode(value: string): value is PermissionCode {
  return Object.hasOwn(PERMISSIONS, value);
}

/** The catalogue as a list, in declaration order. */
export const PERMISSION_CODES: readonly PermissionCode[] = Object.keys(PERMISSIONS).filter(isPermissionCode);

export function permissionDescription(code: PermissionCode): string {
  return PERMISSIONS[code];
}
