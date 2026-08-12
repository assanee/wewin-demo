import { afterEach, describe, expect, it } from 'vitest';

import { RouteRegistryService, type RouteRecord } from '../../src/rbac/route-registry.service';
import { bootApp, type BootedApp } from '../support/app';

/**
 * Which permission each admin endpoint demands, asserted route by route.
 *
 * `tests/rbac/route-audit.test.ts` proves every endpoint in the process *states* an access
 * policy — that is the boot audit's job and it fails the process when one does not. It
 * cannot prove the policy is the right one: a `catalog.read` on the publish endpoint would
 * satisfy the audit completely, and would mean anybody who can look at the catalogue can
 * change what every customer is quoted.
 *
 * So this is the second half, and it is written as a table for the same reason the
 * inventory test is: the diff is the review. Three sets, and the split between them is the
 * decision plan section 6 asks for —
 *
 *   `catalog.read`    looking. Includes drafts, which are unpublished prices, which is why
 *                     it is a permission at all rather than the anonymous access the
 *                     published catalogue has.
 *   `catalog.write`   editing a draft, and the option catalogue. Reversible, invisible to
 *                     customers until a publish — except for stock, which is why the
 *                     availability route is called out below rather than lost in a list.
 *   `catalog.publish` the one action that changes what a customer is quoted.
 *
 * Nothing here boots a fixture module. The real graph, the real controllers, the real
 * decorators — a test against a hand-built list would keep passing after somebody moved a
 * decorator onto the wrong handler.
 */

