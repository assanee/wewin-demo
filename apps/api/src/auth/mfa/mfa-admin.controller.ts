import { Controller, Delete, Header, HttpCode, Logger, Param } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../../rbac';
import { signedIn } from '../../account/signed-in';
import { selfActionProblem } from '../../users/lockout';
import { MfaRepository } from './mfa.repository';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Somebody lost their phone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     DELETE /admin/users/:userId/mfa     turn off a colleague's second factor
 *
 * The other half of plan 6.4's recovery design: ten codes, and an administrator. Without
 * this route a person who loses their phone *and* their codes is outside permanently, and
 * `gate.ts` would be describing a lockout it could not undo.
 *
 * ── ⭐ It refuses to point at yourself ───────────────────────────────────────
 *
 * `reproof.ts` makes self-service disabling cost the account's password, because an unlocked
 * laptop is otherwise a way to strip a second factor with nothing but what is on the screen.
 * This route asks for no password — correctly, since an administrator does not have somebody
 * else's.
 *
 * ⚠️ Aimed at your own account those two combine into a door around the rule: any holder of
 * `users.write` could turn their own second factor off having proved nothing. Neither half
 * is wrong alone, which is exactly why nothing catches it but a rule about the pair — see
 * `users/lockout.ts`, where it lives beside self-suspension for the same reason.
 *
 * ── What is recorded, and what is not ────────────────────────────────────────
 *
 * A log line naming both people, which is the pattern every other staff action on a user
 * follows in this codebase — `users.service.ts` logs suspensions, group changes and session
 * revocations exactly this way and no more.
 *
 * ⚠️ It is a log and not a table, and that is a real limitation rather than a choice made
 * here: there is no audit table for user administration at all. A log rotates, is not
 * queryable from the application, and cannot be shown to the person it was about. Turning
 * off somebody's second factor is arguably the action in this whole surface that most
 * deserves a row — but building one for MFA alone would leave suspensions and permission
 * changes in a weaker place than the feature that arrived last, which is the wrong shape for
 * an audit trail.
 */

/**
 * A `:userId` that is not a uuid reaches Postgres as `invalid input syntax for type uuid` —
 * a 500 for what is a client mistake, with a database error echoed to whoever sent it. Local
 * to this file, matching `notifications.controller.ts`, which has the same three lines for
 * the same reason and no shared home for them yet.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw AppError.badRequest('รหัสผู้ใช้ไม่ถูกต้อง');
  return value;
}

@Controller('admin/users')
export class MfaAdminController {
  private readonly logger = new Logger(MfaAdminController.name);

  constructor(private readonly repository: MfaRepository) {}

  @Delete(':userId/mfa')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('users.write')
  async disable(@CurrentScope() scope: Scope, @Param('userId') userId: string): Promise<void> {
    const caller = signedIn(scope).userId;
    const target = requireUuid(userId);

    if (selfActionProblem(caller, target, 'disable-mfa') !== null) {
      throw AppError.conflict(
        'ปิดการยืนยันสองขั้นของตัวเองผ่านหน้าจัดการผู้ใช้ไม่ได้ — ให้ปิดจากหน้าบัญชีของฉัน ซึ่งจะถามรหัสผ่าน',
        { reason: 'self-disable-mfa' },
      );
    }

    await this.repository.disable(target, { actorUserId: caller });

    /*
     * The log line stays, and it is no longer the record — `admin_events` is, written inside
     * the same transaction as the delete. This is for whoever is watching a process in real
     * time, and `warn` rather than `log` because removing somebody's second factor is the
     * one action on this surface that makes an account *easier* to get into.
     */
    this.logger.warn(`second factor of ${target} disabled by ${caller}`);
  }
}
