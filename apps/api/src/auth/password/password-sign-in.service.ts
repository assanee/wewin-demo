import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { count, message } from '../../i18n';
import type { IssuedSession } from '../session/session.service';
import { SESSION_STARTER, type SessionStarter } from './session-starter';
import { hashPassword, needsRehash, verifyPassword } from './password-hash';
import {
  PASSWORD_CREDENTIAL_STORE,
  type PasswordCredentialRow,
  type PasswordCredentialStore,
} from './password.repository';
import { SIGN_IN_THROTTLE, type SignInThrottle } from './sign-in-throttle.token';
import { SECOND_FACTOR, type SecondFactor } from './second-factor';
import { normaliseUsername } from './username';

export interface PasswordSignInRequest {
  readonly email: string;
  readonly password: string;
  readonly address: string;
  readonly userAgent: string | undefined;
}

/**
 * Sign in with an email address and a password.
 *
 * ── ⭐ One refusal, five reasons ──────────────────────────────────────────────────
 *
 * A sign-in form is the cheapest account-enumeration tool an attacker has: feed it a list
 * of addresses and read which ones answer differently. Five distinct situations reach the
 * refusal below —
 *
 *   1. no account with that verified address
 *   2. an account that has never set a password (signed up with Google)
 *   3. a suspended account, **even with the right password**
 *   4. a closed account
 *   5. the wrong password
 *
 * — and all five produce byte-identical responses: 401, `error.auth.credentials_rejected`,
 * `reason: 'credentials-rejected'`. Not similar. Identical, because a client that can see
 * *any* difference can enumerate.
 *
 * ── And identical in time, which is the half that gets forgotten ─────────────────
 *
 * Returning early when the address is unknown is the obvious code and it is wrong: "no such
 * account" would come back in a millisecond while "wrong password" costs the full argon2
 * derivation, and ten milliseconds is a difference anybody can measure over the internet.
 * So an unknown address is verified against `DUMMY_HASH` and the answer thrown away. The
 * work is the point.
 *
 * ── What it deliberately does *not* reuse ────────────────────────────────────────
 *
 * `signInDisposition` in `../../rbac/account-status` answers `reinstate` for a closed
 * account, and OAuth acts on that. This path refuses instead, and the divergence is
 * argued in `password-sign-in.test.ts`: a provider assertion is a live re-authentication,
 * a password is a string this database has been holding since before the account closed.
 * Reinstatement stays an OAuth-only exit.
 */
/**
 * What step one produces.
 *
 * `kind` rather than an optional field, so `switch` is exhaustive and a handler that has not
 * been taught about the second factor fails to compile instead of failing at runtime.
 */
export type SignInOutcome =
  | { readonly kind: 'session'; readonly session: IssuedSession }
  | { readonly kind: 'challenge'; readonly token: string; readonly expiresAt: Date };

@Injectable()
export class PasswordSignInService {
  private readonly logger = new Logger(PasswordSignInService.name);

