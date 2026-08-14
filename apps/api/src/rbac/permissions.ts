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
   * ⭐ TWO CODES, NOT ONE. They are different powers and one person may reasonably hold one
   * without the other — `0047_slip_without_evidence.sql`.
   *
   * The owner asked for *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป แต่ต้องระบุ
   * เหตุผล"*, and separately chose that a high permission may bypass the two-person rule.
   * Bundling those into one code would repeat plan 7.14(ข)3 exactly — a permission that quietly
   * carried an authority nobody had agreed to, discovered afterwards by reading what its holder
   * could actually reach:
   *
   *   the clerk who takes the telephone call and keys the transfer in holds the first and
   *     **not** the second. Their entry still goes into the queue for somebody else to accept,
   *     and the two-person rule is untouched.
   *
   *   the person the owner trusts to close a balance alone holds both, and every acceptance
   *     they make of their own entry writes `self_review_reason_th` on the row for ever.
   *
   * ⚠️ Neither adds anything to `payments.verify`, and neither replaces it. Accepting an
   * evidence-free slip is still an acceptance: `POST /payments/slips/:id/acceptance` requires
   * `payments.verify`, `payments.read`, `orders.read` and `orders.write` exactly as it did
   * before, because the money lands through the same path and may still freeze an order.
   *
   * ⚠️ GRANTED TO NO GROUP AT BOOT, exactly as `quotes.approve` and `users.erase` are, and for
   * the identical reason. `permission-sync.service.ts` inserts the codes so a grant has
   * something to reference; **who holds them is plan 13's unanswered
   * *"บริษัทมีคนตรวจสลิป/อนุมัติกี่คนจริงๆ"*, and inventing a grant would be inventing the
   * answer.** The owner grants them by hand. Until they do, recording without a slip is refused
   * for want of a permission and self-review is refused by the rule it bypasses — which is the
   * fail-closed direction in both cases.
   */
  /*
   * ⭐ ITS OWN CODE, BECAUSE FORGIVING CASH IS NOT APPROVING A DISCOUNT.
   *
   * The owner's fifth payment requirement is ขออนุมัติตัดยอดค้างทิ้ง — a customer will not pay, a
   * settlement was agreed halfway, the remainder is not worth chasing, and somebody with
   * authority writes the balance off. `POST /orders/:orderId/write-offs` asks; the existing
   * `POST /quotes/approvals/:id/decision` answers, because it is one inbox and one decision.
   *
   * `quotes.approve` was the obvious place to leave it and is the wrong one. That code's own
   * description is *"approve or reject a concession somebody else asked for"* — a concession
   * measured from a quote, at quote time, before a customer has agreed to anything and before
   * any money has been asked for. A write-off happens at **collection** time, on a contract the
   * customer already signed, and it is the only approval in this system that money is *derived*
   * from rather than compared against: `order_written_off_thb_minor()` folds it and
   * `order_outstanding_thb_minor()` subtracts it, so approving one makes a live debt disappear
   * from the order list, from the ค้างชำระ filter and from the overview's money card. Somebody
   * the owner trusts to sign off 7% on a door is not thereby somebody the owner trusts to cancel
   * ฿20,000 the company is owed, and bundling the two would be plan 7.14(ข)3 again — a
   * permission that quietly carried an authority nobody agreed to, discovered afterwards by
   * reading what its holder could actually reach.
   *
   * ⚠️ It **adds to** `quotes.approve` and does not replace it. The decision route asks for both,
   * so a write-off needs *approver* and *may forgive cash*; `quotes.approve` alone still decides
   * every quote concession exactly as it did, and this code alone decides nothing at all — its
   * holder could not read the request they were being asked to judge (the same argument
   * `GET /quotes/approvals/queue` makes for demanding two codes).
   *
   * ⚠️ Nor does it replace the **ceiling**. A write-off is measured against `authority_limits`'
   * `cashflow` row exactly as any other cashflow concession is, and on a database with no live
   * row there — which is how this ships — no write-off can be approved whoever holds this.
   *
   * ⚠️ GRANTED TO NO GROUP AT BOOT, exactly as `quotes.approve`, `users.erase` and the two slip
   * codes above are, and for the identical reason. `permission-sync.service.ts` inserts the code
   * so a grant has something to reference; **who may forgive a customer's debt is the owner's
   * answer and inventing a grant would be inventing it.** Until they grant it by hand, a
   * write-off can be asked for and read in the inbox and cannot be approved — which is the
   * fail-closed direction, and the same shape as the empty ceiling table one layer down.
   */
  'payments.write_off':
    "Approve writing off part or all of a balance a customer owes — the only approval that subtracts from an order's outstanding figure. Asked for on the order, decided in the approval inbox, and needs `quotes.approve` beside it.",

  'payments.record_without_slip':
    'Record a payment with no slip image, stating why there is none. The entry still goes to the review queue.',
  'payments.self_review_slip':
    'Accept or reject a payment slip you entered yourself, stating why — the declared bypass of the two-person rule.',

  /*
   * The company's own profile, the bank accounts it is paid into, and — since the tax-
   * country round — the destinations it sells to and the deposit percentage that prices
   * every schedule. Settings, not a customer-facing resource. Placed next to `payments.*`
   * rather than at the end of the list: `payment_slips.received_bank_account_id` points at
   * a row this permission governs, so a payments admin reads this permission where they
   * would look for it.
   */
  'organisation.read':
    "Read the company's profile, its receiving bank accounts, and its per-destination tax settings and deposit percentage.",
  /*
   * Grants more than "letterhead and bank accounts" reads: the five tax-country routes
   * (`organisation.controller.ts`) reuse this code for the rate, treatment and basis of
   * every destination, and `putProfile` writes `organisation_profile.deposit_bp` — which
   * `AuthorityService` reads as the `cashflow` floor every schedule is measured against.
   * Lowering it lowers what counts as a concession needing approval, so granting this is
   * granting that too, not merely a name and an address.
   */
  'organisation.write':
    "Edit the company's profile, its receiving bank accounts, the tax rate, treatment and basis for every destination, and the deposit percentage — the floor a schedule's cashflow concession is measured against.",

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
