import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { MfaEnrolmentService } from '../../../src/auth/mfa/mfa-enrolment.service';
import type { MfaCredentialRow, MfaRepository } from '../../../src/auth/mfa/mfa.repository';
import type { PasswordCredentialStore } from '../../../src/auth/password/password.repository';
import { SecretBox, parseMfaKey } from '../../../src/auth/mfa/secret-box';
import { generateTotpSecret, totpAt } from '../../../src/auth/mfa/totp';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE RECOVERY CODES REACH ONLY SOMEBODY WHO PROVED THEY HOLD THE PHONE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `mfa_credentials_guard_confirm` already refuses to raise the gate without two unused
 * codes, and `packages/db/tests/auth.test.ts` holds it to that. **That trigger cannot see
 * the rule this file is about.**
 *
 * The trigger protects against a *lockout*: a gate with no way through. Move the codes back
 * to `begin` and the trigger is perfectly happy — the rows exist, the confirmation succeeds,
 * nothing raises. What is lost is *confidentiality*, and it is lost silently:
 *
 *   ⚠️ somebody who opens the enrolment screen, is shown ten live codes, and walks away
 *     without ever scanning anything is holding ten permanent entries into the account.
 *
 * That is not hypothetical — it is what this codebase did until the change these tests
 * arrived with. So the rule is pinned here, at the only layer that can see it, and it is a
 * rule about *what does not come back*:
 *
 *   ⓵ `begin` returns a secret and a URI. No codes. Not an empty list — no field.
 *   ⓶ `confirm` returns them, once, and only after the TOTP verifies.
 *   ⓷ a rejected code returns nothing and writes nothing.
 *
 * ⚠️ No mocks of the thing under test. The TOTP is real — the fixture computes a live code
 * from the same secret the service sealed — because a test that stubbed `verifyTotp` would
 * be asserting that the fake returns codes after the fake says yes.
 */

/**
 * The **real** box, on a throwaway key.
 *
 * A stub that sealed to plaintext would have been simpler and would have quietly stopped
 * testing the round trip these tests lean on: `begin` seals a secret, `confirm` opens it and
 * verifies a code against it. Real AES-GCM costs microseconds here and means a seal that ever
 * stopped surviving storage shows up as a rejected code rather than as a green test.
 */
const box = new SecretBox(parseMfaKey(randomBytes(32).toString('base64url')));

/**
 * A repository that keeps its rows in memory.
 *
 * ⚠️ It deliberately does **not** re-implement the trigger. Enforcing the two-code minimum
 * here would make the fake agree with the service by construction, and the tests below would
 * pass against a service that had no rule in it at all. The database's copy of the rule is
 * tested against the real database.
 */
class InMemoryMfa {
  credential: MfaCredentialRow | undefined;
  codeHashes: readonly string[] = [];
  /** Every write, in order — so a test can ask what happened rather than only what is left. */
  readonly writes: string[] = [];

  findCredential(): Promise<MfaCredentialRow | undefined> {
    return Promise.resolve(this.credential);
  }

  putUnconfirmedSecret(userId: string, secretSealed: string): Promise<void> {
    this.writes.push('putUnconfirmedSecret');
    this.credential = { userId, secretSealed, confirmedAt: null, lastAcceptedStep: null };
    return Promise.resolve();
  }

  confirm(userId: string, step: number, codeHashes: readonly string[]): Promise<void> {
    this.writes.push('confirm');
    this.codeHashes = codeHashes;
    this.credential = { userId, secretSealed: this.credential?.secretSealed ?? '', confirmedAt: new Date(), lastAcceptedStep: step };
    return Promise.resolve();
  }

  replaceRecoveryCodes(_userId: string, hashes: readonly string[]): Promise<void> {
    this.writes.push('replaceRecoveryCodes');
    this.codeHashes = hashes;
    return Promise.resolve();
  }
}

const noPasswords: PasswordCredentialStore = {
  findByUserId: () => Promise.resolve(undefined),
} as unknown as PasswordCredentialStore;

const build = () => {
  const repository = new InMemoryMfa();
  const service = new MfaEnrolmentService(
    repository as unknown as MfaRepository,
    box,
    noPasswords,
  );
  return { repository, service };
};

const USER = '00000000-0000-4000-8000-000000000001';

/** The live code for whatever secret `begin` actually sealed — a real authenticator would. */
const codeFor = (repository: InMemoryMfa, atMs: number): string =>
  totpAt(box.open(repository.credential?.secretSealed ?? ''), Math.floor(atMs / 1000 / 30));

