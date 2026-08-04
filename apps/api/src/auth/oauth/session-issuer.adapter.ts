import { Injectable } from '@nestjs/common';

import { SessionService } from '../session/session.service';
import { refreshCookie } from '../session/refresh-cookie';
import type { IssuedSession, SessionIssueRequest, SessionIssuer } from './session-issuer';

/**
 * The default `SESSION_ISSUER`: hand the user id to the session module and turn what comes
 * back into cookies.
 *
 * Thin on purpose. Everything interesting about a session — the refresh chain, fix ⓒ's
 * atomic rotation, the cookie's attributes — belongs to `../session`, and this file exists
 * only so the OAuth flow does not have to know which of those it is talking to. The seam
 * itself (session-issuer.ts) stays an interface, because a test needs to assert that a
 * *failed* sign-in never asks for a session, and that is much easier to say against a
 * recorder than against a real one.
 *
 * **Only the refresh cookie is set, and the access token is deliberately dropped.** The
 * callback's response is a 302 the browser follows, so the two obvious places to put an
 * access token are both wrong: in the URL it lands in browser history, in the `Referer` of
 * every subsequent request and in any proxy log; in a readable cookie it is exposed to
 * script on every page. The refresh cookie is `httpOnly` and `__Host-` prefixed, and the
 * web app exchanges it for an access token on its first call — one extra round trip, once
 * per sign-in, in return for a credential that never exists anywhere a page can read it.
 *
 * `guestId` is ignored here, and that is not an oversight: the visitor was already claimed
 * inside the linking transaction (`IdentityLinkService.claimGuest`), so by the time this
 * runs the cart already belongs to the account. It stays on the request shape because the
 * next implementation of this seam may want to migrate rows rather than re-point them.
 */
@Injectable()
export class SessionIssuerAdapter implements SessionIssuer {
  constructor(private readonly sessions: SessionService) {}

  async issueForUser(request: SessionIssueRequest): Promise<IssuedSession> {
    const issued = await this.sessions.start({
      userId: request.userId,
      userAgent: request.userAgent ?? null,
      ip: request.ip ?? null,
    });

    return { cookies: [refreshCookie(issued.refreshToken, issued.refreshTokenExpiresAt)] };
  }
}
