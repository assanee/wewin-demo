import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { SLIP_ATTACHABLE_STATUSES } from '../../../src/payments/slips/attachable';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE SERVICE'S LIST AND THE TRIGGER'S LIST, COMPARED AGAINST THE LIVE DATABASE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SLIP_ATTACHABLE_STATUSES` is a mirror. `payment_slips_live_orders_only` is the definition —
 * it fires on the INSERT, so it is the only copy a customer's money can actually be refused
 * by — and the two say the same rule in two languages, only one of which stops the write.
 *
 * ⚠️ **Read out of `pg_trigger`, and not out of a migration file, and the distinction is the
 * whole point.** Migrations are append-only: `0011_payment_guards.sql` still contains the
 * narrower literal it wrote and always will, and `0046_slips_after_delivery.sql` replaced the
 * trigger without touching it. The *effective* list is whatever the last migration to write
 * this trigger wrote, and the only authority on that is the server. A test that grepped a
 * migration would have gone green against a database it disagreed with — which is exactly the
 * class of failure this file exists to catch. Same posture as
 * `payments/schedule/contract-drift.pg.test.ts`, which does this for the instalment trigger.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

let pool: Pool;
let db: Database;

describeWithPg('the statuses a slip may be attached to', () => {
  beforeAll(() => {
    if (url === undefined) throw new Error('unreachable: the suite is skipped without a database');
    pool = createPool(url);
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('matches the list the insert trigger enforces, member for member', async () => {
    const result = await db.execute(sql`
      select pg_get_triggerdef(oid) as definition
        from pg_trigger
       where tgname = 'payment_slips_live_orders_only'
       limit 1
    `);

    const [row] = result.rows;
    const definition = typeof row?.['definition'] === 'string' ? row['definition'] : '';

    expect(definition, 'the trigger must exist at all').not.toBe('');

    const literal = /'\{([a-z_,]+)\}'/u.exec(definition);
    expect(literal, 'the trigger should still pass its statuses as a text[] literal').not.toBeNull();

    const enforced = (literal?.[1] ?? '').split(',');

    /*
     * ⚠️ Compared as SETS and not in order. The trigger's literal is written in the migration's
     * own order and the constant in the service's; `= ANY(...)` does not care, and a test that
     * did would fail on a reordering that changes no behaviour — which is how a drift guard
     * gets deleted for being noisy.
     */
    expect([...enforced].sort()).toStrictEqual([...SLIP_ATTACHABLE_STATUSES].sort());
  });

  it('⭐ enforces `delivered`, and still refuses `cancelled` and `superseded`', async () => {
    /*
     * Named individually, because the set comparison above passes for any pair of lists that
     * agree — including two that agree on being wrong. These are the three memberships this
     * round decided, and the two refusals are the guard that must not have been weakened while
     * the third was opened.
     */
    const result = await db.execute(sql`
      select pg_get_triggerdef(oid) as definition
        from pg_trigger
       where tgname = 'payment_slips_live_orders_only'
       limit 1
    `);
    const definition = String(result.rows[0]?.['definition'] ?? '');
    const enforced = new Set((/'\{([a-z_,]+)\}'/u.exec(definition)?.[1] ?? '').split(','));

    expect(enforced.has('delivered'), 'a delivered order must be able to receive a slip').toBe(
      true,
    );
    expect(enforced.has('cancelled'), 'a cancelled order must still refuse a slip').toBe(false);
    expect(enforced.has('superseded'), 'a superseded order must still refuse a slip').toBe(false);
    expect(enforced.has('draft'), 'a cart has nothing to pay against').toBe(false);
  });
});
