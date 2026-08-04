import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { attachIdentity } from '../rbac/identity';
import { AccessTokenService } from './session/access-token';

/**
 * The one place a request acquires an identity.
 *
 * Until this file existed, nothing in `src/` called `attachIdentity` — the session module
 * minted access tokens, the OAuth module signed people in, the guard resolved a scope, and
 * no HTTP request was ever anything but `guest` or `public`. Everything worked and nobody
 * was signed in. That is the gap this closes, and it is deliberately the *whole* of it: 40
 * lines whose only output is one call.
 *
 * **Middleware and not a guard.** Nest runs middleware before guards, so the identity is on
 * the request by the time `RbacGuard` reads it, and the ordering is a property of the
 * framework rather than of `APP_GUARD` registration order. It also means authentication
 * runs for routes that are anonymous, which is required: an anonymous route still has to
 * know whether it is talking to a signed-in customer.
 *
 * **A bad token is not an error here.** No throw, no 401 — the request simply stays
 * anonymous and the guard decides. Three reasons, in order: an expired token on an
 * anonymous route (the catalogue, `/me`) must not turn a browsing session into a wall of
 * 401s; the decision about what a missing identity costs belongs to the route's declared
 * access, which is the thing the boot audit checks; and a middleware that throws produces
 * an error the guard never sees, which would put two different bodies behind the same
 * status. The failure direction is the safe one — the worst a broken token can do is leave
 * the caller less privileged than they are.
 *
 * **Bearer only.** The access token deliberately never travels in a cookie (see
 * session-issuer.adapter.ts): a cookie is sent by the browser on requests the page did not
 * make, which is CSRF, and a readable one is exposed to script. The client holds it in
 * memory and sends it in a header, and the only cookie in this direction is the `__Host-`
 * refresh cookie, which is spendable at exactly one endpoint.
 */
@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Authentication');

  constructor(private readonly accessTokens: AccessTokenService) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined) {
      next();
      return;
    }

    const verified = this.accessTokens.verify(presented);
    if (!verified.ok) {
      // Debug: an expired token is what every idle tab presents, and a warning per idle tab
      // is a log nobody reads. The reason is the verifier's vocabulary and names no token.
      this.logger.debug(`Access token not accepted (${verified.reason})`);
      next();
      return;
    }

    attachIdentity(request, {
      kind: 'user',
      userId: verified.claims.sub,
      sessionId: verified.claims.sid,
    });
    next();
  }
}

/**
 * `Bearer <token>`, case-insensitively on the scheme and strictly on everything else.
 *
 * A header with two spaces, a second parameter, or any whitespace inside the credential is
 * not a token this service issued, and coercing it into one is how a parser starts
 * accepting things the signer never wrote.
 */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const separator = header.indexOf(' ');
  if (separator < 0) return undefined;
  if (header.slice(0, separator).toLowerCase() !== 'bearer') return undefined;

  const credential = header.slice(separator + 1);
  return credential.length > 0 && !/\s/.test(credential) ? credential : undefined;
}
