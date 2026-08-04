import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { attachIdentity, attachScope, cookieHeaderOf, readGuestCookie, readIdentity } from './identity';
import type { GuestCookie } from './guest-cookie';
import type { RouteAccess } from './access';
import { GuestRepository } from './guest.repository';
import { PermissionRepository } from './permission.repository';
import { RBAC_OPTIONS, type RbacOptions } from './rbac.options';
import { RouteRegistryService } from './route-registry.service';
import { matchScope, guestScope, userScope, PUBLIC_SCOPE, type Scope } from './scope';

/** Only what this guard reads off a request, so a unit test does not have to build an express object. */
interface GuardedRequest {
  readonly headers: Readonly<Record<string, unknown>>;
}

/**
 * The one place a request is allowed through.
 *
 * Bound with `APP_GUARD`, so it runs on every route in the process including the ones
 * that were added after this file was last read — which is the point. Its answer for a
 * route it cannot find a record for is "no", so the failure mode of a missing declaration
 * is a 403 rather than an open endpoint, and the boot audit turns that 403 into a boot
 * failure before anybody can hit it.
 *
 * Three things happen here in a fixed order, and the order matters:
 *
 *   1. resolve the route's stated access (from the audited map, never from metadata read
 *      a second time — the guard and the audit must not be able to disagree),
 *   2. resolve the principal into a `Scope` and attach it to the request, *always*,
 *      including on anonymous routes. A handler on an anonymous route still needs to know
 *      whether it is talking to a guest with a cart or to a crawler.
 *   3. decide.
 *
 * Step 2 before step 3 is deliberate: an anonymous route that returns 200 without a scope
 * attached would make `@CurrentScope()` throw inside the handler, and the handler is
 * where the guest cart is read.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger('Rbac');

  constructor(
    private readonly routes: RouteRegistryService,
    private readonly permissions: PermissionRepository,
    private readonly guests: GuestRepository,
    @Inject(RBAC_OPTIONS) private readonly options: RbacOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    /*
     * HTTP is the only transport this app has. If a second one ever arrives — a queue
     * consumer, a websocket — it gets its own principal resolution rather than inheriting
     * a cookie-shaped one by accident, so the answer here is no until somebody writes it.
     */
    if (context.getType<'http'>() !== 'http') {
      throw new ForbiddenException('This guard only understands HTTP requests.');
    }

    const record = this.routes.resolve(context.getHandler());
    if (!record) {
      // Unreachable if the audit ran: it is what makes every handler present in that map.
      throw new ForbiddenException('This endpoint declares no access policy.');
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const scope = await this.scopeFor(request);
    attachScope(request, scope);

    return allows(record.access, scope);
  }

  /**
   * Identity → scope. Least privilege at every fallback.
   *
   * Whatever authenticated the request attaches an identity; if nothing did, a valid
   * guest cookie makes this a guest; if there is not one of those either, it is `public`.
   * Each step down is strictly less privileged, so an authentication layer that fails
   * open is impossible from here — the worst it can do is fail closed.
   */
  private async scopeFor(request: GuardedRequest): Promise<Scope> {
    const identity = readIdentity(request);

    if (identity?.kind === 'user') {
      /*
       * The database is the only place permissions live, so an outage means this request
       * cannot be authorised — not that it can be authorised with none. 503 and not 403:
       * the caller is not forbidden, the service cannot answer, and the distinction is
       * what stops a support ticket about revoked access during what was actually a
       * database restart. The driver error is deliberately not forwarded; it can name a
       * table or a connection string.
       */
      const effective = await this.permissions.effectivePermissions(identity.userId).catch(() => {
        throw new ServiceUnavailableException('Permissions are temporarily unreadable.');
      });

      /*
       * An access token is verified by its signature alone, so suspending an account does
       * not invalidate the tokens already issued for it — they keep verifying until they
       * expire. `effectivePermissions` is a read this request makes anyway, so it is the
       * cheapest place to close that window: a suspended account is refused here rather
       * than up to a full access-token lifetime later. 401 and not 403 — the session is no
       * longer a session, which is what the client has to be told to stop retrying with it.
       */
      if (!effective.active) {
        throw new UnauthorizedException('This account is not active.');
      }

      return userScope({
        userId: identity.userId,
        sessionId: identity.sessionId,
        groupIds: effective.groupIds,
        permissions: effective.permissions,
      });
    }

    if (identity?.kind === 'guest') return guestScope(identity.guestId);

    const cookie = readGuestCookie(cookieHeaderOf(request), this.options.cookieSecure);
    if (cookie !== undefined && (await this.openGuest(cookie))) {
      /*
       * Recorded on the request too, so anything downstream that wants the guest id reads
       * it from the same place the authentication layer would have put it. The *secret* is
       * deliberately not carried onward: it has done its work here, and an identity object
       * holding a live credential is a credential that ends up in a log line.
       */
      attachIdentity(request, { kind: 'guest', guestId: cookie.guestId });
      return guestScope(cookie.guestId);
    }

    return PUBLIC_SCOPE;
  }

  /**
   * A cookie is a claim about a row; this is where it is checked against one.
   *
   * A database failure answers `false` rather than throwing, and that is the one place in
   * this guard where an outage does not become a 503. The reason is what a `guest` scope
   * buys: a cart, and no permission whatsoever. Falling back to `public` costs an anonymous
   * visitor a cart they could not have loaded during the outage anyway, whereas 503-ing the
   * whole anonymous funnel — the catalogue, the configurator, `/me` — turns a database blip
   * into a dark storefront.
   */
  private async openGuest(cookie: GuestCookie): Promise<boolean> {
    try {
      return await this.guests.isOpenGuest(cookie);
    } catch {
      this.logger.debug('Guest cookie could not be checked; serving this request as public');
      return false;
    }
  }
}

