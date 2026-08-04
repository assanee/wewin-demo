import type { UserStatus } from '@wewin/db/schema';

/**
 * What a `users.status` value means to a request, decided in exactly one place.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────────
 *
 * The brief for the erasure work asked for the rule "every query that loads a user must
 * now exclude the deleted ones" to *fail loudly* rather than quietly, on the grounds that
 * forgetting the variant reads as working code — the same shape as the guest-scope bug
 * plan section 6 warns about.
 *
 * The obvious answer is a `WHERE status <> 'erased'` in every repository, and it is the
 * wrong one. There are exactly three reads of `users.status` in this API —
 * `permission.repository.ts`, and two in `identity-link.service.ts` — and all three already
 * compare *positively* against `'active'`, so `closed` and `erased` are refused at every
 * existing site with no edit. A filter sprinkled across repositories is a term that can
 * vanish from an `and()` without the diff looking like a security change, which is
 * precisely what `ownershipFilter` (`orders/scope/order-ownership.ts`) was built to be
 * total against.
 *
 * The risk is not the three sites that exist; it is the fourth, written next year. So the
 * deliverable is a mechanism, and it is the one this codebase already owns: `matchScope`
 * (`rbac/scope.ts`) is a record with one required key per variant, pinned by a
 * `@ts-expect-error` in tests/rbac/scope.test.ts. `matchUserStatus` is the same trick
 * pointed at identity. Add a fifth status and every decision site stops compiling until
 * somebody has said what it means.
 *
 * ── Why not one boolean ─────────────────────────────────────────────────────────
 *
 * `EffectivePermissions` used to carry `active: boolean`, and the guard turned every
 * non-active status into one sentence: "This account is not active." That collapse costs
 * more now than it did with two members. Reinstatement may reverse a `closed`; it must
 * never be offered for an `erased`, because the data to reinstate no longer exists. And a
 * support conversation that cannot tell a reinstatable suspension from an irreversible
 * erasure is a support conversation that cannot answer "why can't I sign in" — the same
 * argument the schema already makes for `session_revocation_reason`.
 */

export interface UserStatusHandlers<T> {
  readonly active: () => T;
  readonly suspended: () => T;
  readonly closed: () => T;
  readonly erased: () => T;
}

/**
 * Every status, or it does not compile.
 *
 * A `switch` with `default:` would compile and the new member would silently take the
 * default branch — which, for an authorisation decision, is whichever answer happened to
 * be written first. tests/rbac/account-status.test.ts pins the absence of a default the
 * same way tests/rbac/scope.test.ts pins `matchScope`.
 */
export function matchUserStatus<T>(status: UserStatus, handlers: UserStatusHandlers<T>): T {
  switch (status) {
    case 'active':
      return handlers.active();
    case 'suspended':
      return handlers.suspended();
    case 'closed':
      return handlers.closed();
    case 'erased':
      return handlers.erased();
  }
}

/**
 * Why a request carrying a valid token is refused anyway.
 *
 * Not free text: `RbacGuard` turns it into a message, and `IdentityLinkService` turns the
 * same value into a decision about whether a provider proof may reinstate the account.
 * Two consumers, one vocabulary.
 */
export type AccountRefusal = 'suspended' | 'closed' | 'erased';

export type AccountUsability =
  | { readonly usable: true }
  | { readonly usable: false; readonly refusal: AccountRefusal; readonly message: string };

const USABLE: AccountUsability = Object.freeze({ usable: true });

/**
 * May this account be used to serve a request?
 *
 * The messages are deliberately different from each other and deliberately vague about the
 * *account*: they are returned to whoever holds the token, which after a shared browser is
 * not necessarily the account holder. What they do carry is whether the state is one a
 * human can undo, because "sign in again to reopen your account" and "this account has
 * been erased" are different instructions and a client that shows the first for the second
 * sends people round a loop.
 */
export function accountUsability(status: UserStatus): AccountUsability {
  return matchUserStatus<AccountUsability>(status, {
    active: () => USABLE,
    suspended: () => ({
      usable: false,
      refusal: 'suspended',
      message: 'This account is not active.',
    }),
    closed: () => ({
      usable: false,
      refusal: 'closed',
      message: 'This account is closed. Signing in again through your provider reopens it.',
    }),
    erased: () => ({
      usable: false,
      refusal: 'erased',
      message: 'This account has been erased and cannot be used.',
    }),
  });
}

/** What a provider proof of an existing account may do with it. */
export type SignInDisposition = 'proceed' | 'reinstate' | 'refuse';

/**
 * The half of the decision that only the sign-in path can make.
 *
 * `closed` is the whole reason this is not just `accountUsability`. A closed account that
 * kept its verified address and its provider identities but could never be reached again
 * would be a lockout wearing the word "reversible": `IdentityLinkService` branches 1 and 2
 * both refuse any non-active status, `OAuthService` turns that into a deliberately opaque
 * `failed` redirect, and `users.read`/`users.write` have no routes at all — so there is no
 * operator who could undo it either. Proving control of the account again through the
 * provider *is* a re-authentication, and it is the only exit that does not require an admin
 * surface that does not exist yet.
 *
 * `suspended` is not reinstated by signing in, and the difference is the point: an
 * administrator decided that one, and a decision a customer can undo by logging in is not a
 * suspension. `erased` is terminal in the database — `users_erasure_is_earned` refuses any
 * UPDATE that moves a row out of it — so this branch is belt and braces, not the guard.
 */
export function signInDisposition(status: UserStatus): SignInDisposition {
  return matchUserStatus<SignInDisposition>(status, {
    active: () => 'proceed',
    suspended: () => 'refuse',
    closed: () => 'reinstate',
    erased: () => 'refuse',
  });
}
