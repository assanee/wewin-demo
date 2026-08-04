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
     */
    expect(records.map((record) => `${record.key} [${record.access.kind}]`)).toStrictEqual([
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
      'GET /meta [anonymous]',
      'POST /auth/logout [authenticated]',
      'POST /auth/oauth/:provider/callback [anonymous]',
      'POST /auth/refresh [anonymous]',
    ]);
  });
});
