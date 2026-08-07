import { describe, expect, it } from 'vitest';

import {
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  stepAt,
  totpAt,
  verifyTotp,
} from '../../../src/auth/mfa/totp';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TOTP, checked against the RFC's own numbers.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⭐ Every expected value in the first block is copied from **RFC 6238 Appendix B**, not
 * computed by this codebase. That distinction is the whole point of the file: an
 * implementation tested against its own output is a test that the code does what it does,
 * and would pass just as happily with the counter bytes reversed or the dynamic-truncation
 * offset taken from the wrong nibble. Those two bugs produce codes that look like codes,
 * are stable, are self-consistent — and that no authenticator app on earth agrees with.
 *
 * The published vectors are the only thing that catches them, because they were produced by
 * a different implementation.
 *
 * ── The bit the RFC does not test, and that matters more ─────────────────────
 *
 * A code stays valid for 30 seconds, and drift tolerance widens that to 90. Somebody who
 * reads a code over a shoulder therefore has a minute and a half — unless the code stops
 * working the instant it is used once. `verifyTotp` takes the last accepted step and
 * refuses anything at or below it, which is what turns "valid for 90 seconds" into "valid
 * once".
 */

/** RFC 6238 Appendix B: the SHA-1 seed is the ASCII "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('⭐ RFC 6238 Appendix B, verbatim', () => {
  /*
   * Time, code — straight out of the RFC's table, SHA-1 column, 8 digits. Eight rather than
   * six because that is what the RFC publishes; `TOTP_DIGITS` is six and the truncation is
   * the same operation, so testing at 8 exercises the arithmetic the published numbers can
   * actually check.
   */
  const VECTORS = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ] as const;

  it.each(VECTORS)('at t=%i the code is %s', (seconds, expected) => {
    expect(totpAt(RFC_SECRET, stepAt(seconds * 1000), 8)).toBe(expected);
  });

  it('⚠️ would not survive the counter being written little-endian', () => {
    /*
     * Stated as a test rather than as a comment, because it is the specific mistake the
     * vectors exist to catch: HOTP counts in a **big-endian** 8-byte counter, and a
     * `writeBigUInt64LE` produces a perfectly stable wrong answer. If this ever passes, the
     * vectors above are being generated rather than checked.
     */
    const backwards = Buffer.alloc(8);
    backwards.writeBigUInt64LE(BigInt(stepAt(59_000)));

    expect(totpAt(RFC_SECRET, stepAt(59_000), 8)).not.toBe(
      totpAt(RFC_SECRET, Number(backwards.readBigUInt64BE()), 8),
    );
  });
});

describe('the shape of what we issue', () => {
  it('is six digits, on a thirty-second step', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(totpAt(RFC_SECRET, stepAt(59_000))).toMatch(/^\d{6}$/u);
  });

  it('keeps a leading zero rather than dropping it', () => {
    /*
     * The truncation produces a *number* and the code is a *string*: `String(45)` on a
     * six-digit code is `"45"`, which no authenticator will ever match and which fails on
     * roughly one attempt in ten thousand — often enough to be reported, rarely enough to be
     * dismissed as user error. Padding is the fix; this searches for a step that exercises it.
     */
    let padded = 0;

    for (let step = 0; step < 20_000 && padded < 3; step += 1) {
      const code = totpAt(RFC_SECRET, step);
      expect(code).toHaveLength(6);
      if (code.startsWith('0')) padded += 1;
    }

    expect(padded, 'no zero-leading code found in 20,000 steps — the search is wrong').toBe(3);
  });
});

