import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Database } from '@wewin/db';
import { sql } from '@wewin/db/sql';
import { permissions as permissionsTable } from '@wewin/db/schema';

import { DRIZZLE } from '../database/database.tokens';
import { isPermissionCode, PERMISSIONS, PERMISSION_CODES, type PermissionCode } from './permissions';

export interface PermissionSyncReport {
  /** False only when the database could not be reached or the write failed. */
  readonly ok: boolean;
  readonly declared: number;
  /** Declared here, absent from the database until this run put them there. */
  readonly upserted: readonly PermissionCode[];
  /** In the database, unknown to this build. Warned about and left exactly where they are. */
  readonly extra: readonly string[];
  readonly error?: string;
}

/**
 * ⓓ Reconciling the permission catalogue with the database, in one direction.
 *
 * Plan 6(d) is about a specific outage: release N+1 adds `orders.refund`, something goes
 * wrong, and the deploy is rolled back to N. N's code has never heard of `orders.refund`,
 * and if N refuses to boot on "the database holds a permission I do not recognise", the
 * rollback — the thing that was supposed to end the incident — cannot start. So the two
 * directions are not symmetric and must not be treated as one comparison:
 *
 *   missing in the database → upsert it and carry on. Safe by construction: the code that
 *     is about to run is the code that asked for it, so inserting it can only make the
 *     database agree with the process that is starting.
 *
 *   extra in the database → log a warning, change nothing. It is almost always a rollback,
 *     occasionally a colleague's branch, and never something worth an outage. Nothing is
 *     deleted, both because `group_permissions` references `permissions` ON DELETE
 *     RESTRICT and because deleting it would drop somebody's access on the way *back*
 *     up to N+1. The strict version of this check belongs in CI, where it fails a pull
 *     request instead of a deploy.
 *
 * The write is a single `insert … on conflict do update`, so two instances booting at the
 * same moment cannot deadlock or lose to each other, and a third that boots mid-way sees
 * either the old description or the new one.
 *
 * An unreachable database does not stop boot either, for the reason DatabaseService
 * already gives: a database that is still starting is not a reason to crash-loop. The
 * consequence is stated rather than hidden — with no `permissions` rows the guard denies
 * everything that requires one, which is the safe direction, and readiness is already
 * reporting the outage.
 */
@Injectable()
export class PermissionSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PermissionSync');

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
  }

  async sync(): Promise<PermissionSyncReport> {
    try {
      const rows = await this.db.select({ code: permissionsTable.code }).from(permissionsTable);
      const known = new Set(rows.map((row) => row.code));

      const upserted = PERMISSION_CODES.filter((code) => !known.has(code));
      const extra = [...known].filter((code) => !isPermissionCode(code)).sort();

      // One statement. `excluded.description` rather than a per-row update, so a
      // reworded description costs the same as a new permission.
      await this.db
        .insert(permissionsTable)
        .values(PERMISSION_CODES.map((code) => ({ code, description: PERMISSIONS[code] })))
        .onConflictDoUpdate({
          target: permissionsTable.code,
          set: { description: sql`excluded.description` },
        });

      if (upserted.length > 0) {
        this.logger.log(`Added ${upserted.length} permission(s) the database did not have: ${upserted.join(', ')}`);
      }
      if (extra.length > 0) {
        /*
         * Warn, do not throw. This is the rollback case, and this line is the whole
         * difference between an incident that ends and one that does not.
         */
        this.logger.warn(
          `${extra.length} permission(s) in the database are unknown to this build and were left alone ` +
            `(a rollback looks exactly like this): ${extra.join(', ')}`,
        );
      }

      return { ok: true, declared: PERMISSION_CODES.length, upserted, extra };
    } catch (error) {
      const message = describe(error);
      this.logger.error(`Permission sync failed; continuing to boot: ${message}`);
      return { ok: false, declared: PERMISSION_CODES.length, upserted: [], extra: [], error: message };
    }
  }
}

/** Same shape of answer as DatabaseService.describe: a blank driver message is not an explanation. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error) || 'unknown error';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error.message.trim();
  if (message && code) return `${code}: ${message}`;
  return message || code || error.name || 'unknown error';
}
