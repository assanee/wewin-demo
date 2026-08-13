import { z } from 'zod';

import { PASSWORD_MAX_LENGTH } from '../auth/password/password.contract';

/** One OAuth account the person has linked. */
export interface LinkedProviderWire {
  readonly provider: string;
  /** What the provider said the address was, at the last sign-in. Never our own record. */
  readonly assertedEmail: string | null;
  readonly assertedEmailVerified: boolean;
  readonly lastAuthenticatedAt: string | null;
}

/** One device, as its owner sees it. */
export interface MySessionWire {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  /** True for the session this request arrived on, so the screen can say "this device". */
  readonly current: boolean;
}

/**
 * One telephone number this account has claimed.
 *
 * ⚠️ Unlike an email, being listed here is not proof of anything — see the repository's
 * comment on `listPhones` for why an unverified claim is still returned, and never
 * `isPrimary` unless a member of staff has vouched for it.
 */
export interface PhoneWire {
  readonly number: string;
  readonly isPrimary: boolean;
  /**
   * ISO 8601 when somebody proved this number, or `null` for a bare claim.
   *
   * ⭐ Added so a customer's own profile screen can say *"ยังไม่ได้ยืนยัน"* rather than
   * printing a number with no qualification. Before this, the only verification signal on
   * this wire was `isPrimary` — and reading that as "verified" is wrong in one direction:
   * `user_phones_primary_is_verified` makes `isPrimary` imply verified, but the converse does
   * not hold, so a verified non-primary number would have been shown as unproven.
   *
   * `verified_at` on its own cannot say *how* it was proved. See `verifiedByStaff`.
   */
  readonly verifiedAt: string | null;
  /**
   * ⭐ **Whether a person vouched, rather than who.**
   *
   * `user_phones.verified_by_user_id` distinguishes the two ways a number becomes verified,
   * and its own comment in `packages/db/src/schema/auth.ts` asks that "a reader of this row
   * should be able to tell the two apart": non-null is a member of staff asserting the number
   * over the telephone, null-with-a-`verified_at` is possession proved directly by an OTP.
   *
   * ⚠️ **The id itself is deliberately not on this wire, unlike `UserPhoneWire`'s.** That one
   * is read by `/admin/users` and a staff reader may see which colleague vouched. This one is
   * read by the customer whose number it is, and handing them a staff member's user UUID
   * publishes an internal identifier to answer a question — "did a person do this?" — that a
   * boolean answers exactly. The two wires differ here on purpose; they are not a duplication
   * waiting to be merged.
   *
   * ⚠️⚠️ **And there is a second reason, found while writing this and worth more than the
   * first.** `ERASURE_TREATMENTS` declares `'user_phones.verified_by_user_id': 'scrub'` — the
   * staff member's id is supposed to be nulled when *that member of staff* is erased — but no
   * version of `erase_user()` contains the statement, and `erasure.test.ts`'s generic loop
   * checks only the `delete` treatments, so nothing catches it. The id on this column can
   * therefore outlive the erasure that promised to remove it.
   *
   * A boolean is immune to that, and not by luck: "a person vouched, rather than an OTP" is
   * precisely the part of that column erasure is *entitled* to keep — the same accounting
   * exemption `admin_events` records administrative acts under. So this field stays true after
   * the voucher is forgotten and says nothing it should not. Putting the id here would have
   * made a customer-facing screen the place a known unfixed scrub gap surfaced.
   *
   * ⚠️ The gap itself is pre-existing, is not this round's to fix, and is reported rather than
   * quietly worked around: `/admin/users` still carries the id.
   *
   * ⚠️ There is **no OTP in this system today**, so in practice `verifiedAt !== null` implies
   * this is true. It is still two fields rather than one, because the day an OTP lands the
   * screen must stop saying "staff confirmed it" without anybody having to remember to look.
   */
  readonly verifiedByStaff: boolean;
}

export interface AccountWire {
  readonly userId: string;
  readonly displayName: string | null;
  readonly emails: readonly { readonly address: string; readonly isPrimary: boolean }[];
  readonly phones: readonly PhoneWire[];
  readonly hasPassword: boolean;
  readonly providers: readonly LinkedProviderWire[];
  readonly sessions: readonly MySessionWire[];
  /**
   * How many ways this account still has of signing in.
   *
   * Sent rather than derived on the client because the rule has one definition
   * (`credentials.ts`) and a second copy in the browser would disagree the day somebody has
   * a password and no verified address — which is exactly the case the rule exists for.
   */
  readonly waysIn: number;
}

/**
 * Changing your own password.
 *
 * ⚠️ **`currentPassword` is required and is not decoration.** Without it, anybody who finds
 * an unlocked laptop changes the password and owns the account — and the person's own
 * password stops working, so they cannot take it back. It is also what makes this different
 * from the reset flow, which proves control of the mailbox instead.
 *
 * Absent for somebody who has no password yet (a Google sign-up setting one for the first
 * time): there is nothing to prove, and demanding a value nobody has would make the field
 * impossible rather than safe. The service checks which case it is against the database, not
 * against what the client sent.
 */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;