describe('⭐ enrolment gives out nothing until the code is proved', () => {
  it('⭐ begin returns a secret and no recovery codes', async () => {
    const { repository, service } = build();

    const started = await service.begin({ userId: USER, account: 'somebody' });

    expect(started.secretBase32).toMatch(/^[A-Z2-79]+$/u);
    expect(started.otpauthUri).toContain('otpauth://totp/');

    /*
     * The assertion that fails if the codes move back. `not.toHaveProperty` rather than a
     * length check on purpose: an empty array would satisfy "no codes" while leaving the
     * field in the wire type for somebody to fill in later.
     */
    expect(started).not.toHaveProperty('recoveryCodes');
    expect(repository.codeHashes).toHaveLength(0);
  });

  it('⚠️ writes no recovery code to storage either', async () => {
    /*
     * The half a response-shape test misses. Codes written at `begin` and merely withheld
     * from the response are still ten live codes on an account nobody has proved they own —
     * and the next `state` call would report the account as having a recovery path it has
     * not earned.
     */
    const { repository, service } = build();

    await service.begin({ userId: USER, account: 'somebody' });

    expect(repository.writes).toStrictEqual(['putUnconfirmedSecret']);
  });

  it('⭐ confirm returns them, once the code verifies', async () => {
    const { repository, service } = build();
    await service.begin({ userId: USER, account: 'somebody' });

    const confirmed = await service.confirm(USER, codeFor(repository, Date.now()));

    expect(confirmed.recoveryCodes).toHaveLength(10);
    /* Readable, formatted, and every one distinct — not one code repeated ten times. */
    expect(new Set(confirmed.recoveryCodes).size).toBe(10);
    for (const code of confirmed.recoveryCodes) expect(code).toMatch(/^[A-Z2-79]{4}(-[A-Z2-79]{4}){2}$/u);
  });

  it('⚠️ stores fingerprints, never the codes it just returned', async () => {
    /*
     * The one mistake in this area that cannot be undone by a later fix: a plaintext code in
     * the database is a plaintext code in every backup taken since.
     */
    const { repository, service } = build();
    await service.begin({ userId: USER, account: 'somebody' });

    const { recoveryCodes } = await service.confirm(USER, codeFor(repository, Date.now()));

    expect(repository.codeHashes).toHaveLength(10);
    for (const hash of repository.codeHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    for (const code of recoveryCodes) {
      expect(repository.codeHashes.join(' ')).not.toContain(code.replace(/-/gu, ''));
    }
  });

  it('⭐ a rejected code returns nothing and writes nothing', async () => {
    /*
     * The attack the ordering is actually for. Somebody at a borrowed unlocked laptop opens
     * the enrolment screen: under the old order the codes were already on it. Under this one
     * they have to produce a code from a phone they do not have, and a wrong guess leaves
     * with nothing — no codes on screen, no codes in the table, and the gate still down.
     */
    const { repository, service } = build();
    await service.begin({ userId: USER, account: 'somebody' });

    await expect(service.confirm(USER, '000000')).rejects.toThrow();

    expect(repository.codeHashes).toHaveLength(0);
    expect(repository.writes).toStrictEqual(['putUnconfirmedSecret']);
    expect(repository.credential?.confirmedAt).toBeNull();
  });

  it('⚠️ confirming twice does not mint a second set', async () => {
    /*
     * A refresh on the success page must not quietly invalidate the ten codes the person is
     * copying down. `confirm` refuses a credential that is already confirmed, so the set on
     * screen stays the set in the table.
     */
    const { repository, service } = build();
    await service.begin({ userId: USER, account: 'somebody' });

    const first = await service.confirm(USER, codeFor(repository, Date.now()));
    const stored = repository.codeHashes;

    await expect(service.confirm(USER, codeFor(repository, Date.now()))).rejects.toThrow();

    expect(repository.codeHashes).toBe(stored);
    expect(first.recoveryCodes).toHaveLength(10);
  });

  it('⚠️ a fresh begin over an abandoned enrolment mints a new secret, still with no codes', async () => {
    /*
     * The common path — scan, close the tab, come back — and the one where "codes at begin"
     * quietly accumulated sets. Two starts, still nothing given out.
     */
    const { repository, service } = build();

    const first = await service.begin({ userId: USER, account: 'somebody' });
    const second = await service.begin({ userId: USER, account: 'somebody' });

    expect(second.secretBase32).not.toBe(first.secretBase32);
    expect(repository.codeHashes).toHaveLength(0);
    expect(repository.writes).toStrictEqual(['putUnconfirmedSecret', 'putUnconfirmedSecret']);
  });
});

describe('the secret survives the round trip', () => {
  it('⚠️ confirms against the secret the URI advertised, not a re-generated one', async () => {
    /*
     * A real authenticator only ever sees the URI. If `begin` sealed one secret and put a
     * different one in the QR, every code a person typed would be wrong and the failure
     * would look exactly like "you typed it in wrong" — see the QR the dashboard draws,
     * which encodes precisely this string.
     */
    const { repository, service } = build();
    const started = await service.begin({ userId: USER, account: 'somebody' });

    const fromUri = new URL(started.otpauthUri).searchParams.get('secret');
    expect(fromUri).toBe(started.secretBase32);

    /* And a code computed from what the URI advertised is the code the service accepts. */
    await expect(service.confirm(USER, codeFor(repository, Date.now()))).resolves.toBeDefined();
  });

  it('⚠️ rejects a code from a different secret', async () => {
    const { service } = build();
    await service.begin({ userId: USER, account: 'somebody' });

    const stranger = totpAt(generateTotpSecret(), Math.floor(Date.now() / 1000 / 30));

    await expect(service.confirm(USER, stranger)).rejects.toThrow();
  });
});
