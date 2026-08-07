import { afterEach, describe, expect, it } from 'vitest';

import { anonymousAccess } from '../../src/rbac/access';
import { RouteAuditError } from '../../src/rbac/route-audit.error';
import { RouteRegistryService } from '../../src/rbac/route-registry.service';
import { bootRbacApp, type BootedRbacApp } from './support/boot';
import { GuardedModule } from './fixtures/guarded.module';
import { InheritedHandlerModule } from './fixtures/inherited.module';
import { BareModule, UnguardedModule } from './fixtures/unguarded.module';
import { UndecoratedModule } from './fixtures/undecorated.module';
import { bootApp, type BootedApp } from '../support/app';

/**
 * The audit is the load-bearing part, so it is tested by adding the mistake.
 *
 * Every case below boots a real Nest application. There is no unit test of the scanner
 * against a hand-built list of routes, because the thing that would break in practice is
 * not the comparison — it is the discovery: a Nest upgrade that changes where route
 * metadata lives, or a decorator that registers a handler this scan does not walk. Only a
 * real graph can fail on that, and if this scan ever stops seeing a route, the tests here
 * go green while the endpoint goes unguarded. Which is why the *first* assertion is that a
 * known-good app finds the routes it should, by name.
 */
describe('boot-time route audit', () => {
  let booted: BootedRbacApp | undefined;
  let app: BootedApp | undefined;

  afterEach(async () => {
    await booted?.close();
    booted = undefined;
    await app?.close();
    app = undefined;
  });

  it('finds every decorated route, by name', async () => {
    booted = await bootRbacApp({ modules: [GuardedModule] });
    const records = booted.app.get(RouteRegistryService).records();

    expect(records.map((record) => record.key)).toStrictEqual([
      'GET /fixture/anonymous',
      'GET /fixture/orders',
      'GET /fixture/refunds',
      'GET /fixture/signed-in',
      // RbacModule's own endpoint, audited on the same terms as everything else.
      'GET /me',
    ]);
    expect(records.every((record) => record.source === 'decorator')).toBe(true);
  });

  it('refuses to start when one handler among several has no decorator', async () => {
    /*
     * The whole point of the round, in one assertion. Remove the audit and this boots:
     * `POST /fixture/forgotten` answers 403 from the guard's fail-closed branch instead,
     * which is safe but silent — and silence is what puts an unguarded endpoint into
     * production the day somebody's fail-closed branch is the one that has a bug.
     */
    await expect(bootRbacApp({ modules: [UnguardedModule] })).rejects.toThrow(RouteAuditError);
  });

  it('names the endpoint and the handler that were forgotten', async () => {
    const failure = await bootRbacApp({ modules: [UnguardedModule] }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteAuditError);
    const audit = failure as RouteAuditError;
    expect(audit.problems).toStrictEqual([
      'POST /fixture/forgotten (HalfGuardedController.forgotten) declares no access',
    ]);
    // The message has to be actionable on its own: it is written to stderr by main.ts and
    // is the entire diagnostic somebody gets from a failed deploy.
    expect(audit.message).toContain('@RequirePermissions');
    expect(audit.message).toContain('@AllowAnonymous');
  });

  it('refuses a controller-level route with no decorator anywhere', async () => {
    const failure = await bootRbacApp({ modules: [BareModule] }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteAuditError);
    expect((failure as RouteAuditError).problems).toStrictEqual(['GET /bare (BareController.index) declares no access']);
  });

  it('accepts a route answered for by the declaration table', async () => {
    booted = await bootRbacApp({
      modules: [UndecoratedModule],
      declarations: [
        {
          route: 'GET /legacy/report',
          handler: 'UndecoratedController.report',
          access: anonymousAccess('a fixture standing in for a controller this round does not own'),
        },
      ],
    });

    const records = booted.app.get(RouteRegistryService).records();
    const legacy = records.find((record) => record.key === 'GET /legacy/report');
    expect(legacy?.source).toBe('declaration');

    const response = await fetch(`${booted.baseUrl}/legacy/report`);
    expect(response.status).toBe(200);
  });

  it('refuses a declaration whose handler does not match the route', async () => {
    // Same path, different controller: this is what stops one module's declaration from
    // covering another module's endpoint after a path is reused.
    const failure = await bootRbacApp({
      modules: [UndecoratedModule],
      declarations: [
        {
          route: 'GET /legacy/report',
          handler: 'SomeOtherController.report',
          access: anonymousAccess('wrong handler'),
        },
      ],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteAuditError);
    expect((failure as RouteAuditError).problems).toStrictEqual([
      'GET /legacy/report (UndecoratedController.report) declares no access',
      "declaration 'GET /legacy/report' (SomeOtherController.report) matches no route in this build — the route was renamed or removed",
    ]);
  });

  it('refuses a stale declaration, so the table cannot rot into an allowlist', async () => {
    const failure = await bootRbacApp({
      modules: [GuardedModule],
      declarations: [
        {
          route: 'GET /fixture/renamed-last-week',
          handler: 'GuardedController.gone',
          access: anonymousAccess('a line nobody deleted'),
        },
      ],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteAuditError);
    expect((failure as RouteAuditError).problems[0]).toContain('matches no route in this build');
  });

  it('refuses a route that is both decorated and declared, so there is never a second answer', async () => {
    const failure = await bootRbacApp({
      modules: [GuardedModule],
      declarations: [
        {
          route: 'GET /fixture/orders',
          handler: 'GuardedController.orders',
          // Wider than the decorator, which is exactly the accident worth failing on.
          access: anonymousAccess('a declaration that would quietly widen a guarded route'),
        },
      ],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RouteAuditError);
    expect((failure as RouteAuditError).problems[0]).toContain('is decorated AND declared');
  });

  /**
   * Two routes, one handler function, one record — refused at boot.
   *
   * Without this check the app boots and `GET /admin/items` answers 200 to a caller with no
   * cookie, no token and no permission, while the audit reports "all guarded". It is the
   * one way an endpoint could still reach production unguarded after everything else in
   * this file passed, so it is checked here rather than trusted to review.
   */
  it('refuses to start when two controllers inherit one handler function', async () => {
    const failure = await bootRbacApp({ modules: [InheritedHandlerModule] }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RouteAuditError);
    const { problems } = failure as RouteAuditError;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shares one handler function with');
    // Both routes named, so the message says what to split rather than only where it noticed.
    expect(problems[0]).toContain('/shop/items');
    expect(problems[0]).toContain('/admin/items');
  });

  it('boots the real application and accounts for every endpoint it serves', async () => {
    app = await bootApp();
    const records = app.app.get(RouteRegistryService).records();

    /*
     * Not a count. If a new controller lands, this list changes and the diff says which
     * endpoint appeared and what it is reachable as — which is the review this exists to
     * force. Phase 3a's seven routes are all anonymous by declaration — each one is a
     * probe, a build identity, or the published catalogue that the funnel starts on — and
     * `GET /me` is anonymous by decorator, for the reason its controller gives.
     *
     * The six `auth` routes are phase 3b's, all decorated. Five are anonymous because a
     * person signing in has no session yet, which is what the endpoint is for; `POST
     * /auth/refresh` is the one worth pausing on, because "anonymous" there does not mean
     * "open" — the credential is the `__Host-` refresh cookie, which the guard has no way to
     * read. `POST /auth/logout` is the only authenticated route in the process today.
     *
     * The eighteen `/admin/catalog` routes are phase 4's, and the review this list exists to
     * force is a short one for them: **not one of them is anonymous or merely authenticated.**
     * Every single one states a permission, which is the difference between a dashboard whose
     * menu hides a button and a dashboard whose API refuses the request (plan section 6).
     * Three permissions appear, and the split is the point — `catalog.read` for looking,
     * `catalog.write` for editing a draft, and `catalog.publish` for the one action that
     * changes what a customer is quoted. Reading them off the `key` alone is not possible, so
     * the accompanying assertion below names the three sets.
     *
     * The five `media` routes are the image library. Four of them are `/admin/media` and
     * state a permission like everything else in this list; the fifth is the one that is
     * worth stopping on, because **`GET /media/:mediaId` is anonymous and serves
     * user-supplied bytes back to a browser**. It has to be — a published product page must
     * render for a visitor who has never signed in — and the reason it prints beside it in
     * the boot log is the review this list exists to force. What makes it safe is not the
     * guard, which there isn't one of: it is that the content type was decided by reading
     * the bytes, that SVG cannot be stored at all, and that the response carries `nosniff`
     * and a sandboxing CSP. See src/media/media.controller.ts.
     *
     * ── The nine order routes, and the one line this audit cannot print ─────────
     *
     * Eight are `[principal]` — a signed-in user *or* an identified guest — and one,
     * `POST /orders`, is `[anonymous]`, because it is the route that *mints* the principal
     * and refusing it would close the funnel plan section 6 calls the main path.
     *
     * ⚠️ Read what `[principal]` does **not** say. It says a caller has a referent; it says
     * nothing about which rows that referent reaches, and for these routes that is where all
     * the authority is: holding `orders.read` turns every one of them into a view of every
     * order in the company, and `orders.read` + `orders.write` turns the transition route
     * into authority over all of them. None of that is visible in this table, because it is
     * decided in the *query* (`src/orders/scope`) — which is exactly where plan 7.4 trap 2
     * says ownership has to live, and is therefore a limit of the audit rather than a defect
     * to fix in it. `describeAccess` says so in words on every principal route; the sweep in
     * `tests/orders/scope/cross-tenant-routes.pg.test.ts` is what actually walks them.
     *
     * ── The seventeen 5c routes, and the reason this list moved at all ──────────
     *
     * Eight `/orders/:orderId/quote/*` writes, one `/orders/:orderId/quote` read, six under
     * `/quotes/*` for approvals and ceilings, and two more for the ceiling table. **This audit
     * is what noticed they existed.** For a whole round both modules were built, tested and
     * absent from `AppModule.forRoot`, so every one of these was a 404 in the assembled
     * application while their own suites passed against a graph they booted by hand — the same
     * failure 5b had with `SlipsModule` and `RefundsModule`, and the same alarm caught it.
     *
     * Three permission splits are worth reading off, because they are the whole of who may do
     * what: the eight writes are `quotes.write`, the ceilings are `groups.write` (authority
     * attaches to a group, so a salesperson who could write that table could raise their own
     * ceiling), and `POST /quotes/approvals/:approvalId/decision` is **`quotes.approve`** — its
     * own code, held by nobody at boot. It was `quotes.write` for one round, which every
     * salesperson holds, so the permission system did not separate the approver from the
     * requester at all.
     */
    expect(records.map((record) => `${record.key} [${record.access.kind}]`)).toStrictEqual([
      'DELETE /admin/catalog/products/:productId/draft [permissions]',
      'DELETE /admin/catalog/products/:productId/draft/options/:groupCode [permissions]',
      'DELETE /admin/catalog/products/:productId/draft/rules/:ruleCode [permissions]',
      'DELETE /admin/groups/:groupId [permissions]',
      'DELETE /admin/media/:mediaId [permissions]',
      'DELETE /admin/users/:userId/suspension [permissions]',
      'DELETE /me/preferences [authenticated]',
      'DELETE /payments/slips/:slipId/image [permissions]',
      'DELETE /quotes/authority/limits/:groupId/:dimension [permissions]',
      'DELETE /reviews/photos/:photoId [principal]',
      'GET /admin/catalog/option-groups [permissions]',
      'GET /admin/catalog/products [permissions]',
      'GET /admin/catalog/products/:productId [permissions]',
      'GET /admin/catalog/products/:productId/draft [permissions]',
      'GET /admin/groups [permissions]',
      'GET /admin/media [permissions]',
      'GET /admin/media/:mediaId [permissions]',
      'GET /admin/notifications [permissions]',
      'GET /admin/notifications/:notificationId/attempts [permissions]',
      'GET /admin/notifications/summary [permissions]',
      'GET /admin/reviews/queue [permissions]',
      'GET /admin/users [permissions]',
      'GET /auth/oauth/:provider/callback [anonymous]',
      'GET /auth/oauth/:provider/start [anonymous]',
      'GET /auth/oauth/providers [anonymous]',
      'GET /catalog/categories [anonymous]',
      'GET /catalog/products [anonymous]',
      'GET /catalog/products/:slug [anonymous]',
      'GET /health [anonymous]',
      'GET /health/live [anonymous]',
      'GET /health/ready [anonymous]',
      'GET /me [anonymous]',
      'GET /me/preferences [anonymous]',
      'GET /media/:mediaId [anonymous]',
      'GET /meta [anonymous]',
      'GET /orders [principal]',
      'GET /orders/:orderId [principal]',
      'GET /orders/:orderId/document [principal]',
      'GET /orders/:orderId/events [principal]',
      'GET /orders/:orderId/payment-slips [principal]',
      /*
       * `[principal]` and not `[permissions]`, alone among the quote routes: a customer reads
       * their own quotation, and `encodeQuote` decides from the caller's `quotes.read` whether
       * the response carries any provenance at all. Every *write* below states a permission.
       */
      'GET /orders/:orderId/quote [principal]',
      'GET /payments/refunds [permissions]',
      'GET /payments/refunds/:refundId [permissions]',
      /*
       * ⚠️ `[anonymous]` and it has to be: a browser attaches no Authorization header to an
       * `<img>` request, so the signed grant IS the credential, exactly as an S3 presigned URL
       * is. What the audit can say is that somebody decided that on purpose.
       */
      'GET /payments/slip-images/:grant [anonymous]',
      'GET /payments/slips [permissions]',
      'GET /payments/slips/:slipId [permissions]',
      'GET /products/:productId/reviews [anonymous]',
      'GET /quotes/approvals [permissions]',
      'GET /quotes/approvals/:approvalId [permissions]',
      'GET /quotes/authority/limits [permissions]',
      'GET /quotes/authority/orders/:orderId [permissions]',
      'GET /reviews/:reviewId [principal]',
      'GET /reviews/photos/:photoId [anonymous]',
      'GET /reviews/reviewable-lines [principal]',
      'GET /reviews/schedule [permissions]',
      'PATCH /admin/catalog/option-groups/:groupCode [permissions]',
      'PATCH /admin/catalog/option-groups/:groupCode/values/:valueCode [permissions]',
      'PATCH /admin/catalog/products/:productId/draft [permissions]',
      'PATCH /admin/groups/:groupId [permissions]',
      'PATCH /admin/media/:mediaId [permissions]',
      'POST /admin/catalog/option-groups [permissions]',
      'POST /admin/catalog/option-groups/:groupCode/values [permissions]',
      'POST /admin/catalog/products [permissions]',
      'POST /admin/catalog/products/:productId/draft [permissions]',
      'POST /admin/catalog/products/:productId/draft/publish [permissions]',
      'POST /admin/groups [permissions]',
      'POST /admin/media [permissions]',
      'POST /admin/notifications/:notificationId/retry [permissions]',
      'POST /admin/reviews/:reviewId/hide [permissions]',
      'POST /admin/reviews/:reviewId/publish [permissions]',
      'POST /admin/reviews/:reviewId/reply [permissions]',
      'POST /admin/reviews/:reviewId/unhide [permissions]',
      'POST /admin/users [permissions]',
      'POST /admin/users/:userId/password-link [permissions]',
      'POST /admin/users/:userId/sessions/revocation [permissions]',
      'POST /admin/users/:userId/suspension [permissions]',
      'POST /auth/logout [authenticated]',
      'POST /auth/oauth/:provider/callback [anonymous]',
      'POST /auth/password [anonymous]',
      'POST /auth/password/reset [anonymous]',
      'POST /auth/password/reset-request [anonymous]',
      'POST /auth/refresh [anonymous]',
      'POST /orders [anonymous]',
      'POST /orders/:orderId/change-requests [principal]',
      'POST /orders/:orderId/change-requests/:changeRequestId/resolution [principal]',
      'POST /orders/:orderId/payment-slips [principal]',
      'POST /orders/:orderId/payment-slips/image [principal]',
      'POST /orders/:orderId/quote/charges [permissions]',
      'POST /orders/:orderId/quote/lines [permissions]',
      'POST /orders/:orderId/quote/lines/:lineId/presentation [permissions]',
      'POST /orders/:orderId/quote/lines/:lineId/removal [permissions]',
      'POST /orders/:orderId/quote/lines/:lineId/revision [permissions]',
      'POST /orders/:orderId/quote/overrides [permissions]',
      'POST /orders/:orderId/quote/overrides/:overrideId/revocation [permissions]',
      'POST /orders/:orderId/quote/verification [permissions]',
      'POST /orders/:orderId/transitions/:toStatus [principal]',
      'POST /payments/refunds [permissions]',
      'POST /payments/refunds/:refundId/decision [permissions]',
      'POST /payments/refunds/:refundId/disbursement [permissions]',
      'POST /payments/slips/:slipId/acceptance [permissions]',
      'POST /payments/slips/:slipId/image-grant [principal]',
      'POST /payments/slips/:slipId/rejection [permissions]',
      'POST /quotes/approvals [permissions]',
      'POST /quotes/approvals/:approvalId/decision [permissions]',
      'POST /reviews [principal]',
      'POST /reviews/:reviewId/photos [principal]',
      'PUT /admin/catalog/option-groups/:groupCode/values/:valueCode/availability [permissions]',
      'PUT /admin/catalog/products/:productId/draft/options/:groupCode [permissions]',
      'PUT /admin/catalog/products/:productId/draft/rules/:ruleCode [permissions]',
      'PUT /admin/groups/:groupId/permissions [permissions]',
      'PUT /admin/users/:userId/groups [permissions]',
      'PUT /me/preferences [authenticated]',
      'PUT /quotes/authority/limits [permissions]',
    ]);
  });
});
