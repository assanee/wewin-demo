import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { createEmailTransport } from '../../notifications/channels/transports/create-transport';
import { EMAIL_TRANSPORT } from '../../notifications/notifications.tokens';
import { parseNotificationsConfig } from '../../notifications/notifications.config';
import { SessionService } from '../session/session.service';
import { PasswordResetController } from './password-reset.controller';
import {
  PASSWORD_RESET_CONFIG,
  PasswordResetService,
  type PasswordResetConfig,
} from './password-reset.service';
import { PASSWORD_RESET_STORE, PasswordResetRepository } from './password-reset.repository';
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
import { RESET_THROTTLE, SIGN_IN_THROTTLE } from './sign-in-throttle.token';

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
      controllers: [PasswordController, PasswordResetController],
      providers: [
        PasswordSignInService,
        PasswordResetService,
        { provide: PASSWORD_CREDENTIAL_STORE, useClass: PasswordRepository },
        { provide: PASSWORD_RESET_STORE, useClass: PasswordResetRepository },
        {
          provide: EMAIL_TRANSPORT,
          /*
           * This module's *own* transport instance. Importing `NotificationsModule` to share
           * one would bring `NotificationWorker` with it and start a second poller against
           * the same outbox — see `create-transport.ts`, which is the one place that decides
           * file-versus-smtp so the two cannot drift.
           */
          useFactory: () => createEmailTransport(parseNotificationsConfig(process.env)),
        },
        {
          provide: PASSWORD_RESET_CONFIG,
          useFactory: (): PasswordResetConfig => ({
            from: process.env['NOTIFICATIONS_EMAIL_FROM'] ?? 'WEWIN <no-reply@wewin.co.th>',
            /*
             * ⚠️ Defaults to the dashboard on a laptop. In production this must be set, and
             * getting it wrong sends staff a working token pointed at the wrong origin —
             * which is why it is read here, at boot, rather than built per request from a
             * `Host` header a caller controls.
             */
            resetUrlBase:
              process.env['PASSWORD_RESET_URL_BASE'] ?? 'http://localhost:3001/reset-password',
          }),
        },
        {
          provide: RESET_THROTTLE,
          /*
           * Separate from the sign-in counter. Sharing one would let five wrong passwords
           * spend the reset allowance, blocking the standard recovery with the very attempts
           * that prove it is needed. Three an hour is a person who did not receive the first
           * message; it is not a mail cannon.
           */
          useFactory: () =>
            new SignInThrottle({
              perAccount: { limit: 3, windowMs: 60 * 60_000 },
              perAddress: { limit: 20, windowMs: 60 * 60_000 },
            }),
        },
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
      /*
       * ⭐ Exported so `UsersModule` can send a set-password link when an administrator
       * creates an account — and exported *only this*. `PasswordSignInService` stays private:
       * one route mints sessions from a password, and a second module able to call it would
       * be a second place where "these credentials are good" is decided.
       */
      exports: [PasswordResetService],
    };
  }
}
