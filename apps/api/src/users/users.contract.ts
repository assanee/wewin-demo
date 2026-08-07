import { z } from 'zod';

import { PERMISSION_CODES, isPermissionCode, type PermissionCode } from '../rbac/permissions';
import type { UserStatus } from '@wewin/db/schema';

/**
 * What the user-administration screen sends and receives.
 *
 * Declared here rather than in `@wewin/contract` to match the modules around it —
 * `media.contract.ts` and `authority.contract.ts` do the same, and moving all three is a
 * change to a package two other things import. Recorded in the plan as debt rather than
 * paid for on the way past.
 */

export interface UserGroupWire {
  readonly id: string;
  readonly code: string;
  readonly nameTh: string;
  readonly isSystem: boolean;
}

export interface UserSummaryWire {
  readonly id: string;
  readonly displayName: string | null;
  readonly status: UserStatus;
  /**
   * Verified addresses only.
   *
   * An unverified row is not an identity — `user_emails_one_verified_owner` is a *partial*
   * index precisely so an attacker's unverified claim on somebody else's address can exist
   * without meaning anything. Listing them here would put that claim on an administrator's
   * screen looking exactly like a fact.
   */
  readonly emails: readonly string[];
  readonly groups: readonly UserGroupWire[];
  /** Derived from the groups. A user holds no permission directly. */
  readonly permissions: readonly PermissionCode[];
  readonly liveSessions: number;
  readonly suspendedAt: string | null;
  readonly createdAt: string;
}

export interface UserListWire {
  readonly users: readonly UserSummaryWire[];
}

export interface GroupWire extends UserGroupWire {
  readonly permissions: readonly PermissionCode[];
  readonly memberCount: number;
}

export interface GroupListWire {
  readonly groups: readonly GroupWire[];
  /** Every code the application knows, so the screen offers a fixed list and not free text. */
  readonly available: readonly PermissionCode[];
}

/**
 * ⚠️ A reason, and it is required.
 *
 * A suspension with no recorded reason is a decision nobody can explain a month later, and
 * the person most likely to need the explanation is the suspended employee's manager. The
 * database does not enforce this — `users_suspended_at_present` only demands the timestamp
 * — so it is enforced here, where the wording can say why.
 */
export const suspendUserSchema = z.strictObject({
  reasonTh: z.string().trim().min(4).max(500),
});

export type SuspendUserRequest = z.infer<typeof suspendUserSchema>;

export const setUserGroupsSchema = z.strictObject({
  groupIds: z.array(z.uuid()).max(20),
});

export type SetUserGroupsRequest = z.infer<typeof setUserGroupsSchema>;

export const setGroupPermissionsSchema = z.strictObject({
  /*
   * Checked against `isPermissionCode` and not left as `z.string()`: the list is closed, and
   * a typo'd code would otherwise become a row in `group_permissions` that grants nothing
   * while reading like it grants something. The foreign key would refuse it too — this
   * refuses it with a sentence naming the code.
   *
   * `refine` rather than `z.enum`, because `PERMISSION_CODES` is a `readonly PermissionCode[]`
   * derived from the description table rather than a literal tuple, and deriving it is what
   * stops the list drifting from the descriptions beside it.
   */
  permissions: z
    .array(z.string().refine(isPermissionCode, 'ไม่รู้จักสิทธิ์นี้'))
    .max(PERMISSION_CODES.length)
    .transform((codes) => codes as PermissionCode[]),
});

export type SetGroupPermissionsRequest = z.infer<typeof setGroupPermissionsSchema>;

/**
 * Creating a staff account.
 *
 * ⚠️ **No password field, and there must never be one.** The account is created without a
 * credential and the person sets their own through a one-shot link — the same link the login
 * page's "forgot password" sends. An administrator who typed somebody's first password would
 * know it, and would keep knowing it for as long as that person never changed it.
 *
 * `verified` is asserted on the operator's behalf, exactly as `create-staff-user` does and
 * for the same reason: somebody with access to this screen is somebody the company trusts to
 * say "this is my colleague's address". It is also why no public endpoint can do it.
 */
export const createUserSchema = z.strictObject({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(120),
  groupIds: z.array(z.uuid()).max(20).default([]),
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const createGroupSchema = z.strictObject({
  /* `groups_code_shape` is `^[a-z][a-z0-9_]*$` — underscores, no hyphens. Checked here so a
     typo is a sentence rather than a CHECK violation printed as a failed INSERT. */
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/, 'รหัสกลุ่มต้องเป็น a-z, 0-9 และ _ เท่านั้น และขึ้นต้นด้วยตัวอักษร')
    .max(60),
  nameTh: z.string().trim().min(1).max(120),
  permissions: z
    .array(z.string().refine(isPermissionCode, 'ไม่รู้จักสิทธิ์นี้'))
    .max(PERMISSION_CODES.length)
    .default([])
    .transform((codes) => codes as PermissionCode[]),
});

export type CreateGroupRequest = z.infer<typeof createGroupSchema>;

export const renameGroupSchema = z.strictObject({
  nameTh: z.string().trim().min(1).max(120),
});

export type RenameGroupRequest = z.infer<typeof renameGroupSchema>;

/** What a create answers with, so the screen can show the account it just made. */
export interface CreatedUserWire {
  readonly userId: string;
  /** Whether the set-password email went out. False when the transport refused it. */
  readonly invitationSent: boolean;
}