  /**
   * A real argon2id hash of a value nobody knows, verified against when the address is
   * unknown so that the miss costs what a hit costs.
   *
   * Computed once, lazily, and never compared for equality with anything — its only job is
   * to make `verifyPassword` do the work. A constant literal would do the same job; it is
   * generated so that nobody can precompute the timing of *this* deployment's dummy path.
   */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(PASSWORD_CREDENTIAL_STORE) private readonly store: PasswordCredentialStore,
    @Inject(SESSION_STARTER) private readonly sessions: SessionStarter,
    @Inject(SIGN_IN_THROTTLE) private readonly throttle: SignInThrottle,
    /*
     * A seam, not `MfaSignInService`. `PasswordModule` must not depend on `MfaModule` — MFA
     * needs `SESSION_STARTER`, which this module provides, and the cycle would be immediate.
     * The port is two methods wide and lives in this module's own file.
     */
    @Inject(SECOND_FACTOR) private readonly secondFactor: SecondFactor,
  ) {}

  /**
   * ⭐ Returns a **session or a challenge**, and the union is the point.
   *
   * Before the second factor existed this always ended in `sessions.start(...)`. Now an
   * account with MFA confirmed gets a challenge instead — factor one proven, factor two
   * outstanding — and `challenge.ts` explains why that token is signed with a different key
   * rather than being an access token wearing a flag.
   *
   * ⚠️ A **union rather than a nullable session**, so every caller has to say what it does
   * in both cases. A `session | null` would let a handler that had not been updated hand
   * back `null` and 500, or worse, treat the absence as an ordinary failure and tell the
   * person their password was wrong.
   */
  async signIn(request: PasswordSignInRequest): Promise<SignInOutcome> {
    /*
     * ⭐ One field, two namespaces, and the shape decides which.
     *
     * Normalised once, here, and used for the lookup *and* the throttle key. Two different
     * normalisations would mean an attacker gets a fresh bucket per capitalisation — and,
     * now that a number is a username, per punctuation variant, of which there are many
     * more.
     *
     * ⚠️ **A username this cannot parse is not an error.** `password.contract.ts` refuses
     * `z.string().email()` on this field because "that is not a valid address" is a
     * shape-based enumeration oracle arriving through the validator; answering "that is not
     * a valid telephone number" here would be the same leak through a different door, and
     * would additionally tell an attacker which namespace they had failed to be in. So an
     * unparseable username falls through as an address that matches nothing, pays for the
     * dummy hash like every other miss, and is refused identically.
     */
    const username = normaliseUsername(request.email);

    /*
     * Before the hash, not after. A 429 that still paid 19 MiB and two argon2 passes is not
     * a limit — it is the same attack, refused politely, at full cost to this process.
     */
    const refusal = this.throttle.check(username.key, request.address);
    if (refusal !== undefined) {
      throw new AppError(
        'TOO_MANY_REQUESTS',
        429,
        message('error.auth.too_many_attempts', {
          minutes: count(Math.ceil(refusal.retryAfterSeconds / 60)),
        }),
        { reason: 'too-many-attempts', retryAfterSeconds: refusal.retryAfterSeconds },
      );
    }

    /*
     * ⚠️ Exactly one lookup, chosen before the hash. Asking both and taking whichever
     * answered would double the database work on every attempt and — worse — would let a
     * number that is also a valid address shape reach two accounts.
     */
    const found =
      username.kind === 'phone'
        ? await this.store.findByClaimedPhone(username.key)
        : await this.store.findByVerifiedEmail(username.key);
    const usable = await this.check(found, request.password);

    if (usable === undefined) {
      this.throttle.failed(username.key, request.address);
      throw PasswordSignInService.rejected();
    }

    this.throttle.succeeded(username.key, request.address);
    await this.upgradeIfWeak(usable, request.password);

    /*
     * `SessionService.start` directly, and not the `SESSION_ISSUER` seam OAuth goes through.
     * That seam exists so `OAuthModule` need not depend on `SessionModule`, and it returns
     * `Set-Cookie` strings only — which for a browser redirect is exactly right and for an
     * XHR sign-in is not: the caller wants the access token now, and recovering it from the
     * seam would mean either widening it or spending a rotation to parse back a cookie this
     * process had just written. This module lives inside `AuthModule`, beside
     * `SessionModule`, so there is nothing to decouple from.
     */
    /*
     * ⭐ The gate, and it is asked *after* the password is accepted rather than before.
     *
     * Asking first would answer "does this account have MFA?" to anybody who typed the
     * address — which is the same enumeration leak the single refusal above exists to close,
     * arriving through a different door.
     */
    if (await this.secondFactor.isRequired(usable.userId)) {
      /*
       * ⚠️ The sign-in throttle is cleared here, deliberately, even though no session has
       * been issued. The password *was* correct, and holding somebody's earlier typos
       * against them past that point is what the clear is for.
       *
       * What stops this from handing an attacker unlimited guesses at the code is that step
       * two counts on `MFA_THROTTLE` — a different counter, which this does not touch. See
       * `mfa-throttle.ts`; sharing one would make the second factor's limit disappear while
       * looking present.
       */
      return { kind: 'challenge', ...this.secondFactor.challenge(usable.userId) };
    }

    return {
      kind: 'session',
      session: await this.sessions.start({
        userId: usable.userId,
        userAgent: request.userAgent ?? null,
        ip: request.address,
      }),
    };
  }

  /**
   * The row if this password may sign in as it, `undefined` otherwise.
   *
   * Every branch that answers `undefined` still verifies a hash first. That is the whole
   * shape of the function and the reason it does not read as tidy code: an `if (found ===
   * undefined) return undefined` at the top would be shorter, correct, and an enumeration
   * oracle.
   */
  private async check(
    found: PasswordCredentialRow | undefined,
    password: string,
  ): Promise<PasswordCredentialRow | undefined> {
    // A missing account and an account with no password take the same dummy path. The
    // second is a real state — signed up with Google, never set a password — and saying so
    // would confirm the address *and* name the provider worth trying.
    const hash = found?.passwordHash ?? (await this.dummy());
    const correct = await verifyPassword(hash, password);

    if (!correct || found === undefined || found.passwordHash === null) return undefined;
    // Only `active` proceeds. `closed` is refused here rather than reinstated — see the
    // class comment — and `erased` cannot reach this line anyway, because erasure deletes
    // every `user_emails` row and the lookup requires a verified one.
    return found.status === 'active' ? found : undefined;
  }

  /**
   * Replace a hash written under weaker parameters, now that the plaintext is in hand.
   *
   * The only moment it *is* in hand is a successful verify, which is why this runs here and
   * not on a schedule. A failure of the write is logged and swallowed: the person has
   * proven who they are and the credential that exists still works, so refusing the sign-in
   * over a housekeeping UPDATE would turn a cost-raising deploy into an outage.
   */
  private async upgradeIfWeak(row: PasswordCredentialRow, password: string): Promise<void> {
    if (row.passwordHash === null || !needsRehash(row.passwordHash)) return;

    try {
      // `password`, and the fact that this needs saying is the point: the first draft
      // called `hashPassword('')` here, which would have replaced the credential of every
      // signing-in user with a hash of the empty string on the deploy that raised the cost.
      // The test asserts the new hash verifies against the password that was just used.
      await this.store.replaceHash(row.userId, await hashPassword(password));
    } catch (error) {
      this.logger.warn(`could not re-hash the credential for ${row.userId}: ${String(error)}`);
    }
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(`no such account ${String(process.pid)}`);
    return this.dummyHash;
  }

  /** The one refusal. Built in one place so no branch can accidentally word it differently. */
  private static rejected(): AppError {
    return AppError.unauthenticated(message('error.auth.credentials_rejected'), {
      reason: 'credentials-rejected',
    });
  }
}
