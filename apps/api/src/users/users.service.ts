import { Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import type { PermissionCode } from '../rbac/permissions';
import {
  USER_ADMIN_PERMISSION,
  lastAdministratorProblem,
  selfActionProblem,
  type SelfAction,
} from './lockout';
import type { CreatedUserWire, GroupListWire, UserListWire } from './users.contract';
import { PasswordResetService } from '../auth/password/password-reset.service';
import { UsersRepository } from './users.repository';
import { PERMISSION_CODES } from '../rbac/permissions';

/**
 * Reading and changing who works here.
 *
 * ── Every write passes the lockout guards before it touches a row ────────────────
 *
 * `lockout.ts` holds the two policies and explains why the database cannot hold them. This
 * class is where they are *applied*, and the ordering is the whole of it: check, then write.
 * The other order would leave a company with no administrator and a 500 to read about it.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repository: UsersRepository,
    private readonly resets: PasswordResetService,
  ) {}

  async list(): Promise<UserListWire> {
    return { users: await this.repository.list() };
  }

  async listGroups(): Promise<GroupListWire> {
    return { groups: await this.repository.listGroups(), available: PERMISSION_CODES };
  }

  async setSuspended(callerUserId: string, userId: string, suspended: boolean): Promise<void> {
    const status = await this.repository.statusOf(userId);
    if (status === undefined) throw AppError.notFound('ไม่พบบัญชีผู้ใช้นี้');

    /*
     * ⚠️ Only the suspension *direction* is guarded. Reinstating yourself is impossible by
     * construction — a suspended account holds no session and reaches no endpoint — so the
     * check is on the way in, where it can still save somebody.
     */
    if (suspended) {
      this.refuseSelf(callerUserId, userId, 'suspend');

      /*
       * And the last active administrator may not be suspended, which is the same lockout as
       * demoting them by another road. `excludeUserId` asks who would remain.
       */
      const remaining = await this.repository.administratorsExcluding({ excludeUserId: userId });
      if (remaining.size === 0 && (await this.holdsAdmin(userId))) {
        throw AppError.conflict(
          'บัญชีนี้เป็นผู้ดูแลผู้ใช้คนสุดท้ายที่ยังใช้งานได้ — ระงับแล้วจะไม่มีใครปลดระงับได้อีก',
          { reason: 'no-administrator-left' },
        );
      }
    }

    /*
     * `erased` and `closed` are refused rather than silently no-op'd. `setSuspended` guards
     * its own UPDATE with `status = 'active'`, so a closed account would simply not change
     * and the screen would report success over nothing.
     */
    if (suspended ? status !== 'active' : status !== 'suspended') {
      throw AppError.conflict('สถานะของบัญชีนี้เปลี่ยนไปแล้ว — กรุณาโหลดข้อมูลใหม่', {
        reason: 'state-changed',
        status,
      });
    }

    await this.repository.setSuspended(userId, suspended);
    this.logger.log(
      `${suspended ? 'suspended' : 'reinstated'} ${userId} by ${callerUserId}`,
    );
  }

  async setUserGroups(
    callerUserId: string,
    userId: string,
    groupIds: readonly string[],
  ): Promise<void> {
    if (await this.repository.statusOf(userId) === undefined) {
      throw AppError.notFound('ไม่พบบัญชีผู้ใช้นี้');
    }
    this.refuseSelf(callerUserId, userId, 'permissions');

    for (const groupId of groupIds) {
      if (!(await this.repository.groupExists(groupId))) {
        throw AppError.validationFailed('ไม่พบกลุ่มที่ระบุ', { reason: 'unknown-group', groupId });
      }
    }

    /*
     * Would this leave nobody? `excludeUserId` removes this person from the count, and
     * `permissionsAfter` is what their new groups would grant — so putting somebody *into*
     * an admin group is never refused, and taking the only one out is.
     */
    const problem = lastAdministratorProblem({
      holdersAfter: await this.repository.administratorsExcluding({ excludeUserId: userId }),
      permissionsAfter: await this.repository.permissionsOfGroups(groupIds),
    });
    if (problem !== null) throw UsersService.lastAdministrator();

    await this.repository.setUserGroups(userId, groupIds);
    this.logger.log(`groups of ${userId} set to [${groupIds.join(', ')}] by ${callerUserId}`);
  }

  async setGroupPermissions(
    callerUserId: string,
    groupId: string,
    permissions: readonly PermissionCode[],
  ): Promise<void> {
    if (!(await this.repository.groupExists(groupId))) {
      throw AppError.notFound('ไม่พบกลุ่มนี้');
    }

    const problem = lastAdministratorProblem({
      holdersAfter: await this.repository.administratorsExcluding({ excludeGroupId: groupId }),
      permissionsAfter: new Set(permissions),
    });
    if (problem !== null) throw UsersService.lastAdministrator();

    /*
     * ⚠️ There is no self-check here, and it is deliberate rather than missed. A group is not
     * a person: refusing "the caller is in this group" would stop the only administrator
     * group from ever being edited, which is most of what this endpoint is for. The
     * last-administrator guard above is what covers the dangerous case, and it covers it
     * whether or not the caller is a member.
     */
    await this.repository.setGroupPermissions(groupId, permissions);
    this.logger.log(
      `permissions of group ${groupId} set to [${permissions.join(', ')}] by ${callerUserId}`,
    );
  }

  /**
   * Create a staff account and send them a link to set their own password.
   *
   * The email is best effort and reported rather than fatal: the account exists either way,
   * and an administrator who was told "creation failed" over a refused SMTP connection would
   * create a second one. `invitationSent` is what the screen shows.
   */
  async createUser(
    callerUserId: string,
    input: { readonly email: string; readonly displayName: string; readonly groupIds: readonly string[] },
  ): Promise<CreatedUserWire> {
    const email = input.email.trim().toLowerCase();

    if (await this.repository.addressTaken(email)) {
      /*
       * Said plainly, and that is safe *here* in a way it would never be on the login page:
       * the caller already holds `users.read` and can see the whole list, so there is nothing
       * to enumerate. Being vague would only make an administrator wonder why the button
       * failed.
       */
      throw AppError.conflict('อีเมลนี้เป็นของบัญชีอื่นอยู่แล้ว', { reason: 'address-taken' });
    }

    for (const groupId of input.groupIds) {
      if (!(await this.repository.groupExists(groupId))) {
        throw AppError.validationFailed('ไม่พบกลุ่มที่ระบุ', { reason: 'unknown-group', groupId });
      }
    }

    const userId = await this.repository.createUser({ ...input, email });
    this.logger.log(`created ${userId} (${email}) by ${callerUserId}`);

    return { userId, invitationSent: await this.sendSetPasswordLink(email) };
  }

  /** Send the same one-shot link the login page sends. Idempotent by the token rules. */
  async sendSetPasswordLink(email: string): Promise<boolean> {
    try {
      await this.resets.request({ email, address: 'admin-console' });
      return true;
    } catch (error) {
      // Includes the reset throttle's 429. Reported as "not sent" rather than thrown,
      // because the caller's action — creating the account — did succeed.
      this.logger.warn(`could not send a set-password link to ${email}: ${String(error)}`);
      return false;
    }
  }

  async sendSetPasswordLinkTo(userId: string): Promise<boolean> {
    const email = await this.repository.primaryAddressOf(userId);
    if (email === undefined) {
      throw AppError.conflict('บัญชีนี้ยังไม่มีอีเมลที่ยืนยันแล้ว จึงส่งลิงก์ไม่ได้', {
        reason: 'no-verified-address',
      });
    }
    return this.sendSetPasswordLink(email);
  }

  /**
   * End every live session, without changing the account's status.
   *
   * The lost-laptop action, and separate from suspension on purpose: "my phone was stolen"
   * and "this person no longer works here" are different sentences and only one of them
   * should stop somebody working.
   */
  async revokeSessions(callerUserId: string, userId: string): Promise<number> {
    if (await this.repository.statusOf(userId) === undefined) {
      throw AppError.notFound('ไม่พบบัญชีผู้ใช้นี้');
    }
    /*
     * Refused on yourself for the same reason as suspension: it signs the caller out
     * mid-click. Signing yourself out everywhere is what the sign-out button is for, and it
     * does not need this screen.
     */
    this.refuseSelf(callerUserId, userId, 'suspend');

    const revoked = await this.repository.revokeSessions(userId);
    this.logger.log(`revoked ${String(revoked)} session(s) of ${userId} by ${callerUserId}`);
    return revoked;
  }

  async createGroup(
    callerUserId: string,
    input: { readonly code: string; readonly nameTh: string; readonly permissions: readonly PermissionCode[] },
  ): Promise<string> {
    const groupId = await this.repository.createGroup(input);
    this.logger.log(`created group ${input.code} by ${callerUserId}`);
    return groupId;
  }

  async renameGroup(groupId: string, nameTh: string): Promise<void> {
    const group = await this.repository.groupById(groupId);
    if (group === undefined) throw AppError.notFound('ไม่พบกลุ่มนี้');
    await this.repository.renameGroup(groupId, nameTh);
  }

  /**
   * Delete a group.
   *
   * ⚠️ Refused while anybody is in it, rather than cascading. `user_groups` has an
   * `ON DELETE CASCADE`, so the delete would succeed and quietly strip permissions from
   * however many people were members — an outcome nobody asked for from a button labelled
   * "delete group". Emptying it first is one extra step and one the person can see.
   *
   * A `is_system` group is refused outright: those exist because something in the
   * application refers to them by code.
   */
  async deleteGroup(groupId: string): Promise<void> {
    const group = await this.repository.groupById(groupId);
    if (group === undefined) throw AppError.notFound('ไม่พบกลุ่มนี้');

    if (group.isSystem) {
      throw AppError.conflict('กลุ่มนี้เป็นกลุ่มของระบบ ลบไม่ได้', { reason: 'system-group' });
    }
    if (group.memberCount > 0) {
      throw AppError.conflict(
        `ยังมีผู้ใช้ ${String(group.memberCount)} คนอยู่ในกลุ่มนี้ — ย้ายออกให้หมดก่อนจึงลบได้`,
        { reason: 'group-not-empty', memberCount: group.memberCount },
      );
    }

    const problem = lastAdministratorProblem({
      holdersAfter: await this.repository.administratorsExcluding({ excludeGroupId: groupId }),
      permissionsAfter: new Set(),
    });
    if (problem !== null) throw UsersService.lastAdministrator();

    await this.repository.deleteGroup(groupId);
  }

  private async holdsAdmin(userId: string): Promise<boolean> {
    const all = await this.repository.list();
    return all.find((user) => user.id === userId)?.permissions.includes(USER_ADMIN_PERMISSION) === true;
  }

  private refuseSelf(callerUserId: string, targetUserId: string, action: SelfAction): void {
    const problem = selfActionProblem(callerUserId, targetUserId, action);
    if (problem === null) return;

    throw AppError.conflict(
      problem === 'self-suspend'
        ? 'ระงับบัญชีของตัวเองไม่ได้ — จะออกจากระบบทันทีและกลับเข้ามาปลดไม่ได้'
        : 'แก้สิทธิ์ของบัญชีตัวเองไม่ได้ — ให้ผู้ดูแลอีกคนเป็นผู้แก้',
      { reason: problem },
    );
  }

  private static lastAdministrator(): AppError {
    return AppError.conflict(
      'ต้องมีบัญชีที่ใช้งานได้อย่างน้อยหนึ่งบัญชีที่ถือสิทธิ์ users.write — ' +
        'ถ้าไม่เหลือเลย จะไม่มีใครแก้สิทธิ์ให้ใครได้อีกนอกจากแก้ที่ฐานข้อมูลโดยตรง',
      { reason: 'no-administrator-left' },
    );
  }
}
