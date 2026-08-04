import { Module, type DynamicModule } from '@nestjs/common';

import { AccessTokenService } from './access-token';
import type { SessionConfig } from './session.config';
import { SessionRepository } from './session.repository';
import { SessionService } from './session.service';
import { SESSION_CONFIG } from './session.tokens';

/**
 * `forRoot(config)`, the same shape as `AppModule.forRoot(env)` and for the same reason:
 * configuration is parsed and validated before Nest builds anything, so a missing signing
 * key stops the process rather than the first request that needed one.
 *
 * `SessionRepository` injects `PG_POOL` without importing `DatabaseModule` — that module
 * is `@Global`, which is also why this one can be added to the graph with a single line in
 * `AppModule.forRoot`. That line is not written here: `src/app.module.ts` is outside this
 * module's ownership this round, so wiring is a hand-off, listed in the report.
 */
@Module({})
export class SessionModule {
  static forRoot(config: SessionConfig): DynamicModule {
    return {
      module: SessionModule,
      providers: [
        { provide: SESSION_CONFIG, useValue: config },
        SessionRepository,
        AccessTokenService,
        SessionService,
      ],
      /*
       * `AccessTokenService` is exported alongside `SessionService` because the request
       * guard needs to verify a bearer token without the ability to start or revoke a
       * session. `SESSION_CONFIG` is exported so a guard can read the lifetime it is
       * enforcing rather than assume one; the key inside it is a `KeyObject`, so exporting
       * it does not export the secret.
       */
      exports: [SessionService, AccessTokenService, SESSION_CONFIG],
    };
  }
}
