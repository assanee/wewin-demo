import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors/app-error';
import {
  ARGON2ID_PARAMETERS,
  hashPassword,
  verifyPassword,
} from '../../../src/auth/password/password-hash';
import type { SecondFactor } from '../../../src/auth/password/second-factor';
import { PasswordSignInService } from '../../../src/auth/password/password-sign-in.service';
import { SignInThrottle } from '../../../src/auth/password/sign-in-throttle';
import type {
  PasswordCredentialRow,
  PasswordCredentialStore,
} from '../../../src/auth/password/password.repository';
import type { IssuedSession } from '../../../src/auth/session/session.service';
import type { SessionStarter } from '../../../src/auth/password/session-starter';

/**
 * The sign-in decision, against fakes for the two things it talks to.
 *
 * Fakes rather than Postgres because everything interesting here is a *branch*, and the
 * branches are about what the caller is allowed to learn. `password-sign-in.pg.test.ts`
 * proves the same path over HTTP against a real database and a real session; this file is
 * where each refusal is stated one at a time and where the recorder can be asked the
 * question that matters most — **did a failed sign-in ask for a session?**
 */

const PASSWORD = 'ลมพัดผ่านหน้าต่างบานกระทุ้ง 2569';
const EMAIL = 'somchai@example.test';
const ADDRESS = '203.0.113.7';

class FakeStore implements PasswordCredentialStore {
  rows = new Map<string, PasswordCredentialRow>();
  /** Every address this was asked about, so a test can assert the lookup is normalised. */
  asked: string[] = [];
  rehashed: { userId: string; hash: string }[] = [];

  /** Verified numbers, keyed canonically — the only ones the real query can return. */
  phones = new Map<string, PasswordCredentialRow>();
  /** Claims nobody proved. Present so a test can show the lookup does *not* reach them. */
  unverifiedPhones = new Map<string, PasswordCredentialRow>();
  askedPhones: string[] = [];

  async findByVerifiedEmail(address: string): Promise<PasswordCredentialRow | undefined> {
    this.asked.push(address);
    return this.rows.get(address);
  }

  async findByClaimedPhone(number: string): Promise<PasswordCredentialRow | undefined> {
    this.askedPhones.push(number);
    return this.phones.get(number) ?? this.unverifiedPhones.get(number);
  }

  /** Not exercised by this suite — sign-in looks up by address. Present so the fake is one. */
  async findByUserId(userId: string): Promise<PasswordCredentialRow | undefined> {
    return [...this.rows.values()].find((row) => row.userId === userId);
  }

  async replaceHash(userId: string, hash: string): Promise<void> {
    this.rehashed.push({ userId, hash });
  }
}

class RecordingStarter implements SessionStarter {
  issued: string[] = [];

  async start(input: { userId: string }): Promise<IssuedSession> {
    this.issued.push(input.userId);
    return {
      sessionId: 'session-1',
      userId: input.userId,
      accessToken: 'access-token',
      accessTokenExpiresAt: new Date('2026-01-01T00:10:00Z'),
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: new Date('2026-04-01T00:00:00Z'),
      sessionExpiresAt: new Date('2026-04-01T00:00:00Z'),
    };
  }
}

let store: FakeStore;
let issuer: RecordingStarter;
let service: PasswordSignInService;

/**
 * A second factor this suite can switch on.
 *
 * `NoSecondFactor` would do for every test that predates MFA, and a controllable one is used
 * throughout instead so that the *default* in these tests is the same object that the
 * MFA tests below turn on — rather than two different fakes whose behaviour could drift.
 */
class SwitchableSecondFactor implements SecondFactor {
  required = new Set<string>();
  readonly challenged: string[] = [];

  isRequired(userId: string): Promise<boolean> {
    return Promise.resolve(this.required.has(userId));
  }

