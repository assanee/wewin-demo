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
  /*
   * ⭐ Its own code, and for the reason `users.erase` has its own: `quotes.write` is a list of
   * verbs a salesperson performs on their own quote, and *answering an approval request* is
   * none of them. Behind `quotes.write`, the decision route was held by everybody who could
   * ask, so what separated an approver from a requester was the two-person CHECK plus the
   * decider's ceiling — and on a database with no `authority_limits` rows the CHECK was the
   * only thing left, which two colleagues defeat by taking turns.
   *
   * ⚠️ Granted to no group at boot, exactly as `users.erase` is. `permission-sync.service.ts`
   * inserts the code so a grant has something to reference; who holds it is plan 13's
   * unanswered *"บริษัทมีคนตรวจสลิป/อนุมัติกี่คนจริงๆ"*, and inventing a grant would be
   * inventing the answer. Until the owner grants it, approvals are refused for want of a
   * permission as well as for want of a ceiling — which is the fail-closed direction, and is
   * what "no authority row means no discount" already means one layer down.
   */
  'quotes.approve': 'Approve or reject a concession somebody else asked for.',

  'payments.read': 'Read payments and payment slips.',
  'payments.verify': 'Accept or reject a payment slip.',

  /*
   * The company's own profile and the bank accounts it is paid into — settings, not a
   * customer-facing resource. Placed next to `payments.*` rather than at the end of the
   * list: `payment_slips.received_bank_account_id` points at a row this permission
   * governs, so a payments admin reads this permission where they would look for it.
   */
  'organisation.read': 'ดูข้อมูลบริษัทและบัญชีรับเงิน',
  'organisation.write': 'แก้ไขข้อมูลบริษัทและบัญชีรับเงิน',

  'users.read': 'Read user accounts, their addresses and their sign-in methods.',
  'users.write': 'Suspend, reinstate, close and edit user accounts.',
  /*
   * Its own code, and not part of `users.write`.
   *
   * `users.write`'s honest description is a list of reversible verbs. Erasure is none of
   * them: it destroys every credential the person has, it cannot be undone, and the
   * database refuses to let a row leave `erased`. Bundling it into the write permission
   * repeats plan 7.14(ข)3 exactly — a permission that quietly carried an authority nobody
   * had agreed to, discovered afterwards by reading what its holder could actually reach.
   *
   * Held by nobody at boot: `permission-sync.service.ts` inserts the code so a grant has
   * something to reference, and grants it to no group. There is no user-administration
   * controller yet (grep every `*.controller.ts` for `users.` — nothing consumes either
   * code), so this is the moment the reach mistake is either made or avoided, and it is
   * cheaper to declare the separation before the surface exists than to split it after.
   */
  'users.erase': 'Irreversibly erase a user: delete every credential and scrub their identity.',

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
