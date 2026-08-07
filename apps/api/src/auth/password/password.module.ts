import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { SessionService } from '../session/session.service';
import { PasswordController } from './password.controller';
import { PasswordSignInService } from './password-sign-in.service';
import { PASSWORD_CREDENTIAL_STORE, PasswordRepository } from './password.repository';
import { SESSION_STARTER } from './session-starter';
import {
  SIGN_IN_ACCOUNT_LIMIT_DEFAULT,
  SIGN_IN_ADDRESS_LIMIT_DEFAULT,
  SIGN_IN_WINDOW_MS_DEFAULT,
  SignInThrottle,
} from './sign-in-throttle';
import { SIGN_IN_THROTTLE } from './sign-in-throttle.token';

/**
 * Password sign-in.
 *
 * ⚠️ **`forRoot({ imports: [sessions] })`, and the argument is the *same instance*.**
 * `AuthModule` hands over the `DynamicModule` value it already built, exactly as it does for
 * `OAuthModule` and for exactly the reason stated there: two `SessionModule.forRoot(config)`
 * calls compile, boot, and sign access tokens with two different keys. Every token minted at
 * sign-in would then be rejected by the middleware that verifies it, which presents as
 * "sessions randomly stop working" and is very hard to read back to this line.
 *
 * A plain `@Module` was written first and failed at boot — `Nest can't resolve dependencies
 * of Symbol(wewin.auth.sessionStarter)` — because a provider resolves through the graph of
 * the module that declares it, and this one declares `useExisting: SessionService`. Loud and
 * immediate, which is the good version of this mistake.
 *
 * It takes no configuration otherwise. The two throttle numbers are `sign-in-throttle.ts`'s
 * own defaults; the day somebody wants them from the environment is the day this gains a
 * second option, and adding one now would be a seam with nothing on the other side.
 */
export interface PasswordModuleOptions {
  /** The one `SessionModule.forRoot(...)` the application shares. */
  readonly imports?: ModuleMetadata['imports'];
}

@Module({})
export class PasswordModule {
  static forRoot(options: PasswordModuleOptions = {}): DynamicModule {
    return {
      module: PasswordModule,
      imports: options.imports ?? [],
      controllers: [PasswordController],
      providers: [
        PasswordSignInService,
        { provide: PASSWORD_CREDENTIAL_STORE, useClass: PasswordRepository },
        /*
         * `useExisting` and not `useClass`: the sign-in path must share the instance
         * `AuthController.refresh` and the OAuth callback already use. See the header.
         */
        { provide: SESSION_STARTER, useExisting: SessionService },
        {
          provide: SIGN_IN_THROTTLE,
          /*
           * A factory, because `SignInThrottle`'s constructor takes a plain object of numbers
           * and Nest would try to resolve it — `Nest can't resolve dependencies … argument
           * Object at index [0]`. One instance per process, which is what makes the counters
           * mean anything at all.
           */
          useFactory: () =>
            new SignInThrottle({
              perAccount: {
                limit: SIGN_IN_ACCOUNT_LIMIT_DEFAULT,
                windowMs: SIGN_IN_WINDOW_MS_DEFAULT,
              },
              perAddress: {
                limit: SIGN_IN_ADDRESS_LIMIT_DEFAULT,
                windowMs: SIGN_IN_WINDOW_MS_DEFAULT,
              },
            }),
        },
      ],
    };
  }
}
