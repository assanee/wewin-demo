import type { AddressInfo } from 'node:net';

import { Global, Module, type DynamicModule, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from '@wewin/db';

import { AllExceptionsFilter } from '../../../src/common/errors/all-exceptions.filter';
import { DRIZZLE } from '../../../src/database/database.tokens';
import { GuestRepository } from '../../../src/rbac/guest.repository';
import type { GuestCookie } from '../../../src/rbac/guest-cookie';
import { PermissionRepository, type EffectivePermissions } from '../../../src/rbac/permission.repository';
import { RbacModule } from '../../../src/rbac/rbac.module';
import type { RouteDeclaration } from '../../../src/rbac/route-declarations';
import type { PermissionCode } from '../../../src/rbac/permissions';
import { testEnv } from '../../support/app';

/**
 * A real Nest application, with the real guard and the real boot audit, over whatever
 * controllers a test hands it.
 *
 * Nothing about authorisation is stubbed here — the audit runs, the global guard runs,
 * and the request goes over a socket. The two things that are replaced are the two that
 * would otherwise drag Postgres into a suite that is not about Postgres: the Drizzle
 * handle (a proxy that throws if anything touches it, which is how these suites *prove*
 * they never do) and, where a test needs a user with permissions, the repository that
 * would have gone and read them.
 */

/**
 * `@Global` so `DRIZZLE` is visible inside `RbacModule` without it importing anything —
 * exactly how the real `DatabaseModule` exports it.
 */
@Global()
@Module({})
class UnusableDatabaseModule {
  static forRoot(): DynamicModule {
    /*
     * A handle whose query builders throw when *called*, not when read. A Proxy that
     * threw on every property access looked tidier and broke Nest: the container reads
     * `instance.onApplicationBootstrap` off every provider to find lifecycle hooks, so
     * the trap fired during init and the boot failure under test was replaced by this
     * one. The methods below are the four a repository can reach for.
     */
    const unreachable = (): never => {
      throw new Error('This suite must not reach the database.');
    };
    const database = {
      select: unreachable,
      insert: unreachable,
      update: unreachable,
      delete: unreachable,
    } as unknown as Database;

    return {
      module: UnusableDatabaseModule,
      providers: [{ provide: DRIZZLE, useValue: database }],
      exports: [DRIZZLE],
    };
  }
}

export interface FakePrincipal {
  readonly groupIds?: readonly string[];
  readonly permissions?: readonly PermissionCode[];
  /** Defaults to true. `false` is a suspended account, which the guard must refuse. */
  readonly active?: boolean;
}

/** `userId` → what the database would have said about them. Anyone absent has no groups and no permissions. */
export type PermissionTable = ReadonlyMap<string, FakePrincipal>;

export interface RbacAppOptions {
  readonly modules: readonly (Type<unknown> | DynamicModule)[];
  /** Defaults to `[]`: a fixture app has none of the application's routes, so it must have none of its declarations. */
  readonly declarations?: readonly RouteDeclaration[];
  readonly permissions?: PermissionTable;
  /** Makes the permission lookup reject, to exercise the "database is down" branch. */
  readonly permissionsUnavailable?: boolean;
  /**
   * `guests.id` values that exist and are unclaimed. Anything else is refused, which is
   * what the real repository does for a row that never existed or has since been claimed.
   * Absent means every well-formed id is open, which is what the suites written before the
   * check existed assume.
   */
  readonly openGuests?: readonly string[];
  /** Makes the guest lookup reject, to exercise the fall-back-to-public branch. */
  readonly guestsUnavailable?: boolean;
  /** Which guest-cookie name the guard reads. `false` is the bare `wewin_guest`. */
  readonly cookieSecure?: boolean;
}

export interface BootedRbacApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export async function bootRbacApp(options: RbacAppOptions): Promise<BootedRbacApp> {
  const env = testEnv();
  const builder = Test.createTestingModule({
    imports: [
      UnusableDatabaseModule.forRoot(),
      RbacModule.forRoot({
        declarations: options.declarations ?? [],
        cookieSecure: options.cookieSecure ?? false,
      }),
      ...options.modules,
    ],
  });

  const table = options.permissions;
  if (table || options.permissionsUnavailable) {
    builder.overrideProvider(PermissionRepository).useValue(fakeRepository(table, options.permissionsUnavailable));
  }

  // Always overridden: the guard now asks the database whether a guest id is a live,
  // unclaimed row, and these suites prove they never reach it.
  builder.overrideProvider(GuestRepository).useValue(fakeGuests(options));

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter(env));
  // Same order as main.ts: init runs the boot audit, listen binds the port afterwards.
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}

function fakeGuests(options: RbacAppOptions): GuestRepository {
  const open = options.openGuests;
  const repository: Pick<GuestRepository, 'isOpenGuest'> = {
    isOpenGuest: (cookie: GuestCookie): Promise<boolean> => {
      if (options.guestsUnavailable) return Promise.reject(new Error('connection terminated unexpectedly'));
      /*
       * The secret is not modelled here on purpose. These suites are about the *guard's*
       * policy matrix — which scope each route admits — and the real repository is what
       * decides whether a cookie is a live capability; a second implementation of that check
       * in a fixture would be a second answer to the question `guest.repository.ts` exists to
       * answer. `tests/rbac/guest-capability.pg.test.ts` proves the real one against Postgres.
       */
      return Promise.resolve(open === undefined || open.includes(cookie.guestId));
    },
  };
  return repository as GuestRepository;
}

function fakeRepository(table: PermissionTable | undefined, unavailable: boolean | undefined): PermissionRepository {
  const repository: Pick<PermissionRepository, 'effectivePermissions'> = {
    effectivePermissions: (userId: string): Promise<EffectivePermissions> => {
      if (unavailable) return Promise.reject(new Error('connection terminated unexpectedly'));
      const principal = table?.get(userId);
      return Promise.resolve({
        active: principal?.active ?? true,
        groupIds: principal?.groupIds ?? [],
        permissions: new Set(principal?.permissions ?? []),
      });
    },
  };
  // The class has no other members; a structural stand-in is closer to the real thing
  // than a subclass that would have to be given a database handle it never uses.
  return repository as PermissionRepository;
}
