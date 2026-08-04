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
