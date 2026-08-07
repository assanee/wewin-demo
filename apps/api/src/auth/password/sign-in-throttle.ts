/**
 * A ceiling on password guessing, in two dimensions.
 *
 * ── Why OAuth never needed this and password does ────────────────────────────────
 *
 * Every existing sign-in route hands the credential check to Google, Apple, Facebook or
 * LINE. Those providers absorb the guessing, and `POST /auth/refresh` is not guessable —
 * its credential is a 256-bit token nobody types. A password is the first credential in
 * this system that a human chose out of a very small space, and the first one an attacker
 * can attack **here**, in this process, at whatever rate the network allows.
 *
 * ── Two buckets, because one of them is a lie on its own ─────────────────────────
 *
 * **Per address** stops one host working through a leaked password list against many
 * accounts — credential stuffing, which is by far the most common shape.
 *
 * **Per account** stops the same list being spread across a botnet. A per-address limiter
 * alone reads like a defence and buys an attacker with a thousand hosts a thousand buckets
 * against one victim. `FunnelThrottleMiddleware` says the same thing about its own key and
 * accepts it, because the thing it protects is row creation; here the thing protected is
 * somebody's account, so the second bucket is not optional.
 *
 * ── ⚠️ It counts failures, and it is not a lockout ───────────────────────────────
 *
 * The obvious design — five attempts then lock — hands an attacker a weapon: anybody who
 * knows an address can put its owner out of their own account, indefinitely, from a
 * coffee shop. Worse here than in most systems, because `users.read`/`users.write` have no
 * routes (`account-status.ts` says so) and there would be no operator to undo it.
 *
 * So: a **failure** counter that a **success clears**, in a window that expires on its own.
 * The person who mistypes five times and then remembers is never delayed, and no sequence
 * of requests by a third party can keep the real owner out for longer than one window.
 *
 * ── What it does not do ──────────────────────────────────────────────────────────
 *
 * In memory, therefore per process — two instances behind a load balancer allow twice the
 * traffic, exactly as `FunnelThrottleMiddleware` documents for the same reason: a shared
 * counter means Redis, and this application has no Redis. Stated rather than hidden.
 *
 * It is also not the only cost an attacker pays. `ARGON2ID_PARAMETERS` makes every attempt,
 * right or wrong, cost 19 MiB and a couple of passes — which is a rate limit of a different
 * kind, and the reason these numbers can be generous rather than paranoid.
 */

export interface ThrottleDimension {
  readonly limit: number;
  readonly windowMs: number;
}

export interface SignInThrottleOptions {
  readonly perAccount: ThrottleDimension;
  readonly perAddress: ThrottleDimension;
  /** Injected so the tests can state "the fifteenth minute" instead of waiting for it. */
  readonly now?: () => number;
}

export type ThrottleScope = 'account' | 'address';

export interface ThrottleRefusal {
  readonly scope: ThrottleScope;
  /** Seconds until this bucket's window closes. Shrinks as the window empties. */
  readonly retryAfterSeconds: number;
}

/**
 * ⚠️ **Neither number is a plan 13 answer** — the business has not been asked, and these are
 * this module's own defaults, chosen against what the two users actually do.
 *
 * Five failures per account per quarter hour: a person who cannot remember their password
 * makes three or four attempts and then reaches for the reset link. Thirty per address:
 * enough for a shared office to have a bad Monday morning, far below a useful stuffing run.
 *
 * A quarter of an hour rather than an hour so that a genuine lockout is short enough that
 * nobody opens a support ticket about it.
 */
export const SIGN_IN_ACCOUNT_LIMIT_DEFAULT = 5;
export const SIGN_IN_ADDRESS_LIMIT_DEFAULT = 30;
export const SIGN_IN_WINDOW_MS_DEFAULT = 15 * 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export class SignInThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perAccount: ThrottleDimension;
  private readonly perAddress: ThrottleDimension;
  private readonly now: () => number;

  constructor(options: SignInThrottleOptions) {
    this.perAccount = options.perAccount;
    this.perAddress = options.perAddress;
    this.now = options.now ?? Date.now;
  }

  /** Live buckets. Exposed so a test can assert the map does not grow without bound. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * The account key.
   *
   * Lower-cased, because `user_emails_address_lowercase` is a CHECK and the database has
   * therefore already decided that `Somchai@Example.TEST` and `somchai@example.test` are
   * one account. Keying on the raw string would hand an attacker a fresh bucket for every
   * capitalisation — 2^n of them for an n-letter address, which is not a limit at all.
   */
  private static accountKey(account: string): string {
    return `a:${account.trim().toLowerCase()}`;
  }

  private static addressKey(address: string): string {
    return `i:${address}`;
  }

  /**
   * Whether this attempt may proceed, and why not.
   *
   * Read-only: it counts nothing. The count happens in `failed`, after the password has
   * been checked, which is what makes this a failure counter rather than an attempt
   * counter — and that distinction is the whole of the "not a lockout" property above.
   *
   * The **account** refusal is reported when both apply. It is the more useful answer for a
   * person waiting, and the less useful one for a stuffer: "this account is busy" says
   * nothing about how close their address is to being cut off.
   */
  check(account: string, address: string): ThrottleRefusal | undefined {
    return (
      this.refusalFor('account', SignInThrottle.accountKey(account), this.perAccount) ??
      this.refusalFor('address', SignInThrottle.addressKey(address), this.perAddress)
    );
  }

  /** Count a wrong password against both buckets. */
  failed(account: string, address: string): void {
    this.collect();
    this.increment(SignInThrottle.accountKey(account), this.perAccount.windowMs);
    this.increment(SignInThrottle.addressKey(address), this.perAddress.windowMs);
  }

  /**
   * Forget this account's failures.
   *
   * The **address** bucket is deliberately left alone. One correct password does not excuse
   * the twenty-nine wrong ones that came before it from the same host — that pattern is
   * precisely a successful stuffing run, and clearing on success would make the address
   * limit unreachable for the only attacker it is meant to catch.
   */
  succeeded(account: string, _address: string): void {
    this.buckets.delete(SignInThrottle.accountKey(account));
  }

  private refusalFor(
    scope: ThrottleScope,
    key: string,
    dimension: ThrottleDimension,
  ): ThrottleRefusal | undefined {
    const bucket = this.buckets.get(key);
    const now = this.now();
    if (bucket === undefined || bucket.resetAt <= now || bucket.count < dimension.limit) {
      return undefined;
    }

    return { scope, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  private increment(key: string, windowMs: number): void {
    const now = this.now();
    const existing = this.buckets.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }

    existing.count += 1;
  }

  /**
   * Drop every expired bucket, on write.
   *
   * `FunnelThrottleMiddleware` collects opportunistically per key, which is enough there
   * because its keyspace is client addresses and a request from an address is what would
   * reclaim it. Here the keyspace includes **account identifiers an attacker chooses**, and
   * a made-up address is a bucket nobody will ever revisit — so per-key collection would
   * leave a map that only grows. Sweeping on every failure is O(live buckets) against work
   * that already costs 19 MiB of argon2, so it is not the expensive part of this path.
   */
  private collect(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