  challenge(userId: string): { readonly token: string; readonly expiresAt: Date } {
    this.challenged.push(userId);
    return { token: `challenge-for-${userId}`, expiresAt: new Date('2026-04-01T00:05:00Z') };
  }
}

let secondFactor: SwitchableSecondFactor;

const build = (): PasswordSignInService =>
  new PasswordSignInService(
    store,
    issuer,
    new SignInThrottle({
      perAccount: { limit: 5, windowMs: 15 * 60_000 },
      perAddress: { limit: 30, windowMs: 15 * 60_000 },
    }),
    secondFactor,
  );

beforeEach(async () => {
  secondFactor = new SwitchableSecondFactor();
  store = new FakeStore();
  issuer = new RecordingStarter();
  service = build();

  store.rows.set(EMAIL, {
    userId: 'user-1',
    status: 'active',
    passwordHash: await hashPassword(PASSWORD),
  });
});

const attempt = (email: string, password: string) =>
  service.signIn({ email, password, address: ADDRESS, userAgent: 'vitest' });

/** The status and reason of whatever an attempt threw. Fails loudly on a non-AppError. */
async function refusalOf(promise: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await promise;
    throw new Error('expected a refusal, got a session');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, reason: (error.details as { reason?: unknown })?.reason };
  }
}

describe('the happy path', () => {
  it('issues a session through the same seam OAuth uses', async () => {
    const result = await attempt(EMAIL, PASSWORD);

    // Not "returns a token": the cookies come back from `SESSION_ISSUER`, which is the
    // adapter over `SessionService`. Minting a session here instead would be a second
    // place with an opinion about refresh rotation, and fix ⓒ only works if there is one.
    expect(issuer.issued).toEqual(['user-1']);
    expect(result.kind === 'session' ? result.session.accessToken : null).toBe('access-token');
  });

  it('finds the account however the address was typed', async () => {
    await attempt('  Somchai@Example.TEST  ', PASSWORD);

    // Trimmed and lower-cased before it reaches the store, because
    // `user_emails_address_lowercase` is a CHECK — every stored address is already lower
    // case, so an un-normalised lookup would simply miss and read as "wrong password".
    expect(store.asked).toEqual([EMAIL]);
    expect(issuer.issued).toEqual(['user-1']);
  });
});

