import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TOTP — RFC 6238, and the one rule the RFC leaves to the caller.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Written out rather than pulled from a package. Two reasons, and the second is the real one:
 *
 *   ⓵ It is forty lines of HMAC and arithmetic with **published test vectors**, so there is
 *     no version of this that is hard to get right or hard to prove right.
 *   ⓶ The interesting decisions are not in the algorithm — they are the drift window, the
 *     replay rule, and what happens on the boundary between them. A dependency makes those
 *     someone else's defaults, silently, and they are the part of TOTP that decides whether
 *     it protects anything.
 *
 * `tests/auth/mfa/totp.test.ts` checks the arithmetic against **RFC 6238 Appendix B** rather
 * than against this file's own output. That matters: writing the counter little-endian, or
 * taking the truncation offset from the wrong nibble, produces codes that are stable,
 * self-consistent, and agree with no authenticator ever made. Only a different
 * implementation's numbers catch that.
 *
 * ── ⭐ THE RULE RFC 6238 DOES NOT MAKE ───────────────────────────────────────
 *
 * The RFC defines when a code is *valid*. It says nothing about using one twice, and §5.2
 * explicitly leaves that to the verifier. A code is good for its 30-second step, and the
 * drift tolerance every real deployment needs widens that to 90 seconds — during which the
 * same six digits work again and again.
 *
 * So `verifyTotp` takes the last step this credential accepted and refuses anything at or
 * below it, which turns "valid for ninety seconds" into "valid once". That is the difference
 * between a second factor and a second factor somebody can read over your shoulder.
 */

/** Six, because that is what every authenticator app shows. */
export const TOTP_DIGITS = 6;

/** Thirty seconds, the RFC's default and what an authenticator assumes when the URI omits it. */
export const TOTP_STEP_SECONDS = 30;

/**
 * ⚠️ One step either side, and no more.
 *
 * Zero tolerance fails for anybody whose phone clock is a few seconds out, which is most
 * phones. Two steps means a code lives for two and a half minutes, and every step of
 * tolerance multiplies what a brute-force attempt is aiming at — with ±1 there are three
 * live codes out of a million at any instant, which is the number the throttle is sized
 * against.
 */
export const TOTP_DRIFT_STEPS = 1;

/** 20 bytes — RFC 4226 §4 R6's recommendation for HMAC-SHA-1, and what Google Authenticator emits. */
const SECRET_BYTES = 20;

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** Which 30-second window an instant falls in. */
export function stepAt(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The code for one step.
 *
 * ⚠️ The counter is **big-endian**, per RFC 4226 §5.2. `writeBigUInt64LE` here would produce
 * a working-looking implementation that no app agrees with — see the test that asserts the
 * two differ, which exists so that this comment is checkable.
 */
export function totpAt(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', secret).update(counter).digest();

  /*
   * Dynamic truncation, RFC 4226 §5.3. The low nibble of the last byte picks the offset, and
   * the high bit of the four bytes read from there is masked off — that mask is not
   * decoration: without it the value is interpreted as signed on some platforms and the
   * modulo goes negative.
   */
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  /*
   * Padded, not stringified. `String(45)` is `"45"`, which matches nothing and happens to
   * about one code in ten thousand — often enough to be reported and rare enough to be
   * written off as the user mistyping.
   */
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpAttempt {
  readonly secret: Buffer;
  /** As typed. Spaces are stripped; anything else is refused without doing the maths. */
  readonly code: string;
  readonly atMs: number;
  /**
   * The highest step this credential has already accepted, or null if it never has.
   *
   * ⭐ This is the replay guard. See the block comment: without it a code lives for up to
   * ninety seconds and works every time inside that window.
   */
  readonly lastAcceptedStep: number | null;
}

export type TotpResult = { readonly ok: true; readonly step: number } | { readonly ok: false };

const SIX_DIGITS = /^\d{6}$/u;

/** Constant-time, so a wrong code cannot be narrowed by how long it took to refuse. */
const sameCode = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii'));

export function verifyTotp(attempt: TotpAttempt): TotpResult {
  /*
   * Whitespace is what an authenticator *shows* — `123 456` — so it is what somebody
   * copying by hand types. Stripping it is not leniency about the format; it is reading the
   * format the user was given.
   */
  const code = attempt.code.replaceAll(/\s/gu, '');
  if (!SIX_DIGITS.test(code)) return { ok: false };

  const current = stepAt(attempt.atMs);

  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    const step = current + drift;

    /*
     * ⚠️ `<=`, not `<`. Refusing only the exact step already used would still admit the
     * *previous* code — arithmetically valid for another half minute, and precisely the
     * window the drift tolerance opened for somebody holding a stale code.
     */
    if (attempt.lastAcceptedStep !== null && step <= attempt.lastAcceptedStep) continue;

    if (sameCode(code, totpAt(attempt.secret, step))) return { ok: true, step };
  }

  return { ok: false };
}

/* ------------------------------------------------------------------ *
 * base32 — because that is the alphabet an authenticator reads
 * ------------------------------------------------------------------ */

/**
 * RFC 4648 §6, and the exclusions are the point: no `0`, `1` or `8`.
 *
 * The string ends up in a QR code and, when the camera fails, in somebody typing it off a
 * screen onto a phone. `O`/`0` and `l`/`1` are the two transcriptions people get wrong, and
 * the alphabet was chosen to make them impossible rather than merely unlikely.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * ⚠️ No `=` padding and upper case only.
 *
 * Both are legal base32 and neither is a maths problem. Several authenticators reject
 * padding outright, and mixed case invites exactly the transcription errors the alphabet
 * above was chosen to prevent — so the difference is enrolment working versus a support call.
 */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/** Reads it back however it was typed: spaced in fours, lower case, either. */
export function base32Decode(text: string): Buffer {
  const clean = text.replaceAll(/\s/gu, '').toUpperCase();
  if (clean === '') throw new TypeError('base32: empty');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new TypeError(`base32: "${character}" is not in the alphabet`);

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * The `otpauth://` URI an authenticator scans.
 *
 * The issuer appears twice on purpose — once as a label prefix and once as a parameter —
 * because apps disagree about which one they read, and one that reads neither shows the
 * account as a bare email with no hint of which system it belongs to.
 */
export function otpauthUri(input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: Buffer;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const parameters = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${parameters.toString()}`;
}
