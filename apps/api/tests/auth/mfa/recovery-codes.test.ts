import { describe, expect, it } from 'vitest';

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
  fingerprint,
  formatRecoveryCode,
  generateRecoveryCodes,
  normaliseRecoveryCode,
} from '../../../src/auth/mfa/recovery-codes';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE HARD PART OF MFA IS RECOVERY, NOT TOTP.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The plan says it in as many words (§6.4): *"ไม่มีทางกู้ = คนทำมือถือหายล็อกตัวเองออกถาวร ·
 * ทางกู้ที่อ่อน = MFA ไม่ได้ป้องกันอะไร"*. Both halves are failure, and they pull in opposite
 * directions — which is why the recovery code is the piece worth the most care and the least
 * cleverness.
 *
 * Three properties, and the third is the one that looks wrong at first glance:
 *
 *   ⓵ **Enough entropy that guessing is not a strategy.** Ten codes live at once, so a guess
 *     has ten targets rather than one; the bound has to account for that.
 *   ⓶ **Single use.** A code that survives its use is a password with extra steps.
 *   ⓷ **Hashed with SHA-256, not argon2** — and that is correct here for a reason that does
 *     *not* apply to passwords. See the test that says so.
 */

describe('what gets handed to a person', () => {
  it('is ten codes', () => {
    // §6.4's agreed number. Few enough to print, many enough to survive losing some.
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(generateRecoveryCodes()).toHaveLength(10);
  });

  it('⚠️ carries enough entropy that ten live targets do not matter', () => {
    /*
     * Ten codes are valid at once, so an attacker guessing has ten chances per attempt — the
     * effective strength is the code's entropy minus log₂(10), about 3.3 bits. At 50 bits
     * that leaves ~47, which is far beyond anything reachable through a throttled endpoint.
     *
     * Asserted as a number rather than trusted as a comment, because the tempting change
     * here is shortening the code to make it easier to type.
     */
    expect(RECOVERY_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(50);
  });

  it('is all distinct', () => {
    const codes = generateRecoveryCodes();

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is drawn from an alphabet a person can copy without ambiguity', () => {
    for (const code of generateRecoveryCodes()) {
      // Same exclusions as the base32 secret: no 0/O, no 1/l, no 8/B confusion.
      expect(normaliseRecoveryCode(code)).toMatch(/^[A-Z2-7]+$/u);
    }
  });

  it('is shown in groups, and read back however it was typed', () => {
    for (const code of generateRecoveryCodes()) {
      const shown = formatRecoveryCode(code);

      expect(shown).toContain('-');
      expect(normaliseRecoveryCode(shown)).toBe(code);
      expect(normaliseRecoveryCode(shown.toLowerCase())).toBe(code);
      expect(normaliseRecoveryCode(` ${shown} `)).toBe(code);
    }
  });
});

describe('⭐ SHA-256, and why that is not the mistake it looks like', () => {
  it('is a fast hash, deliberately', () => {
    /*
     * ⚠️ Everywhere else in this codebase a secret meets argon2id. Here it meets SHA-256, and
     * the difference is not laziness — it is that the two are protecting against different
     * things.
     *
     * argon2 exists because a *password* is drawn from a distribution people can enumerate:
     * a stolen hash is attacked with a dictionary, and the defence is making each guess
     * expensive. A recovery code is 50 bits of `randomBytes`. There is no dictionary, no
     * rainbow table, and no list anybody can build — the attack is brute force over 2⁵⁰, and
     * slowing each guess by 50ms changes an already-impossible number into a slightly larger
     * already-impossible number.
     *
     * What the fast hash buys is real: redemption is **one indexed lookup**
     * (`WHERE user_id = $1 AND code_hash = $2`) instead of ten argon2 verifications. Ten
     * verifications is half a second of CPU per attempt on an endpoint that anonymous
     * callers reach, which is a denial-of-service lever handed over for no security.
     */
    const before = process.hrtime.bigint();
    for (let index = 0; index < 1000; index += 1) fingerprint(`WEWIN-TEST-${String(index)}`);
    const perHashMs = Number(process.hrtime.bigint() - before) / 1e6 / 1000;

    expect(perHashMs, 'a recovery-code hash should be microseconds, not milliseconds').toBeLessThan(
      1,
    );
  });

  it('hashes each code separately, so one redemption reveals nothing about the rest', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map((code) => fingerprint(code));

    expect(new Set(hashes).size).toBe(codes.length);
  });

  it('is stable, and independent of how the code was typed', () => {
    const [code] = generateRecoveryCodes();
    if (code === undefined) throw new Error('no code generated');

    expect(fingerprint(formatRecoveryCode(code).toLowerCase())).toBe(fingerprint(code));
    expect(fingerprint(` ${formatRecoveryCode(code)} `)).toBe(fingerprint(code));
  });

  it('⚠️ produces a different hash for a different code, including a near miss', () => {
    /*
     * A near miss is the case worth naming: somebody typing a code wrong by one character
     * must not land on another live code's hash. That is what a 256-bit digest over a
     * 50-bit input space guarantees, and asserting it here is cheap.
     */
    expect(fingerprint('AAAA2AAA2AAA')).not.toBe(fingerprint('AAAA2AAA2AAB'));
  });
});