describe('⭐ no request may reveal whether an account exists', () => {
  /*
   * The single most important property of this endpoint, and the reason the tests below
   * compare refusals to each other rather than to a literal. An attacker with a list of
   * addresses wants one thing from a sign-in form: which of them are customers. Any
   * difference will do — a different status, a different reason string, a different
   * response time.
   *
   * `error.auth.credentials_rejected` is deliberately the *only* reason on this path.
   */
  it('answers a missing account exactly as it answers a wrong password', async () => {
    const missing = await refusalOf(attempt('nobody@example.test', PASSWORD));
    const wrong = await refusalOf(attempt(EMAIL, 'not the password'));

    expect(missing).toEqual(wrong);
    expect(missing.status).toBe(401);
    expect(missing.reason).toBe('credentials-rejected');
  });

  it('answers an account with no password the same way', async () => {
    // Somebody who signed up with Google and never set a password. Saying "this account
    // has no password" would confirm the address *and* name the provider to try next.
    store.rows.set('google-only@example.test', {
      userId: 'user-2',
      status: 'active',
      passwordHash: null,
    });

    const noPassword = await refusalOf(attempt('google-only@example.test', PASSWORD));
    const wrong = await refusalOf(attempt(EMAIL, 'not the password'));

    expect(noPassword).toEqual(wrong);
  });

  it('answers a suspended account the same way', async () => {
    store.rows.set(EMAIL, {
      userId: 'user-1',
      status: 'suspended',
      passwordHash: await hashPassword(PASSWORD),
    });

    /*
     * ⚠️ Even with the *correct* password. Telling a suspended user why they cannot sign in
     * is a support conversation the product has not designed (`account-status.ts` says the
     * same about its own opacity), and an attacker who can distinguish "suspended" from
     * "wrong password" has confirmed the account exists.
     */
    const suspended = await refusalOf(attempt(EMAIL, PASSWORD));
    const wrong = await refusalOf(attempt('nobody@example.test', PASSWORD));

    expect(suspended).toEqual(wrong);
    expect(issuer.issued).toEqual([]);
  });

  it('answers a corrupted hash the same way, and does not 500', async () => {
    store.rows.set(EMAIL, { userId: 'user-1', status: 'active', passwordHash: 'not a hash' });

    // `verifyPassword` already answers false rather than throwing; this is the assertion
    // that the service did not add a branch on top of it. A 500 here would be an oracle
    // saying "this account exists and its row is unusual".
    const corrupt = await refusalOf(attempt(EMAIL, PASSWORD));
    expect(corrupt.status).toBe(401);
    expect(corrupt.reason).toBe('credentials-rejected');
  });

  it('spends argon2 work on an address that does not exist', async () => {
    /*
     * ⭐ The timing half of the same property, and the one an implementation gets wrong by
     * being sensible: returning early when the lookup misses is the obvious code, and it
     * makes "no such account" arrive in a millisecond while "wrong password" takes ten.
     * That difference is readable over the internet and turns this endpoint into an account
     * enumerator with no rate limit that would notice.
     *
     * The service verifies against a dummy hash instead. Measured, not asserted from the
     * shape of the code, because the shape is exactly what a refactor changes.
     */
    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await refusalOf(attempt(email, 'whatever the password is'));
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await time(EMAIL);
    const known = await time(EMAIL);
    const unknown = await time('nobody-at-all@example.test');

    expect(
      Math.max(known, unknown) / Math.min(known, unknown),
      `known: ${known.toFixed(1)}ms · unknown: ${unknown.toFixed(1)}ms`,
    ).toBeLessThan(4);
  });
});

describe('a closed account', () => {
  it('is refused, and is the one place this differs from the OAuth path', async () => {
    store.rows.set(EMAIL, {
      userId: 'user-1',
      status: 'closed',
      passwordHash: await hashPassword(PASSWORD),
    });

    /*
     * ⚠️ A deliberate divergence from `signInDisposition`, which answers `reinstate` for a
     * closed account, and the reasoning is worth having in full because reusing that
     * function would have been the tidier code.
     *
     * Its justification is that proving control through a *provider* is a live
     * re-authentication — the person still holds the Google account today, and Google has
     * its own 2FA and its own breach response. A password proves something weaker: that
     * somebody knows a string this database has been storing since before the account was
     * closed. If the reason it was closed was a compromise, that string is exactly what the
     * attacker has.
     *
     * So reinstatement stays an OAuth-only exit. A password-only user who closes their
     * account cannot reopen it themselves — which is a real lockout and is named in the
     * plan rather than hidden, because the fix is the user-administration surface that
     * `account-status.ts` already says does not exist.
     */
    const closed = await refusalOf(attempt(EMAIL, PASSWORD));
    const wrong = await refusalOf(attempt('nobody@example.test', PASSWORD));

    expect(closed).toEqual(wrong);
    expect(issuer.issued).toEqual([]);
  });
});

