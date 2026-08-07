import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PARAMETERS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../../src/auth/password/password-hash';

/**
 * The argon2id wrapper, on its own.
 *
 * Separated from the sign-in path because these are the properties that have nothing to do
 * with HTTP: what the encoding looks like, that two hashes of one password differ, and —
 * the one worth the most — that verifying a *wrong* password costs the same as verifying a
 * right one. A test that had to boot Nest to say any of that would say it more slowly and
 * no more clearly.
 */

const PASSWORD = 'ลมพัดผ่านหน้าต่างบานกระทุ้ง 2569';

describe('the encoding is the one the database will accept', () => {
  it('produces a PHC string that satisfies password_credentials_argon2id', async () => {
    const hash = await hashPassword(PASSWORD);

    /*
     * The CHECK in `packages/db/src/schema/auth.ts` is `like '$argon2id$%'`, so this is the
     * same assertion the database makes, made here where the failure names the cause. A
     * library upgrade that switched the default variant to argon2i would otherwise surface
     * as a constraint violation on somebody's first password change.
     */
    expect(hash.startsWith('$argon2id$')).toBe(true);

    // The parameters travel inside the string, which is the whole reason the column is one
    // `text` and not four. Raising the cost next year must not be a migration.
    expect(hash).toContain(`m=${String(ARGON2ID_PARAMETERS.memoryCost)}`);
    expect(hash).toContain(`t=${String(ARGON2ID_PARAMETERS.timeCost)}`);
    expect(hash).toContain(`p=${String(ARGON2ID_PARAMETERS.parallelism)}`);
  });

  it('salts, so the same password twice is two different hashes', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    // Without this, a database read tells an attacker which accounts share a password —
    // and the most-shared password in any dump is the one worth trying everywhere.
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });

  it('accepts the password and refuses everything near it', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, `${PASSWORD} `)).toBe(false);
    expect(await verifyPassword(hash, PASSWORD.slice(0, -1))).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('is case-sensitive where case exists', async () => {
    /*
     * A separate test with a Latin passphrase, and the reason is worth writing down: this
     * assertion was first made against the Thai `PASSWORD` above, where `toUpperCase()`
     * returns *the same string* — Thai has no case — so it asserted that a password matches
     * itself and would have passed against an implementation that lower-cased its input.
     */
    const latin = 'Correct Horse Battery Staple';
    expect(latin.toUpperCase()).not.toBe(latin);

    const hash = await hashPassword(latin);
    expect(await verifyPassword(hash, latin)).toBe(true);
    expect(await verifyPassword(hash, latin.toUpperCase())).toBe(false);
    expect(await verifyPassword(hash, latin.toLowerCase())).toBe(false);
  });

  it('survives bytes that a naive implementation would truncate or mangle', async () => {
    // bcrypt silently truncates at 72 bytes and stops at the first NUL. Neither is a
    // theoretical concern for a Thai passphrase: these characters are three bytes each, so
    // a 30-character phrase is already 90 bytes and would lose its last third.
    const long = 'หน้าต่างอะลูมิเนียมสั่งทำตามขนาดจริงของบ้านเรา๒๕๖๙';
    expect(Buffer.byteLength(long, 'utf8')).toBeGreaterThan(72);

    const hash = await hashPassword(long);
    expect(await verifyPassword(hash, long)).toBe(true);
    // The first 72 bytes, which is what a truncating implementation would have stored.
    expect(await verifyPassword(hash, Buffer.from(long, 'utf8').subarray(0, 72).toString('utf8'))).toBe(
      false,
    );
  });
});

describe('a hash that is not a hash', () => {
  it('answers false rather than throwing, for every shape of rubbish', async () => {
    /*
     * ⚠️ This is the branch that decides what a corrupted row does. Throwing would turn a
     * single bad row into a 500 — which is an oracle: an attacker who can tell "no such
     * account" (false) from "something broke" (500) has learned that the account exists and
     * that its credential is unusual. Every one of these is a refusal.
     */
    for (const rubbish of ['', 'not a hash', '$argon2id$', '$2b$10$abcdefghijklmnopqrstuv', '$argon2id$v=19$m=1']) {
      expect(await verifyPassword(rubbish, PASSWORD), rubbish).toBe(false);
    }
  });
});

