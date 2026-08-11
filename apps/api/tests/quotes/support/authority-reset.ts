import type { Database } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

/**
 * Empty the ceiling table for one group — the teardown that used to be `db.delete(...)`.
 *
 * ⚠️ It needs a bypass because it is doing the thing the feature forbids. Migration 0038 put
 * `authority_limits_block_delete` in front of every `DELETE` on that table: a ceiling records
 * who granted a role its authority, so revocation is `revoked_at` and the row survives. Four
 * suites nevertheless have to leave the table **genuinely empty**, because "fail closed" is a
 * claim about a table with no rows in it and `packages/db/tests/quote.test.ts` plus
 * `authority.pg.test.ts`'s own opening tests assert exactly that. A revoked row would satisfy
 * `ceiling()` — which filters on `revoked_at IS NULL` — and would still be a row, so it would
 * quietly change what those assertions mean.
 *
 * `session_replication_role = replica` is this repository's sanctioned bypass for precisely
 * this situation (0022_mfa_guards.sql; `erase_user()` uses it three times), and it is
 * **transaction-scoped**, hence `SET LOCAL` inside `db.transaction`. It disables user triggers
 * for the statement, which here is the block-delete guard and nothing else that matters: this
 * table has no other trigger and nothing has a foreign key pointing at it.
 *
 * ⚠️ It is test-only, and deliberately not exported from `src`. Production has one way to take
 * a ceiling away and it writes a history row; a second path that skipped the history is the
 * failure `authority_limit_changes_append_only` cannot catch.
 */
export async function purgeAuthorityLimits(db: Database, groupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql`delete from authority_limits where group_id = ${groupId}::uuid`);
  });
}
