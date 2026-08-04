import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { AuthenticationMiddleware } from './auth/authentication.middleware';
import type { OAuthConfig } from './auth/oauth/oauth.config';
import type { SessionConfig } from './auth/session/session.config';
import { CatalogModule } from './catalog/catalog.module';
import { RequestIdMiddleware } from './common/request-id';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { MetaModule } from './meta/meta.module';
import { RbacModule } from './rbac/rbac.module';

/*
 * `forRoot(env, …)` rather than reading process.env inside the module: configuration is
 * validated in main.ts before Nest exists, and passing it in keeps that the only place it
 * is read. Tests build the same graph with a hand-written Env and no .env file anywhere.
 *
 * The session configuration is a second parameter rather than part of `Env` because it
 * holds the access-token signing key as a `KeyObject` — `Env` is frozen, logged in parts,
 * and handed whole to every module in the graph, and a signing key should be in none of
 * those places. See src/auth/session/session.config.ts.
 */

export interface AppModuleOptions {
  readonly session: SessionConfig;
  /** Omitted means the OAuth module parses `process.env` itself. Tests pass their own. */
  readonly oauth?: OAuthConfig;
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env, options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        DatabaseModule,
        /*
         * Before the feature modules, though Nest does not care about the order: it binds
         * a global guard over every controller in the graph and audits every route at
         * boot, so a module added below this line is enforced whether or not it knows
         * this module exists. A new endpoint that states no access stops the process from
         * starting — see src/rbac/route-registry.service.ts.
         */
        RbacModule.forRoot({ cookieSecure: env.COOKIE_SECURE }),
        AuthModule.forRoot({
          session: options.session,
          ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
        }),
        HealthModule,
        MetaModule,
        CatalogModule,
        /*
         * The write side, after the read side for the same non-reason: order does not
         * matter to Nest here. It is last because it is the only module in this list whose
         * every endpoint requires a permission, so the boot audit's one-line summary reads
         * as "the public surface, then the guarded one".
         */
        AdminModule,
        /*
         * Images. Last, and it is the one module here that reaches something other than
         * Postgres — an S3-compatible bucket, configured from its own directory rather than
         * from `Env`, the same way OAuthModule handles its credentials. Nothing connects at
         * construction, so a graph built with no storage running still boots.
         */
        MediaModule.forRoot(),
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    /*
     * Order is the security property, and it is the order of this array: a request id
     * exists before anything logs, and the identity is attached before `RbacGuard` runs.
     * Nest runs middleware before guards, which is what makes the second half true by
     * construction rather than by `APP_GUARD` registration order.
     *
     * '{*splat}' and not '*': Express 5's path parser rejects a bare wildcard.
     */
    consumer.apply(RequestIdMiddleware, AuthenticationMiddleware).forRoutes('{*splat}');
  }
}
