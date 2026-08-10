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
