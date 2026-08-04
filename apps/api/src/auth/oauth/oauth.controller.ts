import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError } from '../../common/errors/app-error';
import { AllowAnonymous } from '../../rbac/access';
import { readGuestCookie } from '../../rbac/guest-cookie';
import { OAuthService } from './oauth.service';
import { adapterFor } from './providers';
import { isProviderName } from './providers/provider.types';

/**
 * The two browser-facing endpoints, and nothing else.
 *
 * Everything here is a redirect, which is why there is no DTO and no JSON body in sight: the
 * caller is a browser following `Location` headers, and a well-formed error envelope would
 * be rendered as text on a blank page in front of a customer who was trying to log in. The
 * only responses that are not redirects are the ones a browser could not have produced — an
 * unknown provider, a `returnTo` that is not a path here — which stay as this API's normal
 * error shape because they mean a bug in the client, not a failed sign-in.
 *
 * **Why a POST route exists.** Apple returns the callback as a cross-site form submission
 * (`response_mode=form_post`), so the same logical endpoint has to accept both a query
 * string and an `application/x-www-form-urlencoded` body. The two are merged into one
 * parameter record before they reach the service, and the transport a provider is allowed to
 * use is checked against its adapter — a `POST` callback for Google is a request nothing
 * legitimate makes.
 *
 * **Why the routes declare anonymous access rather than carrying no decorator.** Plan
 * section 6 requires a boot-time route audit that refuses to start on an endpoint with no
 * guard, and `src/rbac/route-registry.service.ts` implements exactly that. A customer
 * signing in has no session, so none of these three can carry a permission — but "no
 * permission, deliberately" has to stay distinguishable from "somebody forgot", which is
 * what `@AllowAnonymous(reason)` is for. The reason is printed by the boot audit, so
 * `pnpm dev` lists every anonymous route and why.
 */

/*
 * The guest cookie is read through `../../rbac/guest-cookie` and not re-parsed here.
 *
 * Plan section 6's fourth scope variant — `{ kind: 'guest', guestId }` — is the anonymous
 * funnel, and a sign-in is where it stops being anonymous. This module does not own the
 * cookie's lifecycle; it only carries the id through the provider round trip so
 * `oauth_states.guest_id` has something to hold. It used to know the cookie's name itself,
 * with its own parser, and the two readers disagreed about which of two same-named cookies
 * wins — see src/common/cookies.ts for what that bought an attacker.
 */

@Controller('auth/oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  /**
   * Begins a sign-in: mints the state row and the binding cookie, then redirects to the
   * provider.
   *
   * 302 and not 307: this is a GET with no body, and the response must not be cached — a
   * cached authorisation URL would replay a `state` that has already been consumed. The
   * cache headers say so explicitly rather than relying on a proxy's defaults.
   */
  /**
   * Which sign-in buttons to render.
   *
   * Derived from the credentials this deployment actually holds, so a button never leads to
   * a 404 — and it is the same list `start` resolves against, not a second one kept in the
   * web app. Listing them is not a disclosure: a login page shows them anyway, and the
   * alternative is a client hard-coding four buttons and hiding three by hand.
   */
  @Get('providers')
  @AllowAnonymous('sign-in: a login page has to know which providers this deployment offers')
  providers(): { readonly providers: readonly string[] } {
    return { providers: this.oauth.enabledProviders() };
  }

  @Get(':provider/start')
  @AllowAnonymous('sign-in: the customer has no session yet — that is what this endpoint is for')
  async start(
    @Param('provider') provider: string,
    @Query('returnTo') returnTo: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.oauth.start({
      provider,
      returnTo,
      guestCookie: readGuestCookie(request.headers.cookie, this.oauth.cookieSecure),
    });

    response.setHeader('Set-Cookie', [...result.cookies]);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, result.redirectTo);
  }

  @Get(':provider/callback')
  @AllowAnonymous('sign-in: the provider returns the customer here before any session exists')
  async callbackByQuery(
    @Param('provider') provider: string,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTransport(provider, 'query');
    await this.finish(provider, stringsOnly(query), request, response);
  }

  /** Apple only. See the note at the top of the file. */
  @Post(':provider/callback')
  @AllowAnonymous("sign-in: Apple posts the callback cross-site, and there is no session until it succeeds")
  async callbackByForm(
    @Param('provider') provider: string,
    @Body() body: Readonly<Record<string, unknown>>,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTransport(provider, 'form_post');
    // Body wins: a query parameter on a form_post callback is somebody else's addition.
    await this.finish(provider, { ...stringsOnly(query), ...stringsOnly(body) }, request, response);
  }

  private async finish(
    provider: string,
    params: Readonly<Record<string, string>>,
    request: Request,
    response: Response,
  ): Promise<void> {
    const result = await this.oauth.complete({
      provider,
      params,
      cookieHeader: request.headers.cookie,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    if (result.cookies.length > 0) {
      response.setHeader('Set-Cookie', [...result.cookies]);
    }
    response.setHeader('Cache-Control', 'no-store');
    /*
     * A redirect either way. The failure URL carries `?error=denied|failed` and nothing
     * more — the web app decides what to say, and the API declines to tell a browser which
     * of its checks refused.
     */
    response.redirect(302, result.redirectTo);
  }

  /**
   * A provider may only come back the way it goes out.
   *
   * Without this, `POST /auth/oauth/google/callback` is a route that exists, and a
   * cross-site form post is the one request shape that reaches it without a preflight. The
   * binding cookie would still refuse it — but a check that exists is better than a check
   * that would probably have held.
   */
  private assertTransport(provider: string, transport: 'query' | 'form_post'): void {
    if (!isProviderName(provider)) {
      throw AppError.notFound(`No OAuth provider named "${provider}" is enabled.`);
    }
    if (adapterFor(provider).callbackTransport !== transport) {
      throw AppError.notFound(`No OAuth provider named "${provider}" is enabled.`);
    }
  }
}

/**
 * Express gives `unknown` for query and body entries because a client can repeat a
 * parameter (`?state=a&state=b` is an array) or nest it (`?state[x]=1` is an object).
 * Anything that is not a plain string is dropped rather than coerced: `String(['a','b'])`
 * is `'a,b'`, which is a value that matches nothing and looks like a value that should.
 */
function stringsOnly(source: Readonly<Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
