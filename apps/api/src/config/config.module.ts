import { Global, Module, type DynamicModule } from '@nestjs/common';

import type { Env } from './env';

/** Injection token for the frozen, already-validated environment. */
export const ENV = Symbol('wewin.env');

/*
 * Global on purpose: every module needs configuration and none of them should have to
 * re-import a module to get it. The value is passed in rather than read here, so that
 * `main.ts` can fail on bad configuration before Nest has constructed anything at all.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