const ADMIN_ROUTE_PERMISSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['GET /admin/catalog/products', ['catalog.read']],
  ['GET /admin/catalog/products/:productId', ['catalog.read']],
  ['GET /admin/catalog/products/:productId/draft', ['catalog.read']],
  ['GET /admin/catalog/option-groups', ['catalog.read']],

  /*
   * ⭐ The exchange-rate feed's own health. `organisation.read` and not a new code: it is the
   * permission that already opens the screen this renders on and the `tax_countries` rows whose
   * `fxManualRate` is the way out of a stale rate. A fresh code would have to be granted to
   * every group that already holds `organisation.read` on day one, which is a migration to
   * express "the same people".
   *
   * Read-only, and there is deliberately no write route beside it: the thresholds are constants
   * and the *rate* is settable only through `PATCH /admin/organisation/tax-countries/:code`,
   * where it lands in `tax_country_changes` with an actor and a before/after.
   */
  ['GET /admin/fx/health', ['organisation.read']],
  /* ⭐ `organisation.write`, not the `read` that opens the screen this renders on: a manual
     sync spends a request against the provider's shared monthly plan, and the scheduled sync
     draws on the same pool. Costing something that runs out is the line the two organisation
     codes are drawn on everywhere else. See `FxController.syncNow`. */
  ['POST /admin/fx/sync', ['organisation.write']],

  /*
   * Media. Same two permissions as the catalogue it illustrates, deliberately: a person
   * who may change what a product is may change the picture of it, and nobody else needs
   * a third grant to reason about. Listing them here is what the audit is for — these
   * five existed before this line did, and the test failed until it caught up.
   */
  ['GET /admin/media', ['catalog.read']],
  ['POST /admin/media', ['catalog.write']],
  ['GET /admin/media/:mediaId', ['catalog.read']],
  ['PATCH /admin/media/:mediaId', ['catalog.write']],
  ['DELETE /admin/media/:mediaId', ['catalog.write']],

  ['POST /admin/catalog/products', ['catalog.write']],
  ['POST /admin/catalog/products/:productId/draft', ['catalog.write']],
  ['PATCH /admin/catalog/products/:productId/draft', ['catalog.write']],
  ['DELETE /admin/catalog/products/:productId/draft', ['catalog.write']],
  ['PUT /admin/catalog/products/:productId/draft/options/:groupCode', ['catalog.write']],
  ['DELETE /admin/catalog/products/:productId/draft/options/:groupCode', ['catalog.write']],
  ['PUT /admin/catalog/products/:productId/draft/rules/:ruleCode', ['catalog.write']],
  ['DELETE /admin/catalog/products/:productId/draft/rules/:ruleCode', ['catalog.write']],
  ['POST /admin/catalog/option-groups', ['catalog.write']],
  ['PATCH /admin/catalog/option-groups/:groupCode', ['catalog.write']],
  ['POST /admin/catalog/option-groups/:groupCode/values', ['catalog.write']],
  ['PATCH /admin/catalog/option-groups/:groupCode/values/:valueCode', ['catalog.write']],
  ['PUT /admin/catalog/option-groups/:groupCode/values/:valueCode/availability', ['catalog.write']],

  ['POST /admin/catalog/products/:productId/draft/publish', ['catalog.publish']],

  /*
   * The outbox's operator surface (plan 10.5: `dead` has to surface in a queue, because a
   * silent delivery failure means the company believes the customer was told). It borrows
   * `orders.*` for the reason media borrows `catalog.*` above — the messages are about
   * orders — and that borrowing is recorded as an open question rather than as a decision:
   * re-sending a message to a customer is not obviously the same authority as editing their
   * order. See docs/monorepo-plan.md §7.14.
   */
  ['GET /admin/notifications', ['orders.read']],
  ['GET /admin/notifications/summary', ['orders.read']],
  ['GET /admin/notifications/:notificationId/attempts', ['orders.read']],
  ['POST /admin/notifications/:notificationId/retry', ['orders.write']],
  /*
   * Moderation, phase 7 — and `reviews.moderate` is its own permission rather than
   * `orders.write` for the reason plan 9.3 gives: hiding a review is the one staff action
   * that changes what a customer *reads about the company*, and everything else on this
   * table changes what the company knows. Whoever ships orders should not thereby be able
   * to take down the review of one.
   *
   * All five demand the same code, including `unhide`. Asymmetric authority here would be
   * worse than none — a moderator who can hide but not restore has to escalate to undo their
   * own mistake, and the mistake that goes unreported is the one that stays hidden.
   */
  ['GET /admin/reviews/queue', ['reviews.moderate']],
  ['POST /admin/reviews/:reviewId/hide', ['reviews.moderate']],
  ['POST /admin/reviews/:reviewId/unhide', ['reviews.moderate']],
  ['POST /admin/reviews/:reviewId/publish', ['reviews.moderate']],
  ['POST /admin/reviews/:reviewId/reply', ['reviews.moderate']],
  /*
   * User administration — and the split is the point of the block.
   *
   * `users.read` looks: who is in what group, who still has a live session, who was
   * suspended and when. That is a question a manager or a support lead has an ordinary
   * reason to ask, and answering it should not require the ability to grant themselves
   * `orders.refund`.
   *
   * ⚠️ `users.erase` appears nowhere. Erasure is `erase_user()` in Postgres, it is
   * irreversible, and plan 7.16 still holds questions a lawyer owns — a route for it would
   * answer them by shipping. The permission exists in the catalogue and grants nothing,
   * which is the honest state rather than an oversight.
   */
  ['GET /admin/users', ['users.read']],
  ['GET /admin/groups', ['users.read']],
  ['POST /admin/users', ['users.write']],
  ['POST /admin/users/:userId/suspension', ['users.write']],
  /*
   * ⭐ `users.write`, the same code that suspends and reinstates — turning somebody's second
   * factor off is administration of their account, not a separate authority.
   *
   * ⚠️ The route additionally refuses to point at the caller's own account. That is not
   * expressible in this table, which is about permissions; it lives in `users/lockout.ts`
   * beside self-suspension, because it is a rule about *who* rather than about *may*.
   */
  ['GET /admin/audit', ['users.write']],
  ['DELETE /admin/users/:userId/mfa', ['users.write']],
  ['DELETE /admin/users/:userId/suspension', ['users.write']],
  /*
   * ⭐ A staff assertion, not proof of possession — `users.write` because it is the same
   * authority that edits the rest of the account, and deliberately no new code. See
   * `UsersService.verifyPhone` for what distinguishes this from a future SMS OTP.
   */
  ['POST /admin/users/:userId/phones/:phoneId/verification', ['users.write']],
  ['DELETE /admin/users/:userId/phones/:phoneId/verification', ['users.write']],
  ['PUT /admin/users/:userId/groups', ['users.write']],
  ['POST /admin/users/:userId/sessions/revocation', ['users.write']],
  ['POST /admin/users/:userId/password-link', ['users.write']],
  ['POST /admin/groups', ['users.write']],
  ['PATCH /admin/groups/:groupId', ['users.write']],
  ['DELETE /admin/groups/:groupId', ['users.write']],
  ['PUT /admin/groups/:groupId/permissions', ['users.write']],

  /*
   * The company's own profile and the bank accounts it is paid into — settings, not a
   * customer-facing resource (`src/organisation/`). `organisation.read` for looking,
   * `organisation.write` for editing, including the availability route: a deactivation is
   * `PUT` and not `DELETE` because a retired account is never removed (`bank_accounts_block_delete`
   * refuses it), so switching it off is a write like any other and carries the same permission.
   */
  ['GET /admin/organisation', ['organisation.read']],
  ['PUT /admin/organisation', ['organisation.write']],
  /*
   * ⭐ `organisation.read`, matching its two `…/changes` siblings, and worth one sentence of its
   * own: the profile carries `deposit_bp`, which is the `cashflow` approval floor, so
   * `organisation.write` now moves what counts as a concession needing approval. This is the only
   * route that can say who moved it — the table had a writer and no reader until task 12's review.
   */
  ['GET /admin/organisation/changes', ['organisation.read']],
  ['GET /admin/organisation/bank-accounts', ['organisation.read']],
  ['POST /admin/organisation/bank-accounts', ['organisation.write']],
  ['PATCH /admin/organisation/bank-accounts/:id', ['organisation.write']],
  ['PUT /admin/organisation/bank-accounts/:id/availability', ['organisation.write']],
  ['GET /admin/organisation/bank-accounts/:id/changes', ['organisation.read']],
  /*
   * Tax countries, the same split: `organisation.read` for looking, `organisation.write`
   * for editing — including the availability route, for the identical reason a bank-account
   * deactivation is `PUT` with `organisation.write` rather than a `DELETE` (`tax_countries_
   * block_delete` refuses one anyway). `GET /destinations` is deliberately not in this
   * table — it is not under `/admin`, which is exactly why it is public: see
   * `destinations.controller.ts`.
   */
  ['GET /admin/organisation/tax-countries', ['organisation.read']],
  ['POST /admin/organisation/tax-countries', ['organisation.write']],
  ['PATCH /admin/organisation/tax-countries/:code', ['organisation.write']],
  ['PUT /admin/organisation/tax-countries/:code/availability', ['organisation.write']],
  ['GET /admin/organisation/tax-countries/:code/changes', ['organisation.read']],
]);

