import { createCipheriv, createDecipheriv, randomBytes, type KeyObject, createSecretKey } from 'node:crypto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The TOTP secret, encrypted at rest.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── ⚠️ What this defends against, and what it does not ───────────────────────
 *
 * **It defends against a database dump that leaves without the application's environment.**
 * A backup on a laptop, a snapshot restored into staging, a `pg_dump` pasted into a support
 * ticket. A plaintext TOTP secret in any of those is every enrolled person's second factor,
 * permanently, and nothing about the account changes to say so.
 *
 * **It does not defend against an attacker who has the running process.** They have the env,
 * so they have the key, and there is no arrangement short of an HSM where that is untrue.
 * Worth stating plainly: encryption-at-rest is the control most often assumed to do more than
 * it does, and a comment that oversells it is how the next person skips the thing that would
 * actually have helped.
 *
 * ── AEAD, not just a cipher ──────────────────────────────────────────────────
 *
 * AES-256-**GCM**. The tag is not a formality: without authentication, somebody with write
 * access to the row can flip bits, and the decrypt succeeds into a *different secret*. The
 * person's authenticator stops matching, their account sits behind a factor nobody holds,
 * and the row looks fine. A failure that loud deserves to throw.
 *
 * ── The `v1.` prefix ─────────────────────────────────────────────────────────
 *
 * Versioned from the first line so that rotating the key, or moving to a different cipher,
 * is a migration that can read both — rather than a flag day where every enrolled account
 * has to re-enrol. Costs three characters now; costs a support incident to add later.
 */

/** AES-256. Exactly 32 bytes, and `parseMfaKey` is where that is checked. */
const KEY_BYTES = 32;

/** 96 bits, the size GCM is specified and optimised for. */
const NONCE_BYTES = 12;

const TAG_BYTES = 16;

const PREFIX = 'v1.';

/**
 * Read the key from configuration.
 *
 * ⚠️ Checked here rather than at first use. A wrong-length key makes `createCipheriv` throw
 * at the moment somebody enrols — which is a 500 on a freshly deployed environment, days
 * after the deploy, with a stack trace that names a crypto call and not a variable. Parsing
 * it at boot turns that into a start-up refusal that says which setting is wrong.
 */
export function parseMfaKey(base64url: string): KeyObject {
  let bytes: Buffer;

  try {
    bytes = Buffer.from(base64url, 'base64url');
  } catch {
    throw new TypeError('AUTH_MFA_SECRET_KEY must be base64url');
  }

  if (bytes.length !== KEY_BYTES) {
    throw new TypeError(
      `AUTH_MFA_SECRET_KEY must decode to exactly ${String(KEY_BYTES)} bytes, got ${String(bytes.length)}`,
    );
  }

  /*
   * ⚠️ The shape of a placeholder somebody typed to get past a start-up error. Thirty-two
   * zero bytes is a perfectly valid AES key, so nothing downstream would ever complain —
   * this is the only place the mistake is visible.
   */
  if (bytes.every((byte) => byte === bytes[0])) {
    throw new TypeError('AUTH_MFA_SECRET_KEY looks like a placeholder — every byte is identical');
  }

  return createSecretKey(bytes);
}

export class SecretBox {
  constructor(private readonly key: KeyObject) {}

  /**
   * ⚠️ A fresh nonce every time.
   *
   * Reusing a nonce under GCM is not a degradation, it is a break: two ciphertexts under one
   * key and nonce leak their XOR, and the authentication subkey becomes recoverable. A
   * deterministic box would also let anybody reading the table see which accounts happen to
   * share a secret.
   */
  seal(plaintext: Buffer): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return `${PREFIX}${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  /** Throws on anything that was not sealed by this key, unmodified. */
  open(sealed: string): Buffer {
    if (!sealed.startsWith(PREFIX)) {
      throw new TypeError('sealed value is not v1');
    }

    const bytes = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
    if (bytes.length <= NONCE_BYTES + TAG_BYTES) {
      throw new TypeError('sealed value is too short to contain a nonce, a tag and a body');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      bytes.subarray(0, NONCE_BYTES),
    );
    decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));

    /* `final()` is what checks the tag — it throws, and that throw is the whole point. */
    return Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