describe('raising the cost is a re-hash on next sign-in', () => {
  it('asks for a re-hash when the stored parameters are weaker than today’s', async () => {
    const weak = await hashPassword(PASSWORD, { ...ARGON2ID_PARAMETERS, timeCost: 1 });

    expect(await verifyPassword(weak, PASSWORD)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('asks for a re-hash on memory too, not only on time', async () => {
    // Memory is the parameter that matters against a GPU, and it is the one an "upgrade"
    // written against `t=` alone would leave behind.
    const cheap = await hashPassword(PASSWORD, {
      ...ARGON2ID_PARAMETERS,
      memoryCost: ARGON2ID_PARAMETERS.memoryCost / 2,
    });

    expect(needsRehash(cheap)).toBe(true);
  });

  it('does not ask for a re-hash of something stronger than today’s', async () => {
    // A hash written by a *newer* deployment must not be downgraded by an older one still
    // running beside it. This is the rolling-deploy case, and getting it wrong weakens the
    // credential of everybody who signs in during the overlap.
    const stronger = await hashPassword(PASSWORD, {
      ...ARGON2ID_PARAMETERS,
      memoryCost: ARGON2ID_PARAMETERS.memoryCost * 2,
    });

    expect(needsRehash(stronger)).toBe(false);
  });

  it('asks for a re-hash of anything it cannot read, rather than trusting it', async () => {
    // Unparseable means unknown, and unknown parameters must be assumed weak. The row is
    // still usable — `verifyPassword` decides that — this only says it should be replaced.
    expect(needsRehash('$argon2id$v=19$garbage')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('what a wrong password costs', () => {
  /**
   * ⚠️ **This test was rewritten after a mutation proved the first version worthless.**
   *
   * It originally timed one right password against one wrong password of similar length.
   * Adding the exact fast path its own comment forbade — `if (!hash.startsWith('$argon2id'))
   * return false` — left it green, because both candidates went down the same branch. It
   * asserted a property it could not have observed being broken.
   *
   * The mutations that matter are on the **password** side, because that is the input an
   * attacker varies. Each shape below is a cheap exit somebody plausibly writes:
   *
   *     if (password === '') return false;                 // "obviously invalid"
   *     if (password.length > 128) return false;           // "reject absurd input"
   *     if (password.length !== stored.length) …           // the classic
   *
   * All four candidates are measured against **one valid hash**, so any difference between
   * them is a difference this wrapper introduced.
   *
   * What is deliberately *not* asserted: that an unparseable hash costs the same. It cannot
   * — argon2 rejects it before doing any work — and that is a fact about the stored row
   * rather than about the password. Keeping it out of the endpoint's answer is the sign-in
   * service's job, and `password-sign-in.test.ts` is where that is pinned.
   */
  it('spends the same work on every shape of wrong password', async () => {
    const hash = await hashPassword(PASSWORD);

    const time = async (candidate: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await verifyPassword(hash, candidate);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm, so loading the native module is not measured as a difference between branches.
    await time(PASSWORD);

    const samples = [
      ['right', await time(PASSWORD)],
      ['wrong', await time('something else entirely')],
      ['empty', await time('')],
      ['very long', await time('ก'.repeat(4096))],
    ] as const;

    const times = samples.map(([, ms]) => ms);
    const spread = Math.max(...times) / Math.min(...times);

    /*
     * The bound is loose because a runner's scheduler is noisy and a tight one would be a
     * test that fails on Tuesdays. It does not need to be tight: an early return is three
     * orders of magnitude, not a factor of four. Measured here, all four sit within ~10%.
     */
    expect(
      spread,
      samples.map(([name, ms]) => `${name}: ${ms.toFixed(1)}ms`).join(' · '),
    ).toBeLessThan(4);
  });
});
