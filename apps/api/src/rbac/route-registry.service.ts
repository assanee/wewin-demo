import { Inject, Injectable, Logger, RequestMethod, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { describeAccess, isRouteAccess, ROUTE_ACCESS_METADATA, type RouteAccess } from './access';
import { RouteAuditError } from './route-audit.error';
import { ROUTE_DECLARATIONS, type RouteDeclaration } from './route-declarations';

/**
 * The boot-time route audit, and the table the guard answers from.
 *
 * One service and not two, because the audit is only worth having if the guard enforces
 * the same answer it checked. A separate audit could pass while the guard read metadata
 * some other way; here, the map the guard looks a handler up in *is* the map the audit
 * built, and a route that is absent from it never got past boot.
 *
 * Plan section 6: "API ต้อง enforce ทุก endpoint พร้อม boot-time route audit ที่ทำให้
 * endpoint ใหม่ที่ลืมใส่ guard บูตไม่ผ่าน" — a new endpoint whose guard was forgotten must
 * fail to boot. Not warn. A warning at boot is read once, by nobody, in a log that
 * scrolls; and the endpoint it was about is live either way.
 *
 * Discovery mirrors Nest's own router explorer exactly: walk the controller *prototype*
 * (`node_modules/@nestjs/core/router/paths-explorer.js` does the same), and treat a
 * method as a route if and only if it carries `PATH_METADATA`. That equivalence is what
 * makes "every route is audited" true rather than approximately true — a handler this
 * scan cannot see is a handler Nest does not route.
 */

export interface RouteRecord {
  /** `${METHOD} ${path}` — the first path, when a decorator declares several. */
  readonly key: string;
  /** Every path this handler answers on. `@Get(['a', 'b'])` is legal and rare. */
  readonly keys: readonly string[];
  readonly handlerName: string;
  readonly access: RouteAccess;
  readonly source: 'decorator' | 'declaration';
}

interface DiscoveredRoute {
  readonly keys: readonly string[];
  readonly handlerName: string;
  readonly handler: object;
  readonly decorated: RouteAccess | undefined;
}

@Injectable()
export class RouteRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger('RouteAudit');
  private readonly byHandler = new Map<object, RouteRecord>();
  private scanned = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(ROUTE_DECLARATIONS) private readonly declarations: readonly RouteDeclaration[],
  ) {}

  /**
   * `onApplicationBootstrap` and not `onModuleInit`: every module is initialised by then,
   * so every controller exists, and it still runs inside `app.init()` — which means the
   * throw happens before `app.listen()` binds a port. The process never serves a request
   * it could not have audited.
   */
  onApplicationBootstrap(): void {
    this.scan();
  }

  /** Throws `RouteAuditError` if any route's access is unstated, or any declaration is stale. */
  scan(): readonly RouteRecord[] {
    const routes = this.discover();
    const problems: string[] = [];
    const used = new Set<RouteDeclaration>();

    this.byHandler.clear();

    for (const route of routes) {
      const declared = this.declarations.filter(
        (declaration) => declaration.handler === route.handlerName && route.keys.includes(declaration.route),
      );
      for (const declaration of declared) used.add(declaration);

      if (route.decorated && declared.length > 0) {
        problems.push(
          `${route.keys[0] ?? '?'} (${route.handlerName}) is decorated AND declared in route-declarations.ts — ` +
            'delete the declaration, the decorator is the answer',
        );
        continue;
      }

      if (declared.length > 1) {
        problems.push(`${route.keys[0] ?? '?'} (${route.handlerName}) is declared ${declared.length} times in route-declarations.ts`);
        continue;
      }

      const access = route.decorated ?? declared[0]?.access;
      if (!access) {
        problems.push(`${route.keys[0] ?? '?'} (${route.handlerName}) declares no access`);
        continue;
      }

      /*
       * Two routes cannot share one record, and until this check existed they silently did.
       *
       * `byHandler` is keyed by the handler *function object*, which is what makes the map
       * the guard reads and the map the audit built the same map. Nest supports controller
       * inheritance and discovers inherited handlers, so two controllers extending one base
       * share the identical function — and a `Map` cannot hold two values for one key. The
       * second scan overwrote the first, both routes were served under whichever access was
       * scanned last, and the audit printed "all guarded" and exited 0. A shared CRUD base
       * class is the most ordinary thing in the world to add, and the failure is silent in
       * both directions: an admin route served anonymously, or the public funnel demanding
       * a permission nobody has.
       *
       * Keying by name instead is not available — `resolve()` is handed a function object
       * and nothing else — so the collision is refused at boot, where the fix is to give
       * the two controllers their own handlers or to move the policy onto the base class.
       */
      const clash = this.byHandler.get(route.handler);
      if (clash) {
        problems.push(
          `${route.keys[0] ?? '?'} (${route.handlerName}) shares one handler function with ` +
            `${clash.key} (${clash.handlerName}) — an inherited handler cannot carry two access policies`,
        );
        continue;
      }

      this.byHandler.set(route.handler, {
        key: route.keys[0] ?? '?',
        keys: route.keys,
        handlerName: route.handlerName,
        access,
        source: route.decorated ? 'decorator' : 'declaration',
      });
    }

    /*
     * A declaration that matches nothing is the failure that turns this table into an
     * allowlist: somebody renames a path, the line keeps sitting there looking like it
     * protects something, and the renamed route falls through to "declares no access" —
     * which at least fails loudly. Both halves ship in the same artefact, so failing on a
     * stale line cannot break a rollback the way a database mismatch would.
     */
    for (const declaration of this.declarations) {
      if (!used.has(declaration)) {
        problems.push(
          `declaration '${declaration.route}' (${declaration.handler}) matches no route in this build — ` +
            'the route was renamed or removed',
        );
      }
    }

    if (problems.length > 0) {
      this.byHandler.clear();
      this.scanned = false;
      throw new RouteAuditError(problems);
    }

    this.scanned = true;
    const records = this.records();
    const anonymous = records.filter((record) => record.access.kind === 'anonymous');
    this.logger.log(`${records.length} endpoints, all guarded — ${anonymous.length} deliberately anonymous`);
    for (const record of anonymous) {
      // Debug and not log: the list is a review surface, not something a healthy boot
      // should print seven lines of. `LOG_LEVEL=debug pnpm dev` shows it.
      this.logger.debug(`${record.key} — ${describeAccess(record.access)}`);
    }

    return records;
  }

  /**
   * What the guard asks. `undefined` means "no audited route owns this handler", and the
   * guard denies on it — the audit should have made that impossible, so this is the
   * belt to its braces rather than a case that happens.
   */
  resolve(handler: object): RouteRecord | undefined {
    return this.scanned ? this.byHandler.get(handler) : undefined;
  }

  /** Every audited route, sorted by path. The eventual source for "what may this user see". */
  records(): readonly RouteRecord[] {
    return [...this.byHandler.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  private discover(): readonly DiscoveredRoute[] {
    const routes: DiscoveredRoute[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || typeof instance !== 'object' || !metatype) continue;

      const prototype: object | null = Object.getPrototypeOf(instance);
      if (!prototype) continue;

      const controllerPaths = toPaths(readMetadata(PATH_METADATA, metatype));
      const controllerAccess = accessOf(metatype);

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;

        const path = readMetadata(PATH_METADATA, handler);
        if (path === undefined) continue; // not a route: exactly Nest's own test

        const method = verbOf(readMetadata(METHOD_METADATA, handler));
        const keys = controllerPaths.flatMap((base) =>
          toPaths(path).map((leaf) => `${method} ${joinPath(base, leaf)}`),
        );

        routes.push({
          keys,
          handlerName: `${metatype.name}.${methodName}`,
          handler,
          // A decorator on the handler beats one on the controller: `@Controller` level
          // is the coarse statement and the handler is where an exception to it is made.
          decorated: accessOf(handler) ?? controllerAccess,
        });
      }
    }

    return routes;
  }
}

/** `Reflect.getMetadata` is typed `any`; this is the one place that is contained. */
function readMetadata(key: string, target: object): unknown {
  return Reflect.getMetadata(key, target) as unknown;
}

function accessOf(target: object): RouteAccess | undefined {
  const value = readMetadata(ROUTE_ACCESS_METADATA, target);
  return isRouteAccess(value) ? value : undefined;
}

function toPaths(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((entry: unknown) => (typeof entry === 'string' ? entry : String(entry)));
  return [''];
}

function joinPath(base: string, leaf: string): string {
  const segments = [...base.split('/'), ...leaf.split('/')].filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/** `RequestMethod` is a numeric enum; the reverse mapping is the verb. */
function verbOf(value: unknown): string {
  if (typeof value !== 'number') return 'UNKNOWN';
  return RequestMethod[value] ?? `METHOD_${value}`;
}