describe('the throttle, from the service’s side', () => {
  it('refuses the sixth wrong password with 429 and never asks for a session', async () => {
    for (let attemptNo = 0; attemptNo < 5; attemptNo += 1) {
      await refusalOf(attempt(EMAIL, 'wrong'));
    }

    const refused = await refusalOf(attempt(EMAIL, 'wrong'));
    expect(refused.status).toBe(429);
    expect(issuer.issued).toEqual([]);
  });

  it('⚠️ refuses the *correct* password once the account is throttled', async () => {
    for (let attemptNo = 0; attemptNo < 5; attemptNo += 1) {
      await refusalOf(attempt(EMAIL, 'wrong'));
    }

    /*
     * This is the cost of the limiter and it is stated rather than tucked away: five wrong
     * guesses put a real person out of their own account for up to fifteen minutes. It is
     * the reason the window is short and the reason the counter clears on success, and it
     * is why a *lockout* — the version with no expiry — was rejected outright.
     */
    const refused = await refusalOf(attempt(EMAIL, PASSWORD));
    expect(refused.status).toBe(429);
    expect(issuer.issued).toEqual([]);
  });

  it('does not spend argon2 work on a throttled attempt', async () => {
    for (let attemptNo = 0; attemptNo < 5; attemptNo += 1) {
      await refusalOf(attempt(EMAIL, 'wrong'));
    }

    /*
     * The throttle is checked *before* the hash. Otherwise a refused attempt still costs
     * 19 MiB and two passes, and the limiter that exists to bound the damage becomes the
     * cheapest way to make the process do work — a 429 that is as expensive as a 401 is not
     * a defence, it is a slower attack.
     */
    const started = process.hrtime.bigint();
    await refusalOf(attempt(EMAIL, PASSWORD));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(ms, `${ms.toFixed(1)}ms`).toBeLessThan(3);
  });

  it('clears the account’s failures when the password is finally right', async () => {
    for (let attemptNo = 0; attemptNo < 4; attemptNo += 1) {
      await refusalOf(attempt(EMAIL, 'wrong'));
    }
    await attempt(EMAIL, PASSWORD);

    for (let attemptNo = 0; attemptNo < 4; attemptNo += 1) {
      await refusalOf(attempt(EMAIL, 'wrong'));
    }
    // Eight failures in one window, and still allowed, because of the success in the middle.
    const outcome = await attempt(EMAIL, PASSWORD);
    expect(outcome.kind === 'session' ? outcome.session.accessToken : null).toBe('access-token');
  });
});

describe('raising the cost upgrades credentials as people sign in', () => {
  it('re-hashes a weak stored hash, once, after a successful sign-in', async () => {
    store.rows.set(EMAIL, {
      userId: 'user-1',
      status: 'active',
      passwordHash: await hashPassword(PASSWORD, { ...ARGON2ID_PARAMETERS, timeCost: 1 }),
    });

    await attempt(EMAIL, PASSWORD);

    expect(store.rehashed).toHaveLength(1);
    expect(store.rehashed[0]?.userId).toBe('user-1');
    expect(store.rehashed[0]?.hash).toContain(`t=${String(ARGON2ID_PARAMETERS.timeCost)}`);

    /*
     * ⭐ **The new hash must be a hash of the same password.** Asserting only that it starts
     * `$argon2id$` and carries today's cost is not enough, and this is not hypothetical: the
     * first draft of the service called `hashPassword('')` — it never received the plaintext
     * — which produced a perfectly well-formed, perfectly current hash of the empty string.
     * Every user who signed in after that deploy would have had their credential replaced
     * with one their own password no longer opens, and every check above would still pass.
     */
    expect(await verifyPassword(store.rehashed[0]?.hash ?? '', PASSWORD)).toBe(true);
    expect(await verifyPassword(store.rehashed[0]?.hash ?? '', '')).toBe(false);
  });

  it('does not re-hash a current one', async () => {
    await attempt(EMAIL, PASSWORD);
    expect(store.rehashed).toEqual([]);
  });

  it('does not re-hash after a *failed* sign-in, because there is no plaintext to use', async () => {
    store.rows.set(EMAIL, {
      userId: 'user-1',
      status: 'active',
      passwordHash: await hashPassword(PASSWORD, { ...ARGON2ID_PARAMETERS, timeCost: 1 }),
    });

    await refusalOf(attempt(EMAIL, 'wrong'));

    // Obvious stated plainly: the only moment the plaintext exists is a successful verify.
    // A re-hash on the failure path could only be a re-hash of the *attacker's* guess.
    expect(store.rehashed).toEqual([]);
  });
});

