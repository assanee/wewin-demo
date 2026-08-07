/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ A TELEPHONE NUMBER, IN ONE SPELLING.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A number is about to be a **username**, and `user_phones` carries the partial unique index
 * `user_emails` does: at most one verified owner per number.
 *
 * ⚠️ That index compares bytes. `081-234-5678`, `0812345678`, `+66 81 234 5678` and
 * `066812345678` are one telephone and four byte strings — so without a canonical form the
 * index sees four numbers, four accounts hold "the same" one, and the sign-in lookup that was
 * supposed to be unambiguous returns whichever row the planner reached first.
 *
 * That is the same failure `user_emails_address_nfc` exists to prevent, one field over.
 *
 * ── Why this is in `@wewin/core` ─────────────────────────────────────────────
 *
 * The storefront takes the number, the dashboard corrects it, the API stores it, and all
 * three must produce a byte-identical string or the constraint is decoration. A second
 * implementation is a second answer, and the two would agree until the first customer typed
 * a bracket.
 *
 * ── ⚠️ Thailand, and it says so ──────────────────────────────────────────────
 *
 * `libphonenumber` is 600 kB and knows the dialling plan of every country on earth. This
 * company installs aluminium windows in Phitsanulok. What is handled is Thai numbers written
 * the several ways Thai people write them, plus already-canonical international numbers
 * passed through unchanged.
 *
 * **An unrecognised shape is refused, never guessed.** A mangled number stored as an identity
 * is an account nobody can reach, and — worse — one that may reach somebody else. The day a
 * real international customer base exists, this file is replaced by the library and its tests
 * carry over unchanged.
 */

/** Thailand. The only country whose national format this file knows how to read. */
const TH = '66';

/**
 * A Thai subscriber number, with the trunk zero already gone.
 *
 * ⚠️ **The first digit decides the length, and a range would not do.** `06`/`08`/`09` are
 * mobile and carry nine subscriber digits; `02` (Bangkok) and `03`–`05`/`07` (provincial) are
 * landlines and carry eight. A single `\d{7,9}` accepts `81234567` — a mobile number with a
 * digit missing — because it is exactly as long as a landline, and the two are only
 * distinguishable by what they start with.
 *
 * That matters more here than it would in a contact field: this string becomes an **identity**
 * with a unique index over it, so a typo that survives is a typo somebody can be reached at,
 * or worse, one that collides with a real subscriber.
 */
const TH_MOBILE = /^[689]\d{8}$/u;
const TH_LANDLINE = /^[2-57]\d{7}$/u;

/** Everything a person might type between digits, and nothing else. */
const PUNCTUATION = /[\s ().-]/gu;

/**
 * The canonical form, or `null`.
 *
 * ⚠️ **Idempotent.** The value goes into a column with a CHECK that it equals its own
 * normalisation, so a function that moved on the second pass would create rows that cannot be
 * re-saved. `tests/phone.test.ts` asserts it directly.
 */
export function normalisePhone(written: string): string | null {
  const stripped = written.replace(PUNCTUATION, '');
  if (stripped === '') return null;

  /*
   * ⚠️ Anything that is not a digit, after punctuation is gone, refuses the whole string.
   * Extensions — `ต่อ 12`, `x12` — land here, which is the intent: `0812345678 ต่อ 12`
   * truncated to the number in front of it looks correct and belongs to a switchboard.
   */
  const digits = stripped.startsWith('+') ? stripped.slice(1) : stripped;
  if (!/^\d+$/u.test(digits)) return null;

  /* `+…` and `00…` are the same statement: what follows is already international. */
  if (stripped.startsWith('+')) return international(digits);
  if (digits.startsWith('00')) return international(digits.slice(2));

  /*
   * ⚠️ The trunk zero, dropped exactly once and only from a national number.
   *
   * `081…` national is `+6681…`. A rule written as "strip leading zeros, then prefix" turns
   * `+66081…` into a number one digit long that never matches the same person's other
   * spelling — so the international branch above is reached *first* and this one only ever
   * sees a number that began with a single `0`.
   */
  if (digits.startsWith('0')) return thai(digits.slice(1));

  /*
   * No `+`, no `00`, no trunk zero. `66812345678` is the country code written bare, which is
   * common enough in pasted text to be worth reading; anything else is a fragment.
   */
  return digits.startsWith(TH) ? international(digits) : null;
}

/** A country code already present. Only Thailand's national part is validated. */
function international(digits: string): string | null {
  if (digits.startsWith(TH)) return thai(digits.slice(TH.length));

  /*
   * Somebody else's country. Length is all this file can honestly check — E.164 caps the
   * whole number at 15 digits and no plan is shorter than 8 including the code.
   */
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** A Thai subscriber number, with the trunk zero already gone. */
function thai(subscriber: string): string | null {
  return TH_MOBILE.test(subscriber) || TH_LANDLINE.test(subscriber)
    ? `+${TH}${subscriber}`
    : null;
}

export type PhoneProblem =
  /** Nothing typed. Distinct from a bad number so a form can stay quiet until it is left. */
  | 'required'
  /** Letters, or an extension, or two numbers in one box. */
  | 'not-a-number'
  /** Digits, but not a shape this build can place — a fragment, or a foreign number with no code. */
  | 'unrecognised';

/**
 * Why a number was refused, for a form.
 *
 * `normalisePhone` answers `string | null` because callers store the string. A person needs to
 * know *what to change*: "เบอร์ไม่ถูกต้อง" on a Singapore number that is merely missing `+65`
 * is a dead end, and the two cases want different help text.
 */
export function phoneProblem(written: string): PhoneProblem | null {
  if (written.trim() === '') return 'required';
  if (normalisePhone(written) !== null) return null;

  const stripped = written.replace(PUNCTUATION, '').replace(/^\+/u, '');
  return /^\d+$/u.test(stripped) ? 'unrecognised' : 'not-a-number';
}