/**
 * Every access kind against every scope kind, with no default branch anywhere.
 *
 * `matchScope` is what makes that a compile-time property: add a fifth scope variant and
 * this function stops compiling until somebody has decided, per policy, what it may do.
 * A `switch` with a `default: return false` would compile — and the new variant would be
 * silently denied everywhere, including on the anonymous routes that are the funnel.
 */
function allows(access: RouteAccess, scope: Scope): boolean {
  switch (access.kind) {
    case 'anonymous':
      return true;

    case 'authenticated':
      return matchScope(scope, {
        user: () => true,
        system: () => true,
        guest: () => {
          throw new UnauthorizedException('Sign in to use this endpoint.');
        },
        public: () => {
          throw new UnauthorizedException('Sign in to use this endpoint.');
        },
      });

    /*
     * The funnel's own policy: somebody is here and they have a referent to scope rows by.
     *
     * A guest passes and the public does not, which is the whole distinction plan section 6
     * says the fourth scope variant exists to express. Note what this branch deliberately
     * does *not* do: it does not look at the request, the path or any id in it. Whether the
     * caller owns the row they named is not a question a guard can answer — the guard runs
     * before the handler and has never read the row — and answering it here would be plan
     * 7.4 trap 2 built into the framework. It belongs in the query that loads the order
     * (src/orders/scope), where the answer is a WHERE clause instead of an `if`.
     */
    case 'principal':
      return matchScope(scope, {
        user: () => true,
        guest: () => true,
        system: () => true,
        public: () => {
          throw new UnauthorizedException('กรุณาเข้าสู่ระบบ หรือเริ่มขอใบเสนอราคาก่อน');
        },
      });

    case 'permissions':
      return matchScope(scope, {
        // Holds everything by construction; never produced from an HTTP request.
        system: () => true,
        user: (user) => {
          const missing = access.codes.filter((code) => !user.permissions.has(code));
          if (missing.length === 0) return true;
          /*
           * The missing codes are named. They are not a secret — they are in the source,
           * in the database and in the dashboard's menu — and naming them is the
           * difference between "ask an administrator for orders.refund" and a support
           * thread that starts with "it says forbidden".
           */
          throw new ForbiddenException(`Missing permission: ${missing.join(', ')}.`);
        },
        guest: () => {
          throw new UnauthorizedException('Sign in to use this endpoint.');
        },
        public: () => {
          throw new UnauthorizedException('Sign in to use this endpoint.');
        },
      });
  }
}