describe('⭐ an account with a second factor gets a challenge, not a session', () => {
  it('⚠️ mints no session at all when MFA is confirmed', async () => {
    /*
     * The failure this rules out is total and quiet: returning a session *and* a challenge,
     * or returning a session while merely *suggesting* a challenge. Either way the caller
     * already holds what it was about to be asked to earn, and MFA is decoration.
     *
     * `issuer.issued` is the ledger of every session this service asked for, so an empty one
     * is the assertion — not the absence of a field on the response.
     */
    secondFactor.required.add('user-1');

    const outcome = await attempt(EMAIL, PASSWORD);

    expect(outcome.kind).toBe('challenge');
    expect(issuer.issued, 'a session was started for an account behind a second factor').toEqual([]);
    expect(secondFactor.challenged).toEqual(['user-1']);
  });

  it('⚠️ asks about the second factor only after the password is accepted', async () => {
    /*
     * Asking first would answer "does this account have MFA?" to anybody who typed the
     * address — the same enumeration leak the single refusal exists to close, arriving
     * through a different door.
     *
     * A wrong password against an MFA account must therefore look exactly like a wrong
     * password against any other: no challenge minted, no session, one refusal.
     */
    secondFactor.required.add('user-1');

    await refusalOf(attempt(EMAIL, 'wrong'));

    expect(secondFactor.challenged, 'the second factor was consulted before the password').toEqual(
      [],
    );
    expect(issuer.issued).toEqual([]);
  });

  it('still issues a session for an account without one', async () => {
    const outcome = await attempt(EMAIL, PASSWORD);

    expect(outcome.kind).toBe('session');
    expect(issuer.issued).toEqual(['user-1']);
    expect(secondFactor.challenged).toEqual([]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A TELEPHONE NUMBER IS THE OTHER USERNAME.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Thai customers frequently have no email address, so `user_phones` makes a number an
 * identity on the same terms an address is. One field carries either, and the service
 * decides which by shape.
 *
 * ⚠️ **That decision must not become an oracle**, and this block is mostly about that.
 * `password.contract.ts` refuses `z.string().email()` on the same field for the same
 * reason: "that is not a valid address" is a shape-based enumeration leak arriving through
 * the validator. Adding a second namespace doubles the ways to leak one:
 *
 *   ⓵ an unparseable username must fail **exactly like a wrong password** — same status,
 *     same reason, and having paid the same argon2 cost, so it cannot be timed apart;
 *   ⓶ the throttle must key on the **canonical** form, or `081-234-5678` and `0812345678`
 *     are two buckets and the limit is worth however many spellings a number has;
 *   ⓷ an unverified number must not sign anybody in, exactly as an unverified address does
 *     not — `user_phones_one_verified_owner` is partial, so unverified duplicates exist by
 *     design and a lookup that ignored `verified_at` would pick one of them.
 */

const PHONE_TYPED = '081-234-5678';
const PHONE_CANONICAL = '+66812345678';

describe('⭐ signing in with a telephone number', () => {
  beforeEach(() => {
    store.phones.set(PHONE_CANONICAL, {
      userId: 'user-phone',
      status: 'active',
      passwordHash: store.rows.get(EMAIL)?.passwordHash ?? null,
    });
  });

  it('⭐ signs in on a number the customer typed their own way', async () => {
    const outcome = await attempt(PHONE_TYPED, PASSWORD);

    expect(outcome.kind).toBe('session');
    /* And the store was asked about the canonical form, never the typed one. */
    expect(store.askedPhones).toStrictEqual([PHONE_CANONICAL]);
  });

  it.each(['0812345678', '+66 81 234 5678', '(081) 234-5678', '66812345678'])(
    'reaches the same account from %s',
    async (written) => {
      expect((await attempt(written, PASSWORD)).kind).toBe('session');
    },
  );

  it('⭐ an unparseable username fails exactly like a wrong password', async () => {
    /*
     * ⓵. Not "that is not a valid phone number" and not a 400 — the same 401 and the same
     * reason an unknown address gets, so the shape of the input tells an attacker nothing
     * about which namespace they are in or whether anything was found in it.
     */
    const nonsense = await refusalOf(attempt('not-a-username', PASSWORD));
    const unknownEmail = await refusalOf(attempt('nobody@example.test', PASSWORD));

    expect(nonsense).toStrictEqual(unknownEmail);
  });

  it('⚠️ still pays for the hash on an unparseable username', async () => {
    /*
     * The half a status-code assertion misses. Returning early on "this is neither a number
     * nor an address" would answer in microseconds where a real miss pays for argon2, and
     * the difference is a username oracle measurable over the network.
     *
     * ⚠️ Asserted as a **ratio against a known miss**, not against a millisecond threshold.
     * A fixed number is a test that passes on this laptop and fails on a loaded CI box —
     * and the property is not "takes 20 ms", it is "costs what a miss costs".
     */
    const time = async (username: string): Promise<number> => {
      const before = performance.now();
      await refusalOf(attempt(username, PASSWORD));
      return performance.now() - before;
    };

    const knownShape = await time('nobody@example.test');
    const unparseable = await time('not-a-username');

    expect(unparseable).toBeGreaterThan(knownShape / 3);
  });

  it('⭐ counts every spelling of one number against the same bucket', async () => {
    /*
     * ⓶. The throttle keys on what the *lookup* used, not on what was typed — otherwise an
     * attacker gets a fresh allowance per punctuation variant, and there are many.
     */
    const spellings = ['081-234-5678', '0812345678', '081 234 5678', '+66812345678'];
    const outcomes: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      for (const written of spellings) {
        outcomes.push((await refusalOf(attempt(written, 'wrong password entirely'))).status);
      }
    }

    expect(outcomes).toContain(429);
  });

  it('⭐ signs in on a claim nobody has proved yet', async () => {
    /*
     * ⓷, and the reversal of what this file asserted a commit ago.
     *
     * Verification means *possession of the handset*, and there is no free way to establish
     * it — Thai SMS costs money the owner has chosen not to spend, so it is a member of staff
     * on the telephone. Gating sign-in on that meant somebody who registered with a number
     * could not get in until they were called back, which is not self-service.
     *
     * ⚠️ What makes this safe is not a check here but an invariant elsewhere: **nothing
     * attaches to an unverified number.** `user_phones_number_key` gives one account per
     * telephone so this lookup is unambiguous, `user_phones_primary_is_verified` refuses to
     * make an unproved number the number of record, and staff lookup filters on
     * `verified_at`. A squatter therefore gets an account containing exactly what they put
     * in it, which is nothing.
     */
    store.phones.delete(PHONE_CANONICAL);
    store.unverifiedPhones.set(PHONE_CANONICAL, {
      userId: 'user-unverified',
      status: 'active',
      passwordHash: store.rows.get(EMAIL)?.passwordHash ?? null,
    });

    const outcome = await attempt(PHONE_TYPED, PASSWORD);

    expect(outcome.kind).toBe('session');
    expect(issuer.issued).toStrictEqual(['user-unverified']);
  });

  it('⚠️ a number nobody claimed is still refused like a wrong password', async () => {
    store.phones.delete(PHONE_CANONICAL);

    const refused = await refusalOf(attempt(PHONE_TYPED, PASSWORD));
    const unknown = await refusalOf(attempt('+66899999999', PASSWORD));

    expect(refused).toStrictEqual(unknown);
    expect(issuer.issued).toHaveLength(0);
  });

  it('⚠️ an address is still an address', async () => {
    /* The regression this block could cause. `somchai@example.test` has no digits to mistake. */
    expect((await attempt(EMAIL, PASSWORD)).kind).toBe('session');
    expect(store.askedPhones).toHaveLength(0);
  });
});
