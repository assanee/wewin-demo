/**
 * How many ways an account still has of getting back in.
 *
 * The account-settings screen is the only place where somebody can remove their *own* means
 * of authentication, and the failure mode is silent and total: unlink the one Google account
 * and there is no password to reset, because there never was one. The login page then offers
 * nothing that person holds, and the only exit is an administrator or a database prompt.
 *
 * Same shape as `users/lockout.ts`, different subject. That one keeps the *company* able to
 * administer itself; this one keeps a *person* able to sign in.
 */

export interface WaysIn {
  readonly hasPassword: boolean;
  readonly providers: readonly string[];
  /** Verified only. An unverified address is a claim, and a reset link would never reach it. */
  readonly verifiedEmails: number;
}

/**
 * ⚠️ **A password only counts when there is a verified address to reset it through.**
 *
 * It still signs somebody in today, so it looks like a credential — but a credential with no
 * recovery is one forgotten passphrase away from being nothing, and the provider they are
 * about to unlink is what was actually holding the account open. This is why the function
 * counts *ways in* rather than credentials: the two differ in exactly the case that matters.
 *
 * A provider needs no address of ours: the provider is its own recovery.
 */
export function remainingWaysIn(ways: WaysIn): number {
  const password = ways.hasPassword && ways.verifiedEmails > 0 ? 1 : 0;
  return password + ways.providers.length;
}

export interface UnlinkCheck {
  readonly provider: string;
  /** The state the account would be in **after** the unlink lands. */
  readonly after: WaysIn;
}

/** `null` when the unlink is safe. */
export function unlinkProblem(check: UnlinkCheck): 'last-way-in' | null {
  return remainingWaysIn(check.after) === 0 ? 'last-way-in' : null;
}
