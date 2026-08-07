import type { IssuedSession } from '../session/session.service';

/**
 * The one thing the password path needs from the session module.
 *
 * An interface and a token rather than injecting `SessionService` directly, for the reason
 * `session-issuer.ts` gives about its own seam: the assertion worth the most in
 * `password-sign-in.test.ts` is that a **failed** sign-in never asks for a session, and that
 * is stated against a recorder in one line. Against a real `SessionService` it would need a
 * database and would read as an absence rather than as a refusal.
 *
 * Narrower than `SessionIssuer` in what it hides and wider in what it returns: the full
 * `IssuedSession`, because an XHR sign-in hands the access token straight back to the caller.
 */
export interface SessionStarter {
  start(input: {
    readonly userId: string;
    readonly userAgent: string | null;
    readonly ip: string | null;
  }): Promise<IssuedSession>;
}

export const SESSION_STARTER = Symbol('wewin.auth.sessionStarter');
