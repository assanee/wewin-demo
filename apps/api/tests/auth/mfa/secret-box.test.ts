import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBox, parseMfaKey } from '../../../src/auth/mfa/secret-box';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The TOTP secret, encrypted at rest.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The threat is narrow and ordinary: **a database dump that leaves without the application's
 * environment.** A backup on a laptop, a restored snapshot in a staging cluster, a `pg_dump`
 * in a support ticket. A plaintext TOTP secret in any of those is every enrolled person's
 * second factor, forever, silently — nothing about the account changes and nobody finds out.
 *
 * It is *not* protection against an attacker who has the running process. Somebody with the
 * env has the key, and there is no arrangement short of an HSM where that is untrue. Saying
 * so plainly matters, because encryption-at-rest is the security control most often assumed
 * to do more than it does.
 *
 * ── Why AEAD and not "just encrypt it" ───────────────────────────────────────
 *
 * AES-256-**GCM**, so the ciphertext carries a tag that fails loudly when the bytes change.
 * Without authentication, somebody with write access to the row could flip bits and the
 * decrypt would succeed into a *different secret* — quietly turning off a person's second
 * factor rather than breaking anything visible.
 */

const key = parseMfaKey(randomBytes(32).toString('base64url'));

describe('round trip', () => {
  it('gives back exactly what went in', () => {
    const box = new SecretBox(key);
    const secret = randomBytes(20);

    expect(box.open(box.seal(secret)).equals(secret)).toBe(true);
  });

  it('⚠️ produces different ciphertext each time for the same secret', () => {
    /*
     * A fresh nonce per seal. Reusing one under GCM is not a degradation — it is
     * catastrophic: two ciphertexts under the same key and nonce leak their XOR, and the
     * authentication key itself becomes recoverable. A deterministic box would also let
     * anybody with the table see which two accounts share a secret.
     */
    const box = new SecretBox(key);
    const secret = randomBytes(20);

    expect(box.seal(secret)).not.toBe(box.seal(secret));
  });

  it('is a printable string, so the column can be text', () => {
    expect(new SecretBox(key).seal(randomBytes(20))).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
  });
});

describe('⭐ the tag is what makes it safe to store', () => {
  it('refuses a ciphertext whose bytes were changed', () => {
    /*
     * The failure this rules out is quiet. Without the tag, flipping a bit decrypts to a
     * *different valid secret* — the person's authenticator simply stops matching, their
     * account is locked behind a factor nobody holds, and there is nothing in the row that
     * looks wrong.
     */
    const box = new SecretBox(key);
    const sealed = box.seal(randomBytes(20));

    const bytes = Buffer.from(sealed.slice('v1.'.length), 'base64url');
    const last = bytes.length - 1;
    /* `writeUInt8` rather than `bytes[last] ^= 1`: indexed access is `number | undefined`. */
    bytes.writeUInt8((bytes.readUInt8(last) ^ 0x01) & 0xff, last);
    const tampered = `v1.${bytes.toString('base64url')}`;

    expect(() => box.open(tampered)).toThrow();
  });

  it('refuses a ciphertext sealed under a different key', () => {
    const sealed = new SecretBox(key).seal(randomBytes(20));
    const other = new SecretBox(parseMfaKey(randomBytes(32).toString('base64url')));

    expect(() => other.open(sealed)).toThrow();
  });

  it('refuses anything that is not a sealed value at all', () => {
    const box = new SecretBox(key);

    for (const text of ['', 'v1.', 'nonsense', 'v2.abc', Buffer.alloc(4).toString('base64url')]) {
      expect(() => box.open(text), `"${text}" was opened`).toThrow();
    }
  });
});

describe('⚠️ the key itself', () => {
  it('refuses a key that is not 32 bytes', () => {
    /*
     * AES-256 wants exactly 32. A short key is not "weaker encryption" — `createCipheriv`
     * throws at the point of use, which would be the first enrolment on a freshly deployed
     * environment rather than at boot. Checking it while parsing config turns a runtime 500
     * into a start-up refusal with the variable named.
     */
    for (const bad of ['', 'short', randomBytes(16).toString('base64url'), randomBytes(31).toString('base64url')]) {
      expect(() => parseMfaKey(bad), `${bad.length} chars was accepted`).toThrow();
    }
  });

  it('takes a 32-byte key as base64url', () => {
    expect(() => parseMfaKey(randomBytes(32).toString('base64url'))).not.toThrow();
  });

  it('⚠️ refuses a key that is all one byte', () => {
    /*
     * The shape of a placeholder somebody typed to get past a start-up error —
     * `AAAAAAAA...` decodes to 32 zero bytes and is a perfectly valid AES key, which is why
     * nothing downstream would complain. Refusing it at parse is the only place the mistake
     * is visible.
     */
    expect(() => parseMfaKey(Buffer.alloc(32).toString('base64url'))).toThrow();
  });
});
