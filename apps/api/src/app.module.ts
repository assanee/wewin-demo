import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { CatalogModule } from './catalog/catalog.module';
import { RequestIdMiddleware } from './common/request-id';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';

/*
 * `forRoot(env)` rather than reading process.env inside the module: configuration is
 * validated in main.ts before Nest exists, and passing it in keeps that the only place it
 * is read. Tests build the same graph with a hand-written Env and no .env file anywhere.
 */
@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        DatabaseModule,
        HealthModule,
        MetaModule,
        CatalogModule,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // '{*splat}' and not '*': Express 5's path parser rejects a bare wildcard.
    consumer.apply(RequestIdMiddleware).forRoutes('{*splat}');
  }
}
