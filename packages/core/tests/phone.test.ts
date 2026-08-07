import { describe, expect, it } from 'vitest';

import { normalisePhone, phoneProblem } from '../src/phone.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE NUMBER, ONE SPELLING — OR THE UNIQUE INDEX IS DECORATION.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A phone number is about to become a **username**, and `user_phones` will carry the same
 * partial unique index `user_emails` does: at most one verified owner per number.
 *
 * ⚠️ That index compares bytes. `081-234-5678`, `0812345678`, `+66 81 234 5678` and
 * `066812345678` are one telephone and four different byte strings, so without a canonical
 * form the index sees four numbers, four accounts hold "the same" number, and the sign-in
 * lookup that was supposed to be unambiguous returns whichever row the planner reached first.
 *
 * This is the same argument `user_emails_address_nfc` makes about `å` written two ways, and
 * it is why the normalisation lives in `@wewin/core`: the storefront, the dashboard and the
 * API must all produce the identical string, and a second implementation is a second answer.
 *
 * ── Thailand only, and it says so ────────────────────────────────────────────
 *
 * A general E.164 library is a dependency and a lot of rules for a company that installs
 * aluminium windows in Phitsanulok. What is supported is Thai numbers, written the several
 * ways Thai people write them, plus already-canonical international ones passed through. An
 * unrecognised shape is a **refusal**, not a guess — a mangled number stored as an identity
 * is an account nobody can reach.
 */

describe('⭐ the several ways a Thai number is written are one number', () => {
  it.each([
    ['national, plain', '0812345678'],
    ['national, hyphens', '081-234-5678'],
    ['national, spaces', '081 234 5678'],
    ['national, mixed', '081-234 5678'],
    ['international, plus', '+66812345678'],
    ['international, spaced', '+66 81 234 5678'],
    ['international, hyphens', '+66-81-234-5678'],
    ['international, 00 prefix', '0066812345678'],
    ['international, no plus', '66812345678'],
    ['parenthesised trunk', '(081) 234-5678'],
  ])('%s → +66812345678', (_name, written) => {
    expect(normalisePhone(written)).toBe('+66812345678');
  });

  it('⚠️ drops the trunk zero exactly once', () => {
    /*
     * The mistake worth a test of its own. `0` + `81…` national becomes `+66` + `81…`, and a
     * naive "strip leading zeros then prefix" turns `+66081…` into a number one digit too
     * long that no index will ever match against the same person's other spelling.
     */
    expect(normalisePhone('081234 5678')).toBe('+66812345678');
    expect(normalisePhone('+66081234 5678')).toBeNull();
  });

  it('keeps a landline', () => {
    /* Phitsanulok is 055. A company customer gives an office number and it must survive. */
    expect(normalisePhone('055-123-456')).toBe('+6655123456');
  });

  it('⭐ is idempotent — normalising a canonical number changes nothing', () => {
    /*
     * Load-bearing rather than tidy. This value is written to a column with a CHECK that it
     * equals its own normalisation; a function that moved on the second pass would make rows
     * that cannot be re-saved.
     */
    const once = normalisePhone('081-234-5678');
    expect(once).not.toBeNull();
    expect(normalisePhone(once ?? '')).toBe(once);
  });
});

describe('⚠️ an unrecognised shape is refused, never guessed', () => {
  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['too short', '08123'],
    ['too long', '08123456789012'],
    ['letters', '081-ABC-5678'],
    ['a Thai mobile missing a digit', '081234567'],
    ['an extension', '055-123-456 ต่อ 12'],
    ['two numbers', '0812345678, 0898765432'],
    ['an email', 'somchai@wewin.co.th'],
  ])('refuses %s', (_name, written) => {
    expect(normalisePhone(written)).toBeNull();
  });

  it('⭐ refuses rather than truncating a number it half-understands', () => {
    /*
     * The failure this protects against is silent. `0812345678 ต่อ 12` normalised to
     * `+66812345678` would look right, be stored as an identity, and belong to a switchboard
     * rather than to the person who typed it.
     */
    expect(normalisePhone('0812345678 ต่อ 12')).toBeNull();
  });
});

describe('an already-international number from somewhere else', () => {
  it('passes a canonical foreign number through', () => {
    /* "จัดส่งและติดตั้งทั้งภายในประเทศและต่างประเทศ" is on the site's own footer. */
    expect(normalisePhone('+65 6123 4567')).toBe('+6561234567');
    expect(normalisePhone('+1 415 555 0132')).toBe('+14155550132');
  });

  it('⭐ refuses letters in a foreign number, which length alone would let through', () => {
    /*
     * The gap a mutation found. The foreign branch can only check length honestly — this
     * build knows no dialling plan but Thailand's — so `+ABCDEFGH` is eight characters and
     * would pass a length test. Only the digits-only check in front of it refuses.
     *
     * Worth its own test because the Thai branch hides the problem: a Thai number with
     * letters in it is caught by the subscriber pattern, so every obvious case passes while
     * the foreign path stays open.
     */
    expect(normalisePhone('+ABCDEFGH')).toBeNull();
    expect(normalisePhone('+65 6123 456X')).toBeNull();
  });

  it('⚠️ refuses a bare foreign number with no country code', () => {
    /*
     * `6123 4567` is a Singapore number to a person and an unparseable fragment to a
     * database. Guessing a country from the site's own address is how a customer's number
     * silently becomes somebody else's.
     */
    expect(normalisePhone('6123 4567')).toBeNull();
  });
});

describe('phoneProblem names why, for a form', () => {
  /*
   * `normalisePhone` answers a `string | null` because callers store the string. A form has
   * to tell somebody *what* to change, and "เบอร์ไม่ถูกต้อง" on a number that is merely
   * missing its country code is a dead end.
   */
  it('says nothing about a number it accepts', () => {
    expect(phoneProblem('081-234-5678')).toBeNull();
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['081-ABC-5678', 'not-a-number'],
    ['08123', 'unrecognised'],
    ['6123 4567', 'unrecognised'],
  ])('%s → %s', (written, expected) => {
    expect(phoneProblem(written)).toBe(expected);
  });
});
