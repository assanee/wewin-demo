/**
 * The seam between "who is this" and "here is a session".
 *
 * This module answers the first question and deliberately does not answer the second. Fix
 * ⓒ — atomic refresh rotation with a grace window — lives in the session module, and the
 * one thing that must not happen is two places minting refresh tokens with two ideas about
 * rotation. So the OAuth flow ends by handing a `userId` to whoever owns that, and takes
 * back a list of `Set-Cookie` headers it does not interpret.
 *
 * `readonly cookies: readonly string[]` rather than a token in the body, because these are
 * browser flows: the callback's response is a redirect the customer's browser follows, and
 * a body would be discarded. It is also why the shape is Set-Cookie *strings* — cookie
 * attributes for a session are the session module's decision, and copying them here would
 * be two places to change when one of them moves.
 *
 * Provided by whoever imports `OAuthModule`, not by `OAuthModule` itself. There is no
 * default implementation on purpose: a fallback that signed nobody in would turn "the
 * session module was not wired up" into a login that redirects successfully and silently
 * does nothing, which is the hardest possible version of that bug to find.
 */

export const SESSION_ISSUER = Symbol('wewin.auth.sessionIssuer');

export interface SessionIssueRequest {
  readonly userId: string;
  /** For the customer's own device list — "Chrome on Windows, Bangkok, 2 hours ago". */
  readonly userAgent: string | undefined;
  readonly ip: string | undefined;
  /** The visitor this sign-in came from, already claimed, so a cart can be migrated. */
  readonly guestId: string | undefined;
}

export interface IssuedSession {
  /** Serialised `Set-Cookie` values, written verbatim onto the redirect response. */
  readonly cookies: readonly string[];
}

export interface SessionIssuer {
  issueForUser(request: SessionIssueRequest): Promise<IssuedSession>;
}
