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
import { AuditRepository, type AdminEventRow } from './audit.repository';
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
  /*
   * ⚠️ The `logger.log` lines below stay, and they are no longer the record.
   *
   * `admin_events` is the record — queryable, append-only, survives the machine. A log line
   * is still worth having for somebody watching a process in real time, which is a different
   * job from answering "who removed her second factor, and when" six weeks later. Deleting
   * them would trade a useful thing for tidiness.
   */
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repository: UsersRepository,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditRepository,
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

    await this.repository.setSuspended(userId, suspended, callerUserId);
    this.logger.log(
      `${suspended ? 'suspended' : 'reinstated'} ${userId} by ${callerUserId}`,
    );
  }

  /**
   * A member of staff, having spoken to the customer, says this number belongs to them.
   *
   * ⚠️ This is **not** proof of possession — there is no SMS OTP here, deliberately (no
   * provider, no per-message cost the owner has not agreed to pay). It is a weaker and
   * different claim, and `verified_by_user_id` is what keeps a later reader from mistaking
   * it for the stronger one: non-null means "a person at this company vouched", exactly as
   * the phone table's schema comment argues. The day an OTP flow exists it sets
   * `verified_at` alone and leaves this column null, and the two kinds stay distinguishable
   * on the row without a join anywhere.
   */
  async verifyPhone(callerUserId: string, userId: string, phoneId: string): Promise<void> {
    const phone = await this.repository.findPhone(phoneId);
    if (phone === undefined || phone.userId !== userId) {
      throw AppError.notFound('ไม่พบเบอร์นี้');
    }

    if (phone.verifiedAt !== null) {
      /*
       * ⚠️ Refused, not silently repeated. `verifyPhone`'s UPDATE is guarded by `verified_at
       * is null`, so a second call here would already change nothing — this is what turns
       * that into a sentence instead of a 204 that reports success over no-op, the same
       * discipline `setSuspended` applies to suspending twice.
       */
      throw AppError.conflict(
        'เบอร์นี้ยืนยันแล้ว — หากต้องการเปลี่ยนคนยืนยัน ให้ยกเลิกการยืนยันก่อนแล้วยืนยันใหม่',
        { reason: 'already-verified' },
      );
    }

    const verified = await this.repository.verifyPhone(phoneId, userId, callerUserId);
    if (!verified) {
      // Somebody else verified it between the read above and this write — the compare-and-
      // set lost the race. Reported as a conflict rather than retried silently, so the
      // screen reloads and shows who actually won it.
      throw AppError.conflict('สถานะเบอร์นี้เปลี่ยนไปแล้ว — กรุณาโหลดข้อมูลใหม่', {
        reason: 'state-changed',
      });
    }
    this.logger.log(`phone ${phoneId} of ${userId} verified by ${callerUserId}`);
  }

  /**
   * Undo a verification — a number vouched for by mistake, and mistakes have to be undoable.
   *
   * Both `verified_at` and `verified_by_user_id` return to null. Not one alone:
   * `user_phones_voucher_needs_a_verification` refuses a voucher on an unverified row, so a
   * half-cleared pair is not a state this table can hold. Un-verifying is the pair returning
   * to exactly what a fresh, never-verified claim looks like — the mistake and its correction
   * survive only in `admin_events`, which is why `user.phone_unverified` exists at all.
   */
  async unverifyPhone(callerUserId: string, userId: string, phoneId: string): Promise<void> {
    const phone = await this.repository.findPhone(phoneId);
    if (phone === undefined || phone.userId !== userId) {
      throw AppError.notFound('ไม่พบเบอร์นี้');
    }

    if (phone.verifiedAt === null) {
      throw AppError.conflict('เบอร์นี้ยังไม่ได้ยืนยัน', { reason: 'not-verified' });
    }

    /*
     * `user_phones_primary_is_verified` demands a primary number stay verified — un-verifying
     * one would either violate that CHECK outright or (if the primary flag also moved) change
     * which number the account signs in and is found by, which is not what this button is
     * for. Refused with a sentence rather than left to surface as a 500 from Postgres.
     */
    if (phone.isPrimary) {
      throw AppError.conflict(
        'ยกเลิกการยืนยันเบอร์หลักไม่ได้ — เบอร์หลักของบัญชีต้องเป็นเบอร์ที่ยืนยันแล้วเสมอ ตั้งเบอร์อื่นเป็นเบอร์หลักก่อน',
        { reason: 'primary-number' },
      );
    }

    const unverified = await this.repository.unverifyPhone(phoneId, userId, callerUserId);
    if (!unverified) {
      throw AppError.conflict('สถานะเบอร์นี้เปลี่ยนไปแล้ว — กรุณาโหลดข้อมูลใหม่', {
        reason: 'state-changed',
      });
    }
    this.logger.log(`phone ${phoneId} of ${userId} unverified by ${callerUserId}`);
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

    await this.repository.setUserGroups(userId, groupIds, callerUserId);
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
    await this.repository.setGroupPermissions(groupId, permissions, callerUserId);
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

    const userId = await this.repository.createUser({
      actorUserId: callerUserId, ...input, email });
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

    const revoked = await this.repository.revokeSessions(userId, callerUserId);
    this.logger.log(`revoked ${String(revoked)} session(s) of ${userId} by ${callerUserId}`);
    return revoked;
  }

  async createGroup(
    callerUserId: string,
    input: { readonly code: string; readonly nameTh: string; readonly permissions: readonly PermissionCode[] },
  ): Promise<string> {
    const groupId = await this.repository.createGroup({ ...input, actorUserId: callerUserId });
    this.logger.log(`created group ${input.code} by ${callerUserId}`);
    return groupId;
  }

  async renameGroup(callerUserId: string, groupId: string, nameTh: string): Promise<void> {
    const group = await this.repository.groupById(groupId);
    if (group === undefined) throw AppError.notFound('ไม่พบกลุ่มนี้');
    await this.repository.renameGroup(groupId, nameTh, callerUserId);
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
  async deleteGroup(callerUserId: string, groupId: string): Promise<void> {
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

    await this.repository.deleteGroup(groupId, callerUserId);
  }

  /**
   * The administrative history.
   *
   * ⚠️ Capped, and the cap is not a page size — there is no paging. A hundred rows is what a
   * person reads; beyond that the question has stopped being "what happened recently" and
   * become a query somebody should write against the table. Saying so is better than a
   * paginator nobody scrolls past page two of.
   */
  async auditTrail(filter: { readonly subjectUserId?: string | undefined }): Promise<
    readonly AdminEventRow[]
  > {
    return this.audit.list({ ...filter, limit: 100 });
  }

  private async holdsAdmin(userId: string): Promise<boolean> {
    const all = await this.repository.list();
    return all.find((user) => user.id === userId)?.permissions.includes(USER_ADMIN_PERMISSION) === true;
  }

  private refuseSelf(callerUserId: string, targetUserId: string, action: SelfAction): void {
    const problem = selfActionProblem(callerUserId, targetUserId, action);
    if (problem === null) return;

    /*
     * ⚠️ A switch and not a ternary, and it became one when a third self-action arrived.
     *
     * `problem === 'self-suspend' ? a : b` gave `self-disable-mfa` the *permissions*
     * sentence — silently, with no type error, because both arms were already strings. The
     * same discipline `lockout.ts` argues for in the function that produces these values:
     * no default arm, so the next one is a compile error rather than a wrong sentence.
     */
    switch (problem) {
      case 'self-suspend':
        throw AppError.conflict(
          'ระงับบัญชีของตัวเองไม่ได้ — จะออกจากระบบทันทีและกลับเข้ามาปลดไม่ได้',
          { reason: problem },
        );
      case 'self-permissions':
        throw AppError.conflict('แก้สิทธิ์ของบัญชีตัวเองไม่ได้ — ให้ผู้ดูแลอีกคนเป็นผู้แก้', {
          reason: problem,
        });
      case 'self-disable-mfa':
        throw AppError.conflict(
          'ปิดการยืนยันสองขั้นของตัวเองผ่านหน้าจัดการผู้ใช้ไม่ได้ — ให้ปิดจากหน้าบัญชีของฉัน ซึ่งจะถามรหัสผ่าน',
          { reason: problem },
        );
    }
  }

  private static lastAdministrator(): AppError {
    return AppError.conflict(
      'ต้องมีบัญชีที่ใช้งานได้อย่างน้อยหนึ่งบัญชีที่ถือสิทธิ์ users.write — ' +
        'ถ้าไม่เหลือเลย จะไม่มีใครแก้สิทธิ์ให้ใครได้อีกนอกจากแก้ที่ฐานข้อมูลโดยตรง',
      { reason: 'no-administrator-left' },
    );
  }
}
