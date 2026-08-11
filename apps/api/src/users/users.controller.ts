import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { CurrentScope, RequirePermissions, matchScope, type Scope } from '../rbac';
import {
  createGroupSchema,
  createUserSchema,
  renameGroupSchema,
  setGroupPermissionsSchema,
  setUserGroupsSchema,
  suspendUserSchema,
  type CreateGroupRequest,
  type CreatedUserWire,
  type CreateUserRequest,
  type GroupListWire,
  type RenameGroupRequest,
  type SetGroupPermissionsRequest,
  type SetUserGroupsRequest,
  type SuspendUserRequest,
  type UserListWire,
} from './users.contract';
import type { AdminEventRow } from './audit.repository';
import { UsersService } from './users.service';

const contractVersion = (): MethodDecorator =>
  Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * Who works here, what they may do, and how to stop them.
 *
 *     GET    /admin/users                              the list, with groups and permissions
 *     POST   /admin/users                              create an account + send a set-password link
 *     POST   /admin/users/:userId/suspension           ban
 *     DELETE /admin/users/:userId/suspension           reinstate
 *     POST   /admin/users/:userId/phones/:phoneId/verification    a staff member vouches for a number
 *     DELETE /admin/users/:userId/phones/:phoneId/verification    undo a mistaken one
 *     PUT    /admin/users/:userId/groups               which groups they are in
 *     POST   /admin/users/:userId/sessions/revocation  sign them out everywhere
 *     POST   /admin/users/:userId/password-link        email them a set-password link
 *     GET    /admin/groups                             groups, their permissions, member counts
 *     POST   /admin/groups                             create
 *     PATCH  /admin/groups/:groupId                    rename
 *     DELETE /admin/groups/:groupId                    delete, if empty
 *     PUT    /admin/groups/:groupId/permissions        what the group grants
 *
 * ── ⭐ `users.read` looks, `users.write` changes ─────────────────────────────────
 *
 * Split because most of the value of this screen is *looking* — who is in what group, who
 * still has a live session, who has been suspended and when — and that is a thing a manager
 * or a support lead has an ordinary reason to do. Handing them the ability to grant
 * themselves `orders.refund` in order to answer "does Somchai have access?" would be a
 * strange trade.
 *
 * `users.erase` deliberately has **no route here**. Erasure is `erase_user()` in Postgres,
 * it is irreversible, and plan 7.16 still has unanswered questions a lawyer owns. A button
 * for it would settle those questions by shipping.
 *
 * ── There is no "close account" either ───────────────────────────────────────────
 *
 * `closed` is a status this screen cannot undo: `signInDisposition` reinstates it when the
 * person proves control through an OAuth provider, and nothing in the dashboard can. An
 * administrator pressing it on a password-only colleague would create a state only a
 * database prompt can leave. Suspension is reversible and covers what this screen is for.
 */
