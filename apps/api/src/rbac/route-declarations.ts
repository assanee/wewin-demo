import { anonymousAccess, type RouteAccess } from './access';

/**
 * Access declared *here* for routes whose controllers do not carry a decorator.
 *
 * The decorator is the normal way and this is the exception, so it is worth being precise
 * about what the exception buys. The boot audit needs an answer for every route in the
 * process. Some of those routes live in modules that this round does not own — health,
 * meta and the catalogue read path all shipped in phase 3a — and the choice was between
 * editing files another agent owns and stating the same fact in one file that is reviewed
 * as a whole. A table of eight lines is easier to read for "what is reachable without
 * signing in" than eight decorators spread across three modules, and it is exactly the
 * list a security review asks for.
 *
 * What keeps it from rotting into an allowlist:
 *
 *   - an entry names the handler as well as the route. A path reused by a different
 *     controller does not inherit somebody else's declaration.
 *   - an entry that matches no live route fails the boot audit. Rename a path and the
 *     stale line stops the process rather than quietly protecting nothing.
 *   - an entry for a route that *does* carry a decorator fails the boot audit too. When a
 *     module adopts decorators, its line here has to go; there is no way to end up with
 *     two answers.
 *   - there is no wildcard. `POST /catalog/products` is not covered by
 *     `GET /catalog/products`, and nothing here matches a prefix.
 *
 * A new module adds decorators. It does not add lines here.
 */

export interface RouteDeclaration {
  /** `${METHOD} ${path}`, exactly as the audit prints it — e.g. `GET /catalog/products/:slug`. */
  readonly route: string;
  /** `${ControllerClass}.${method}` — the handler this declaration is about. */
  readonly handler: string;
  readonly access: RouteAccess;
}

/** Injection token, so a test can boot the guard with a different table (usually an empty one). */
export const ROUTE_DECLARATIONS = Symbol('wewin.rbac.routeDeclarations');

export const APPLICATION_ROUTE_ACCESS: readonly RouteDeclaration[] = [
  {
    route: 'GET /health',
    handler: 'HealthController.overall',
    access: anonymousAccess('probe: a load balancer has no session, and an outage is when this is read'),
  },
  {
    route: 'GET /health/live',
    handler: 'HealthController.live',
    access: anonymousAccess('probe: the orchestrator restarts this process based on the answer'),
  },
  {
    route: 'GET /health/ready',
    handler: 'HealthController.ready',
    access: anonymousAccess('probe: traffic is routed away from this instance based on the answer'),
  },
  {
    route: 'GET /meta',
    handler: 'MetaController.meta',
    access: anonymousAccess('build identity and wire conventions — a client needs these before it can authenticate'),
  },
  {
    route: 'GET /catalog/products',
    handler: 'CatalogController.list',
    access: anonymousAccess('the published catalogue is the funnel: a visitor configures and is quoted before signing in'),
  },
  {
    route: 'GET /catalog/products/:slug',
    handler: 'CatalogController.bySlug',
    access: anonymousAccess('the published catalogue is the funnel; only published versions are served'),
  },
  {
    route: 'GET /catalog/categories',
    handler: 'CatalogController.categories',
    access: anonymousAccess('navigation for the public catalogue'),
  },
];
