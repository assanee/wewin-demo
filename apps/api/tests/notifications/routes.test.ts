import { describe, expect, it } from 'vitest';

import { NotificationsController } from '../../src/notifications/notifications.controller';
import { ROUTE_ACCESS_METADATA, isRouteAccess, type RouteAccess } from '../../src/rbac/access';

/**
 * Every endpoint in this module states a policy, asserted without booting the app.
 *
 * ── Why this is not `tests/admin/route-permissions.test.ts` ──────────────────
 *
 * That file boots the real graph and compares the live route table against a declared one,
 * in both directions, and it **does now own these four routes** — the wiring landed with
 * phase 5a and `NotificationsModule` is in `AppModule.forRoot`. That is the test that proves
 * the guard is bound over these handlers, because it asks the running application.
 *
 * This file was written to stand in for it while the module was not in the graph, and it is
 * kept rather than deleted for one reason it can still do better: it names the *handler
 * methods*. A decorator on the wrong method is what a copy-paste produces, and the route
 * table cannot see the difference — `GET /admin/notifications` guarded correctly by the
 * wrong function is the same row. It also runs without Postgres, so a policy regression
 * shows up in a second rather than in a minute.
 *
 * The handler names are asserted too, because a decorator on the wrong method is the exact
 * mistake a copy-paste makes and the one this catches.
 */

/*
 * Nest stores these under plain string keys. Read as strings rather than imported from
 * `@nestjs/common/constants`, which is not part of the package's public surface — a deep
 * import that breaks on a minor upgrade would make this file the reason a security check
 * was deleted.
 */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** Nest's `RequestMethod` enum, the two values used here. */
const METHOD_NAMES: Readonly<Record<number, string>> = { 0: 'GET', 1: 'POST' };

interface Route {
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly access: RouteAccess | undefined;
}

function routesOf(controller: new (...args: never[]) => object): readonly Route[] {
  const prototype = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function')
    .map((name) => {
      const handler = prototype[name] as object;
      const access: unknown = Reflect.getMetadata(ROUTE_ACCESS_METADATA, handler);
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);

      return {
        handler: name,
        method: METHOD_NAMES[typeof method === 'number' ? method : -1] ?? String(method),
        path: typeof path === 'string' ? path : '',
        access: isRouteAccess(access) ? access : undefined,
      };
    });
}

const EXPECTED: ReadonlyMap<string, readonly string[]> = new Map([
  ['deadQueue', ['orders.read']],
  ['summary', ['orders.read']],
  ['attempts', ['orders.read']],
  /*
   * ⚠️ Retrying is a write: it causes a message to be sent to a customer. `orders.write` is
   * borrowed — `src/rbac/permissions.ts` has no `notifications.*` code and is not this
   * round's file — and the honest split is `notifications.read` / `notifications.retry`,
   * for the reason the controller's doc comment gives: re-sending to a customer is not
   * obviously the same authority as editing an order.
   */
  ['retry', ['orders.write']],
]);

describe('the dead-queue endpoints', () => {
  it('requires a permission on every handler, and never merely authentication', () => {
    const routes = routesOf(NotificationsController);

    expect(routes.length).toBe(EXPECTED.size);

    for (const route of routes) {
      // An endpoint with no declaration is not a public endpoint, it is one somebody forgot
      // — and once this module is wired in, the boot audit refuses to start the process on
      // it. Until then, this is what says so.
      expect(route.access, route.handler).toBeDefined();
      // `@AllowAnonymous` on any of these would satisfy the boot audit completely and would
      // publish a list of customers we failed to reach.
      expect(route.access?.kind, route.handler).toBe('permissions');

      const codes = route.access?.kind === 'permissions' ? route.access.codes : [];
      expect(codes, route.handler).toStrictEqual(EXPECTED.get(route.handler));
    }
  });

  it('puts the read verbs on GET and the retry on POST', () => {
    const byHandler = new Map(routesOf(NotificationsController).map((route) => [route.handler, route]));

    // A retry that could be triggered by a GET is a retry a link preview can fire.
    expect(byHandler.get('retry')?.method).toBe('POST');
    expect(byHandler.get('retry')?.path).toBe(':notificationId/retry');
    expect(byHandler.get('deadQueue')?.method).toBe('GET');
    expect(byHandler.get('summary')?.method).toBe('GET');
    expect(byHandler.get('attempts')?.method).toBe('GET');
  });
});