describe('base32, because that is what an authenticator reads', () => {
  it('round-trips a generated secret', () => {
    const secret = generateTotpSecret();

    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('⚠️ produces no padding and no lower case', () => {
    /*
     * The string goes into a QR code and, when that fails, into somebody typing it on a
     * phone. `=` padding is legal base32 and several authenticators reject it; mixed case is
     * legal and invites transcription errors between `l` and `1`. Neither is a correctness
     * bug in the maths, and both are the difference between enrolment working and a support
     * call.
     */
    const encoded = base32Encode(generateTotpSecret());

    expect(encoded).not.toContain('=');
    expect(encoded).toBe(encoded.toUpperCase());
    expect(encoded).toMatch(/^[A-Z2-7]+$/u);
  });

  it('reads a secret back however somebody typed it', () => {
    const secret = generateTotpSecret();
    const encoded = base32Encode(secret);

    // Spaces every four characters is how the string is *shown*, so it is how it comes back.
    const spaced = (encoded.match(/.{1,4}/gu) ?? []).join(' ');

    expect(base32Decode(spaced).equals(secret)).toBe(true);
    expect(base32Decode(encoded.toLowerCase()).equals(secret)).toBe(true);
  });

  it('refuses a string that is not base32 at all', () => {
    expect(() => base32Decode('not-base32!')).toThrow();
    // `0`, `1` and `8` are excluded from the alphabet precisely because they are misread.
    expect(() => base32Decode('AAAA0AAA')).toThrow();
  });

  it('generates 20 bytes — the RFC’s SHA-1 recommendation', () => {
    expect(generateTotpSecret()).toHaveLength(20);
    expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
  });
});

describe('⭐ verification, and the two ways it must refuse', () => {
  const now = 1_700_000_000_000;
  const step = stepAt(now);

  it('accepts the code for the current step', () => {
    const code = totpAt(RFC_SECRET, step);

    expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now, lastAcceptedStep: null })).toStrictEqual({
      ok: true,
      step,
    });
  });

  it('accepts one step either side, for a phone with a slow clock', () => {
    for (const drift of [-1, 1]) {
      const code = totpAt(RFC_SECRET, step + drift);

      expect(
        verifyTotp({ secret: RFC_SECRET, code, atMs: now, lastAcceptedStep: null }),
        `drift of ${drift} steps was refused`,
      ).toStrictEqual({ ok: true, step: step + drift });
    }
  });

  it('refuses two steps out', () => {
    for (const drift of [-2, 2]) {
      const code = totpAt(RFC_SECRET, step + drift);

      expect(verifyTotp({ secret: RFC_SECRET, code, atMs: now, lastAcceptedStep: null }).ok).toBe(
        false,
      );
    }
  });

  it('⭐ refuses a code that has already been used', () => {
    /*
     * The replay guard, and the reason `verifyTotp` returns the step it matched rather than
     * a bare boolean: the caller stores it, and the next attempt has to beat it.
     *
     * Without this, a code read over a shoulder is good for the rest of its 30-second step
     * plus the drift window on either side — up to 90 seconds, which is ample.
     */
    const code = totpAt(RFC_SECRET, step);
    const first = verifyTotp({ secret: RFC_SECRET, code, atMs: now, lastAcceptedStep: null });

    expect(first).toStrictEqual({ ok: true, step });

    const again = verifyTotp({
      secret: RFC_SECRET,
      code,
      atMs: now,
      lastAcceptedStep: first.ok ? first.step : null,
    });

    expect(again.ok, 'the same code worked twice').toBe(false);
  });

  it('⚠️ refuses an *earlier* code even when it is inside the drift window', () => {
    /*
     * The sharper half of the same rule. Having accepted step N, the code for N−1 is still
     * arithmetically valid for another half minute — and accepting it would let an attacker
     * holding a slightly stale code in after the legitimate sign-in, which is exactly the
     * window the drift tolerance opened.
     */
    const previous = totpAt(RFC_SECRET, step - 1);

    expect(
      verifyTotp({ secret: RFC_SECRET, code: previous, atMs: now, lastAcceptedStep: step }).ok,
    ).toBe(false);
  });

  it('lets the next step through once it arrives', () => {
    const next = totpAt(RFC_SECRET, step + 1);

    expect(
      verifyTotp({ secret: RFC_SECRET, code: next, atMs: now, lastAcceptedStep: step }),
    ).toStrictEqual({ ok: true, step: step + 1 });
  });

  it('refuses anything that is not six digits, without doing the maths', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56', '๑๒๓๔๕๖']) {
      expect(
        verifyTotp({ secret: RFC_SECRET, code, atMs: now, lastAcceptedStep: null }).ok,
        `"${code}" was accepted`,
      ).toBe(false);
    }
  });

  it('tolerates the spaces an authenticator puts in the middle', () => {
    const code = totpAt(RFC_SECRET, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp({ secret: RFC_SECRET, code: spaced, atMs: now, lastAcceptedStep: null }).ok).toBe(
      true,
    );
  });
});
