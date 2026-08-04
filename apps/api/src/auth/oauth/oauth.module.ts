import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { OAuthHttp } from './http';
import { IdentityLinkService } from './identity-link.service';
import { JwksCache } from './jwks';
import { OAuthStateService } from './oauth-state.service';
import { OAUTH_CONFIG, parseOAuthConfig, type OAuthConfig } from './oauth.config';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { SessionIssuerAdapter } from './session-issuer.adapter';
import { SESSION_ISSUER, type SessionIssuer } from './session-issuer';

/**
 * The OAuth flows, as one module.
 *
 * `forRoot(options)` and not a plain `@Module`, for the same reason `AppModule.forRoot(env)`
 * takes its configuration: credentials are validated once, by the process, before Nest
 * constructs anything — so a half-configured provider is a boot failure with a list of what
 * is missing, not a 500 on somebody's first login attempt.
 *
 * **The session seam.** A sign-in ends by asking for a session, and by default that is
 * `SessionIssuerAdapter` over `../session` — the module that owns refresh rotation (fix ⓒ).
 * There is deliberately no *stub* fallback: an issuer that signed nobody in would turn "the
 * session module was not wired up" into a login that redirects successfully and does
 * nothing, which is the hardest possible version of that bug to find. A test supplies a
 * recorder through `sessionIssuer`, which is also how it asserts that a *failed* sign-in
 * never asks for one.
 *
 * `OAuthHttp` is provided by factory rather than by class, because its constructor takes a
 * timeout in milliseconds and Nest would otherwise try to resolve `Number` from the
 * container. That is also the seam a test uses to shorten it.
 */

export interface OAuthModuleOptions {
  /**
   * Parsed configuration. Omitted means `parseOAuthConfig(process.env)` — the production
   * path. A test passes a value with its own endpoints, which is what makes the whole flow
   * exercisable against a fake provider with no `NODE_ENV` check anywhere in `src`.
   */
  readonly config?: OAuthConfig;
  /**
   * Replaces the default adapter. When given, `SessionModule` is not required in `imports`
   * and nothing here touches `../session`.
   */
  readonly sessionIssuer?: SessionIssuer;
  /** Must export `SessionService` when `sessionIssuer` is omitted. */
  readonly imports?: ModuleMetadata['imports'];
  /** Provider request timeout. Left at `OAuthHttp`'s default in production. */
  readonly httpTimeoutMs?: number;
}

@Module({})
export class OAuthModule {
  static forRoot(options: OAuthModuleOptions = {}): DynamicModule {
    const config = options.config ?? parseOAuthConfig(process.env);

    const sessionIssuer =
      options.sessionIssuer === undefined
        ? [SessionIssuerAdapter, { provide: SESSION_ISSUER, useExisting: SessionIssuerAdapter }]
        : [{ provide: SESSION_ISSUER, useValue: options.sessionIssuer }];

    return {
      module: OAuthModule,
      imports: options.imports ?? [],
      controllers: [OAuthController],
      providers: [
        { provide: OAUTH_CONFIG, useValue: config },
        {
          provide: OAuthHttp,
          useFactory: () =>
            options.httpTimeoutMs === undefined
              ? new OAuthHttp()
              : new OAuthHttp(options.httpTimeoutMs),
        },
        JwksCache,
        OAuthStateService,
        IdentityLinkService,
        OAuthService,
        ...sessionIssuer,
      ],
      /*
       * `OAuthService` only. The state service, the linking service and the HTTP client are
       * this module's internals: a caller that could inject `IdentityLinkService` could
       * create an account holding a verified address without a provider having proved
       * anything, which is fix ⓐ with a side door.
       */
      exports: [OAuthService],
    };
  }
}
