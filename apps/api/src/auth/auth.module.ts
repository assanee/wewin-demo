import { Module, type DynamicModule } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthenticationMiddleware } from './authentication.middleware';
import { OAuthModule } from './oauth/oauth.module';
import { PasswordModule } from './password/password.module';
import { parseOAuthConfig, type OAuthConfig } from './oauth/oauth.config';
import { SessionModule } from './session/session.module';
import type { SessionConfig } from './session/session.config';

/**
 * Authentication, as one thing the application graph can hold.
 *
 * There were three modules and no way to add them — `SessionModule` owned rotation,
 * `OAuthModule` owned the provider flows, and neither was in `AppModule`, so the entire
 * round's work was unreachable over HTTP and every request in the shipping application
 * resolved to `guest` or `public`. This is the line that was missing, plus the two pieces
 * that only exist once both halves are in the same place: the middleware that turns a
 * bearer token into an identity, and the controller that spends a refresh cookie.
 *
 * `forRoot(options)` for the same reason every other module here takes one: configuration
 * is parsed by the process before Nest constructs anything, so a missing signing key stops
 * the boot instead of the first sign-in.
 *
 * **Why OAuth is passed `SessionModule` explicitly.** `OAuthModule`'s default session
 * issuer injects `SessionService`, and Nest resolves that through the importing module's
 * own graph — so handing it the *same instance* of `SessionModule` (a `DynamicModule` value,
 * not the class) is what makes the sign-in path and the refresh path share one
 * configuration. Two `SessionModule.forRoot(config)` calls would compile, boot, and sign
 * tokens with two different keys.
 */

export interface AuthModuleOptions {
  readonly session: SessionConfig;
  /** Omitted means `parseOAuthConfig(process.env)`. A test passes its own endpoints. */
  readonly oauth?: OAuthConfig;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const sessions = SessionModule.forRoot(options.session);
    const oauth = options.oauth ?? parseOAuthConfig(process.env);

    return {
      module: AuthModule,
      imports: [
        sessions,
        OAuthModule.forRoot({ config: oauth, imports: [sessions] }),
        /*
         * Password sign-in. Listed *after* `sessions` and inside this module rather than in
         * `AppModule`, because `PasswordModule` resolves `SessionService` through whichever
         * graph imports it — and this is the only place that graph contains the one
         * `SessionModule.forRoot(config)` instance the whole application shares.
         */
        PasswordModule.forRoot({ imports: [sessions] }),
      ],
      controllers: [AuthController],
      /*
       * The middleware is a provider here and is applied in `AppModule.configure`. It has
       * to be applied globally — an identity that only attaches on some routes is an
       * identity the guard cannot rely on — and `forRoutes` lives with the other global
       * middleware rather than being split across two files.
       */
      providers: [AuthenticationMiddleware],
      exports: [AuthenticationMiddleware, sessions],
    };
  }
}
