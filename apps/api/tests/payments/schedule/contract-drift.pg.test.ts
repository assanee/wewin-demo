import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';
import { INSTALMENT_BASES, SCHEDULE_CLOSE_REASONS } from '@wewin/db/schema';
import {
  INSTALMENT_BASES_WIRE,
  SCHEDULE_CLOSE_REASONS_WIRE,
} from '@wewin/contract/schedule';

import { SCHEDULE_EDITABLE_STATUSES } from '../../../src/payments/schedule/defaults';

/**
 * The three places the schedule's closed sets are written down, compared member for member.
 *
 * `@wewin/db` is server-only by construction, so the union a browser reads cannot be the
 * union Postgres holds — the contract has to restate it. What is avoidable is *drifting*, and
 * this is the same guard `tests/orders/contract-drift.pg.test.ts` puts on the nine statuses:
 * the day somebody adds a basis without telling the clients is a red test rather than a
 * dashboard rendering a blank chip.
 *
 * The third comparison is the one that needed a database. `SCHEDULE_EDITABLE_STATUSES` in
 * this module and the status list on `order_instalments_live_orders_only` are the same rule
 * stated twice — "a schedule may be written while the quote is still editable" — and only one
 * of them refuses the INSERT. They are read out of `information_schema` rather than out of the
 * migration file, so a later migration that changes the trigger is caught even though the
 * text of `0011_payment_guards.sql` never moves.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

let pool: Pool;
let db: Database;

describe('the closed sets the wire restates', () => {
  it('lists exactly the bases the schema does, in the same order', () => {
    expect([...INSTALMENT_BASES_WIRE]).toEqual([...INSTALMENT_BASES]);
  });

  it('lists exactly the close reasons the schema does', () => {
    expect([...SCHEDULE_CLOSE_REASONS_WIRE]).toEqual([...SCHEDULE_CLOSE_REASONS]);
  });
});

describeWithPg('the statuses a schedule may be written in', () => {
  beforeAll(() => {
    if (url === undefined) throw new Error('unreachable: the suite is skipped without a database');
    pool = createPool(url);
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('matches the list the insert trigger enforces', async () => {
    const result = await db.execute(sql`
      select action_statement
        from information_schema.triggers
       where trigger_name = 'order_instalments_live_orders_only'
       limit 1
    `);

    const [row] = result.rows;
    const statement = typeof row?.['action_statement'] === 'string' ? row['action_statement'] : '';

    expect(statement).not.toBe('');
    /*
     * `redesign` is the member that matters. Plan 7.5(ง) says the recompute service must accept
     * it because a bounce from the factory always lands there — and 7.2 says the fix is usually
     * more expensive, so it is precisely where a schedule has to be re-cut around money that has
     * already arrived.
     */
    expect(statement).toContain(`{${SCHEDULE_EDITABLE_STATUSES.join(',')}}`);
    expect(SCHEDULE_EDITABLE_STATUSES).toContain('redesign');
  });
});