@Controller('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @contractVersion()
  @RequirePermissions('users.read')
  async list(): Promise<UserListWire> {
    return this.users.list();
  }

  @Post('users')
  @contractVersion()
  @RequirePermissions('users.write')
  async create(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(createUserSchema)) body: CreateUserRequest,
  ): Promise<CreatedUserWire> {
    return this.users.createUser(callerOf(scope), body);
  }

  /**
   * Ban.
   *
   * A reason is required by the schema and recorded in the log rather than in a column —
   * `users` has nowhere to put one, and adding a column is a migration this change does not
   * need to make. Stated plainly because it is a limitation: the reason is in the
   * application log, not on the row, so a report six months later has to go looking.
   */
  @Post('users/:userId/suspension')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async suspend(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
    @Body(new ZodBodyPipe(suspendUserSchema)) body: SuspendUserRequest,
  ): Promise<void> {
    await this.users.setSuspended(callerOf(scope), userId, true);
    void body.reasonTh;
  }

  @Delete('users/:userId/suspension')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async reinstate(@CurrentScope() scope: Scope, @Param('userId') userId: string): Promise<void> {
    await this.users.setSuspended(callerOf(scope), userId, false);
  }

  /**
   * A member of staff, having spoken to the customer on the telephone, says the number is
   * theirs. `users.write` — the same permission that edits the rest of the account — and
   * deliberately no new code: see `UsersService.verifyPhone` for what this is and is not.
   */
  @Post('users/:userId/phones/:phoneId/verification')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async verifyPhone(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
    @Param('phoneId') phoneId: string,
  ): Promise<void> {
    await this.users.verifyPhone(callerOf(scope), userId, phoneId);
  }

  /** Undo one vouched for by mistake. See `UsersService.unverifyPhone`. */
  @Delete('users/:userId/phones/:phoneId/verification')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async unverifyPhone(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
    @Param('phoneId') phoneId: string,
  ): Promise<void> {
    await this.users.unverifyPhone(callerOf(scope), userId, phoneId);
  }

  @Put('users/:userId/groups')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async setGroups(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
    @Body(new ZodBodyPipe(setUserGroupsSchema)) body: SetUserGroupsRequest,
  ): Promise<void> {
    await this.users.setUserGroups(callerOf(scope), userId, body.groupIds);
  }

  /** Sign somebody out everywhere. The lost-laptop action, and not a suspension. */
  @Post('users/:userId/sessions/revocation')
  @contractVersion()
  @RequirePermissions('users.write')
  async revokeSessions(
    @CurrentScope() scope: Scope,
    @Param('userId') userId: string,
  ): Promise<{ readonly revoked: number }> {
    return { revoked: await this.users.revokeSessions(callerOf(scope), userId) };
  }

  @Post('users/:userId/password-link')
  @contractVersion()
  @RequirePermissions('users.write')
  async sendPasswordLink(
    @Param('userId') userId: string,
  ): Promise<{ readonly sent: boolean }> {
    return { sent: await this.users.sendSetPasswordLinkTo(userId) };
  }

  @Get('groups')
  @contractVersion()
  @RequirePermissions('users.read')
  async listGroups(): Promise<GroupListWire> {
    return this.users.listGroups();
  }

  @Post('groups')
  @contractVersion()
  @RequirePermissions('users.write')
  async createGroup(
    @CurrentScope() scope: Scope,
    @Body(new ZodBodyPipe(createGroupSchema)) body: CreateGroupRequest,
  ): Promise<{ readonly groupId: string }> {
    return { groupId: await this.users.createGroup(callerOf(scope), body) };
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * ⭐ The audit trail — because one nobody can read is decoration.
   * ─────────────────────────────────────────────────────────────────────────
   *
   *     GET /admin/users/audit          everything, newest first
   *     GET /admin/users/audit?userId=  one person's history
   *
   * ── ⚠️ `users.write` and not `users.read`, and not a new code ────────────
   *
   * `users.read` is the support lead answering "does Somchai still have access?". That is a
   * different question from "who changed whose permissions last month", and the second is
   * not part of the first.
   *
   * A separate `audit.read` would be more correct in a company with somebody whose job is
   * oversight rather than administration — and WEWIN does not have one. Adding a code that
   * `permission-sync` inserts and no group holds would make the trail unreadable on the day
   * it shipped, which is the same failure as a dead-letter queue nobody sees: the record
   * exists, nothing surfaces it, and the company believes it is covered.
   *
   * So: the people who may change these things may see what was changed. When there is an
   * auditor, `audit.read` is the split, and this comment is where to start.
   */
  @Get('audit')
  @contractVersion()
  @RequirePermissions('users.write')
  async audit(
    @Query('userId') userId: string | undefined,
  ): Promise<{ readonly events: readonly AdminEventRow[] }> {
    return {
      events: await this.users.auditTrail({
        subjectUserId: userId === undefined || userId === '' ? undefined : userId,
      }),
    };
  }

  @Patch('groups/:groupId')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async renameGroup(
    @CurrentScope() scope: Scope,
    @Param('groupId') groupId: string,
    @Body(new ZodBodyPipe(renameGroupSchema)) body: RenameGroupRequest,
  ): Promise<void> {
    await this.users.renameGroup(callerOf(scope), groupId, body.nameTh);
  }

  @Delete('groups/:groupId')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async deleteGroup(
    @CurrentScope() scope: Scope,
    @Param('groupId') groupId: string,
  ): Promise<void> {
    await this.users.deleteGroup(callerOf(scope), groupId);
  }

  @Put('groups/:groupId/permissions')
  @HttpCode(204)
  @contractVersion()
  @RequirePermissions('users.write')
  async setGroupPermissions(
    @CurrentScope() scope: Scope,
    @Param('groupId') groupId: string,
    @Body(new ZodBodyPipe(setGroupPermissionsSchema)) body: SetGroupPermissionsRequest,
  ): Promise<void> {
    await this.users.setGroupPermissions(callerOf(scope), groupId, body.permissions);
  }
}

/**
 * The signed-in user's id, or a refusal.
 *
 * Every write here is guarded against the caller acting on themselves, and that guard is
 * worthless if the caller cannot be identified — so a scope that is not a user is refused
 * rather than defaulted. `RequirePermissions` has already excluded guests and the public;
 * `system` is the one that would otherwise slip through, and a background job has no
 * business editing who works here.
 */
function callerOf(scope: Scope): string {
  return matchScope<string>(scope, {
    user: (user) => user.userId,
    guest: () => {
      throw AppError.unauthenticated('ต้องเข้าสู่ระบบก่อน');
    },
    public: () => {
      throw AppError.unauthenticated('ต้องเข้าสู่ระบบก่อน');
    },
    system: () => {
      throw AppError.conflict('งานเบื้องหลังแก้ไขผู้ใช้ไม่ได้', { reason: 'system-scope' });
    },
  });
}