const codesOf = (record: RouteRecord): readonly string[] =>
  record.access.kind === 'permissions' ? record.access.codes : [];

describe('admin routes and the permissions they demand', () => {
  let app: BootedApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('demands exactly the declared permission on every admin route, and no others exist', async () => {
    app = await bootApp();
    const admin = app.app
      .get(RouteRegistryService)
      .records()
      .filter((record) => record.key.startsWith('GET /admin') || record.key.includes(' /admin'));

    const actual = new Map(admin.map((record) => [record.key, codesOf(record)]));

    /*
     * Both directions. Comparing only the routes this table names would let a new admin
     * endpoint appear with any policy at all and still pass; comparing only the live routes
     * would let a stale line here look like it is protecting something.
     */
    expect([...actual.keys()].sort()).toStrictEqual([...ADMIN_ROUTE_PERMISSIONS.keys()].sort());

    for (const [key, expected] of ADMIN_ROUTE_PERMISSIONS) {
      expect(actual.get(key), key).toStrictEqual(expected);
    }
  });

  it('gives publishing its own permission, held by no other route', async () => {
    app = await bootApp();
    const records = app.app.get(RouteRegistryService).records();

    const publishers = records.filter((record) => codesOf(record).includes('catalog.publish'));

    // One route, and it is the one that freezes a document. If a second ever appears, the
    // question to answer is whether it also changes what a customer is quoted — and if it
    // does not, it should not carry this permission.
    expect(publishers.map((record) => record.key)).toStrictEqual([
      'POST /admin/catalog/products/:productId/draft/publish',
    ]);
  });

  it('never reaches an admin route without a permission', async () => {
    app = await bootApp();
    const records = app.app.get(RouteRegistryService).records();

    const adminRecords = records.filter((record) => record.key.includes('/admin/'));
    expect(adminRecords.length).toBeGreaterThan(0);

    // The failure this rules out is a copy-pasted `@AllowAnonymous` on a write endpoint,
    // which the boot audit accepts happily — it audits that a policy exists, not that it
    // is a sane one.
    expect(adminRecords.every((record) => record.access.kind === 'permissions')).toBe(true);
  });
});
