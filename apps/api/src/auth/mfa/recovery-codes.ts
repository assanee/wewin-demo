import { createHash, randomInt } from 'node:crypto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ RECOVERY CODES — the hard half of MFA.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Plan §6.4, verbatim: *"ไม่มีทางกู้ = คนทำมือถือหายล็อกตัวเองออกถาวร · ทางกู้ที่อ่อน = MFA
 * ไม่ได้ป้องกันอะไร"*. Both are failures and they pull opposite ways, which is why this file
 * is longer in prose than in code.
 *
 * ── ⚠️ SHA-256, and why that is not the mistake it looks like ────────────────
 *
 * Every other secret in this codebase meets argon2id. This one meets SHA-256, and the
 * difference is that the two hashes defend against different attacks.
 *
 * argon2 exists because a **password** comes from a distribution people can enumerate: a
 * stolen hash is attacked with a dictionary, and the defence is making each guess expensive.
 * A recovery code is 60 bits out of `randomInt`. There is no dictionary, no rainbow table
 * and no list anybody can build — the attack is brute force over 2⁶⁰, and slowing each guess
 * by 50ms turns an impossible number into a slightly larger impossible number.
 *
 * What the fast hash buys is not theoretical. Redemption becomes **one indexed lookup** —
 * `WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL` — rather than ten argon2
 * verifications per attempt. Ten verifications is roughly half a second of CPU on an
 * endpoint an unauthenticated caller can reach in a loop, which is a denial-of-service lever
 * handed over in exchange for nothing.
 *
 * ── The other three properties ───────────────────────────────────────────────
 *
 *   **Single use.** Enforced by `used_at` and a partial unique index, not by this file.
 *   **Ten live at once**, so a guess has ten targets — accounted for in the entropy below.
 *   **An alphabet nobody mistranscribes**, because these get printed and typed by hand.
 */

/** §6.4's agreed number: few enough to print on one line, many enough to survive losing some. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * RFC 4648 base32 minus `0`, `1` and `8`.
 *
 * Same exclusions as the TOTP secret and for the same reason: this string is printed, put in
 * a wallet, and typed back a year later by somebody who is already locked out and not in a
 * patient mood. `O`/`0` and `l`/`1` are the transcriptions people get wrong.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Twelve characters of a 32-symbol alphabet. */
const CODE_LENGTH = 12;

/**
 * ⚠️ The number the length is chosen against, stated so a shorter code has to argue with it.
 *
 * 12 × log₂(32) = 60 bits. Ten codes live at once, so an attacker guessing has ten targets
 * and the effective strength is 60 − log₂(10) ≈ 56.7 bits. Against a throttled endpoint that
 * is unreachable by a wide margin, which is the point: the temptation with recovery codes is
 * always to shorten them so they are easier to type.
 */
export const RECOVERY_CODE_ENTROPY_BITS = Math.floor(CODE_LENGTH * Math.log2(ALPHABET.length));

/**
 * `randomInt`, not `randomBytes` with a modulo.
 *
 * 256 is not a multiple of 32 — well, it is, so a modulo would in fact be uniform here. It
 * stops being uniform the moment somebody changes the alphabet, and a bias in a recovery
 * code is invisible in every test that does not measure the distribution. `randomInt`
 * rejects out-of-range samples internally and stays correct through that edit.
 */
const character = (): string => ALPHABET[randomInt(ALPHABET.length)] ?? 'A';

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): readonly string[] {
  const codes = new Set<string>();

  /*
   * A `Set`, and a loop rather than a map: two identical codes out of 2⁶⁰ is not going to
   * happen, and a duplicate would silently hand somebody nine codes while the screen said
   * ten. Cheap to make impossible.
   */
  while (codes.size < count) {
    codes.add(Array.from({ length: CODE_LENGTH }, character).join(''));
  }

  return [...codes];
}

/** `AAAA-2BBB-3CCC` — grouped for reading aloud and for copying without losing your place. */
export function formatRecoveryCode(code: string): string {
  return (normaliseRecoveryCode(code).match(/.{1,4}/gu) ?? []).join('-');
}

/**
 * However it was typed, back to what was generated.
 *
 * Hyphens are how it was *shown*, so they are how it comes back; case is a keyboard state
 * nobody checks. Stripping both is not leniency about the format — it is reading the format
 * the person was handed.
 */
export function normaliseRecoveryCode(code: string): string {
  return code.replaceAll(/[\s-]/gu, '').toUpperCase();
}

/**
 * What goes in the database. Normalised first, so how it was typed cannot change the lookup.
 *
 * Unsalted, deliberately. A salt defends against precomputation across many stored secrets,
 * and there is nothing to precompute over a 60-bit random space — while a per-row salt would
 * make redemption a scan of ten rows instead of one indexed hit, which is exactly the cost
 * this design is avoiding.
 */
export function fingerprint(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code), 'utf8').digest('hex');
}
