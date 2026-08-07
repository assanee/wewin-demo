/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The two questions step one asks about step two.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A port, not an import of `MfaSignInService`, and the reason is a cycle that would be
 * immediate: `MfaModule` needs `SESSION_STARTER`, which `PasswordModule` provides, so
 * `PasswordModule` importing `MfaModule` closes the loop and Nest refuses to boot.
 *
 * The same shape `SESSION_STARTER` and `PASSWORD_CREDENTIAL_STORE` already use in this
 * module, and for the same reason: the seam is two methods wide, so the indirection costs
 * almost nothing and buys a graph that resolves.
 *
 * ── ⚠️ The default implementation matters ────────────────────────────────────
 *
 * `NoSecondFactor` below answers "no" to everything, and it is what a graph without
 * `MfaModule` gets. That is the honest default — a build that does not include the second
 * factor does not have one — and it is also the failure mode to be careful about: if
 * `MfaModule` were ever dropped from `AppModule`, every account with MFA confirmed would
 * sign in with a password alone and nothing would say so. `tests/rbac/route-audit.test.ts`
 * lists `POST /auth/mfa`, so the route disappearing is a failing test; that is the guard.
 */

export interface SecondFactor {
  /** Whether this account has a confirmed second factor. Asked only after the password passes. */
  isRequired(userId: string): Promise<boolean>;

  /** The token that carries "factor one is proven" across to step two. */
  challenge(userId: string): { readonly token: string; readonly expiresAt: Date };
}

export const SECOND_FACTOR = Symbol('wewin.auth.secondFactor');

/**
 * What a graph without `MfaModule` gets.
 *
 * Never registered by `AppModule` — it exists for tests that boot `PasswordModule` alone and
 * have no business knowing about TOTP. Throwing from `challenge` rather than returning a
 * dummy: `isRequired` said no, so nothing should ever ask, and a stub that quietly produced
 * a token would turn a wiring mistake into a token nobody can verify.
 */
export class NoSecondFactor implements SecondFactor {
  isRequired(): Promise<boolean> {
    return Promise.resolve(false);
  }

  challenge(): never {
    throw new Error('no second factor is configured, so nothing should have asked for a challenge');
  }
}
