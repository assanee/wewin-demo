import { describe, expect, it } from 'vitest';

import { SignInThrottle } from '../../../src/auth/password/sign-in-throttle';

/**
 * The limiter, as policy, with the clock passed in.
 *
 * A `Date.now()` inside would make every one of these a test that waits, so the constructor
 * takes a clock and each case advances it by hand. That is also what lets the interesting
 * cases be stated at all: "the fifteenth minute" is a line here and an afternoon otherwise.
 */

const throttleAt = (now: () => number) =>
  new SignInThrottle({
    perAccount: { limit: 5, windowMs: 15 * 60_000 },
    perAddress: { limit: 30, windowMs: 15 * 60_000 },
    now,
  });

/** A clock the test moves. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_700_000_000_000;
  return { now: () => value, advance: (ms) => (value += ms) };
}

const ACCOUNT = 'somchai@example.test';
const ADDRESS = '203.0.113.7';

describe('a wrong password costs the guesser, not the owner', () => {
  it('forgets an account’s failures the moment it gets the password right', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    /*
     * ⭐ The property this whole file exists for, and it has to be stated as failures either
     * side of a success — an earlier version of this test only ever called `succeeded`, so
     * there was never a bucket to clear and deleting the clear-on-success line left it
     * green. It asserted nothing.
     *
     * Four wrong, one right, four wrong again: eight failures in one window, which is past
     * the limit of five, and the person is still let in because the success in the middle
     * reset the count. That is what makes the limiter invisible to the only user who is not
     * attacking — someone who mistypes, remembers, and mistypes again tomorrow morning.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) throttle.failed(ACCOUNT, ADDRESS);
    expect(throttle.check(ACCOUNT, ADDRESS)).toBeUndefined();

    throttle.succeeded(ACCOUNT, ADDRESS);

    for (let attempt = 0; attempt < 4; attempt += 1) throttle.failed(ACCOUNT, ADDRESS);
    expect(throttle.check(ACCOUNT, ADDRESS)).toBeUndefined();
  });

  it('does not let a success wipe the address bucket', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    /*
     * Twenty-nine wrong passwords from one host, then one right one. That sequence *is* a
     * successful credential-stuffing run, and clearing the address bucket on success would
     * make the address limit unreachable for the only attacker it exists to catch.
     */
    for (let attempt = 0; attempt < 29; attempt += 1) {
      throttle.failed(`user${String(attempt)}@example.test`, ADDRESS);
    }
    throttle.succeeded('user0@example.test', ADDRESS);
    throttle.failed('user29@example.test', ADDRESS);

    expect(throttle.check('user30@example.test', ADDRESS)?.scope).toBe('address');
  });

  it('refuses the sixth *failure* against one account, whatever address it comes from', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(throttle.check(ACCOUNT, `198.51.100.${String(attempt)}`)).toBeUndefined();
      throttle.failed(ACCOUNT, `198.51.100.${String(attempt)}`);
    }

    /*
     * Five distinct addresses, so the per-address counter is nowhere near its limit. Without
     * a per-account bucket, a botnet spreads one account's guesses across a thousand hosts
     * and never trips anything — which is what a per-IP-only limiter actually buys an
     * attacker: the appearance of a defence.
     */
    const refusal = throttle.check(ACCOUNT, '198.51.100.99');
    expect(refusal?.scope).toBe('account');
    expect(refusal?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('lets the account back in when the window passes', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let attempt = 0; attempt < 5; attempt += 1) throttle.failed(ACCOUNT, ADDRESS);
    expect(throttle.check(ACCOUNT, ADDRESS)).toBeDefined();

    time.advance(15 * 60_000 + 1);

    // Not a lockout. An account that could be put beyond its owner's reach by someone else
    // typing at it is a denial-of-service dressed as a security control, and the only exit
    // from a real lockout would be an admin surface that does not exist.
    expect(throttle.check(ACCOUNT, ADDRESS)).toBeUndefined();
  });

  it('counts an account by identity and not by spelling', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    /*
     * `Somchai@Example.TEST` and `somchai@example.test` are one account —
     * `user_emails_address_lowercase` is a CHECK, so the database has already decided this.
     * A limiter that keyed on the raw string would give an attacker a fresh bucket per
     * capitalisation, which is 2^n buckets for an n-letter address.
     */
    for (const spelling of ['somchai@example.test', 'Somchai@Example.TEST', 'SOMCHAI@EXAMPLE.TEST']) {
      throttle.failed(spelling, ADDRESS);
      throttle.failed(spelling, ADDRESS);
    }

    expect(throttle.check('somchai@example.test', ADDRESS)?.scope).toBe('account');
  });
});

describe('one address may not spray many accounts', () => {
  it('refuses the thirty-first failure from one address, across different accounts', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    // Each account sees three failures — well under the per-account limit of five — so only
    // the address bucket can catch this. It is the credential-stuffing shape: one list of
    // leaked passwords, one victim each.
    for (let account = 0; account < 10; account += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        throttle.failed(`user${String(account)}@example.test`, ADDRESS);
      }
    }

    expect(throttle.check('user0@example.test', ADDRESS)?.scope).toBe('address');
    expect(throttle.check('nobody@example.test', ADDRESS)?.scope).toBe('address');
  });

  it('does not punish a second address for the first one’s failures', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      throttle.failed(`user${String(attempt)}@example.test`, ADDRESS);
    }

    expect(throttle.check('someone@example.test', ADDRESS)).toBeDefined();
    // A shared office NAT is one address for a hundred people; a colleague's bad afternoon
    // must not be the reason the next person cannot sign in from home.
    expect(throttle.check('someone@example.test', '198.51.100.200')).toBeUndefined();
  });
});

describe('which refusal is reported when both apply', () => {
  it('reports the account, because that is the one the caller can wait out', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let account = 0; account < 10; account += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        throttle.failed(`user${String(account)}@example.test`, ADDRESS);
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.failed(ACCOUNT, ADDRESS);

    // Both buckets are over. Reporting the narrower one is the more useful answer and the
    // less informative one — "this account is busy" tells a stuffer nothing about how close
    // their address is to being cut off.
    expect(throttle.check(ACCOUNT, ADDRESS)?.scope).toBe('account');
  });
});

describe('what the limiter must not become', () => {
  it('does not grow a bucket for every address ever seen', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let host = 0; host < 500; host += 1) throttle.failed(ACCOUNT, `10.0.0.${String(host % 256)}`);
    expect(throttle.size).toBeGreaterThan(0);

    time.advance(15 * 60_000 + 1);
    // One live request is enough to collect what expired. Without this the map is an
    // attacker-controlled allocation: one bucket per source address, kept for ever.
    throttle.failed('someone@example.test', '198.51.100.1');

    expect(throttle.size).toBeLessThan(5);
  });

  it('reports a retry-after that shrinks as the window empties', () => {
    const time = clock();
    const throttle = throttleAt(time.now);

    for (let attempt = 0; attempt < 5; attempt += 1) throttle.failed(ACCOUNT, ADDRESS);
    const first = throttle.check(ACCOUNT, ADDRESS)?.retryAfterSeconds ?? 0;

    time.advance(10 * 60_000);
    const later = throttle.check(ACCOUNT, ADDRESS)?.retryAfterSeconds ?? 0;

    // A `Retry-After` that always says the full window teaches clients to ignore it.
    expect(first).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
  });
});
