import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

import { GuestRepository } from './guest.repository';
import { PermissionRepository } from './permission.repository';
import { PrincipalController } from './principal.controller';
import { PermissionSyncService } from './permission-sync.service';
import { RbacGuard } from './rbac.guard';
import { RBAC_OPTIONS, type RbacOptions } from './rbac.options';
import { APPLICATION_ROUTE_ACCESS, ROUTE_DECLARATIONS, type RouteDeclaration } from './route-declarations';
import { RouteRegistryService } from './route-registry.service';

export interface RbacModuleOptions {
  /**
   * Access for routes whose controllers carry no decorator. Defaults to the application
   * table; a test that boots a fixture module passes its own (usually `[]`), because a
   * declaration for a route that is not in the graph is a boot failure by design.
   */
  readonly declarations?: readonly RouteDeclaration[];
  /**
   * Which guest-cookie name this deployment reads. Defaults to the secure profile, so a
   * caller that forgets it reads `__Host-wewin_guest` and simply does not see a cookie
   * written without the prefix — the direction that loses a cart rather than honouring one
   * a sibling subdomain could have planted.
   */
  readonly cookieSecure?: boolean;
}

/**
 * Authorisation for the whole process.
 *
 * `forRoot` rather than a plain `@Module`, for the same reason `AppModule.forRoot(env)`
 * exists: the one input this module has is passed in, so a test can build the real graph
 * with a different route table instead of the real one having a test-shaped seam in it.
 *
 * `APP_GUARD` binds the guard globally — every controller in every module, including ones
 * that do not import this module and ones that do not exist yet. That is the only binding
 * that makes "the API enforces on every endpoint" true by construction rather than by
 * everybody remembering `@UseGuards`.
 */
@Module({})
export class RbacModule {
  static forRoot(options: RbacModuleOptions = {}): DynamicModule {
    return {
      module: RbacModule,
      // DiscoveryModule is what makes the boot audit possible: it exports the controller
      // list and the prototype scanner Nest's own router explorer uses.
      imports: [DiscoveryModule],
      /*
       * One controller, and it is not an exception to "authorisation lives here": `GET /me`
       * reports the caller's own scope so a menu can be derived from permissions instead of
       * from a second copy of the model. It is guarded by the same global guard as
       * everything else and audited like everything else.
       */
      controllers: [PrincipalController],
      providers: [
        { provide: ROUTE_DECLARATIONS, useValue: options.declarations ?? APPLICATION_ROUTE_ACCESS },
        {
          provide: RBAC_OPTIONS,
          useValue: { cookieSecure: options.cookieSecure ?? true } satisfies RbacOptions,
        },
        RouteRegistryService,
        PermissionRepository,
        GuestRepository,
        PermissionSyncService,
        { provide: APP_GUARD, useClass: RbacGuard },
      ],
      exports: [RouteRegistryService, PermissionRepository, GuestRepository, PermissionSyncService],
    };
  }
}
