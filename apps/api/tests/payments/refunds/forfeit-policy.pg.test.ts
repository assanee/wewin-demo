import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { sql } from '@wewin/db/sql';

import { expectRejection } from '../support/money-fixture';

/**
 * The CI check plan 7.8 asks for by name: **count the rows**.
 *
 * > *"ตารางการริบต้องครบทุก (สถานะที่ยกเลิกได้ × ฝ่ายที่ผิด) — ห้ามใช้ `'ANY'` เป็น wildcard …
 * > ต้องมี CI assertion นับแถว และ `redesign` เป็นสถานะที่ยกเลิกได้ อย่าลืม"*
 *
 * A missing cell is a lookup that fails at the worst possible moment — somebody's cancellation,
 * with their money in the company's account — and `order_forfeit_thb_minor()` deliberately
 * *raises* rather than returning zero when it cannot find one. That is the right runtime
 * behaviour and it is discovered at exactly the wrong time, so the count belongs in CI.
 *
 * ── Why the expected number is derived and then also written down ────────────────
 *
 * The coverage set is `SELECT DISTINCT from_status FROM order_status_transitions WHERE
 * to_status = 'cancelled'` — the same source `assert_forfeit_policy_complete()` reads, which is
 * what makes a seventh cancellable status added by migration fail every effective policy at once
 * rather than quietly forfeiting nothing from a status nobody priced.
 *
 * Deriving it *and* asserting it equals six is not redundancy. Derived alone, the test passes
 * when a cancellable status is deleted (nought cells needed, nought found). Written down alone,
 * it says nothing about the policy. Together they say: there are six, and every one is priced.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/**
 * ⚠️ A number, on purpose. `draft · awaiting_payment · production_confirmed · in_production ·
 * awaiting_installation · redesign`. `redesign` is the one plan 7.8 says everybody forgets.
 */
const CANCELLABLE_STATUSES = 6;
const FAULT_PARTIES = 2;

describeWithPg('the forfeit table is dense, or the policy is not usable', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const rows = async <T>(statement: ReturnType<typeof sql>): Promise<readonly T[]> => {
    const result = await db.execute(statement);
    const value = (result as { rows?: unknown }).rows;
    return Array.isArray(value) ? (value as T[]) : [];
  };

  it('has exactly six cancellable statuses, and `redesign` is one of them', async () => {
    const found = await rows<{ from_status: string }>(sql`
      select distinct t.from_status from order_status_transitions t where t.to_status = 'cancelled'
    `);

    expect(found.map((row) => row.from_status).sort()).toEqual([
      'awaiting_installation',
      'awaiting_payment',
      'draft',
      'in_production',
      'production_confirmed',
      'redesign',
    ]);
    expect(found).toHaveLength(CANCELLABLE_STATUSES);
  });

  /** The count itself. Every effective policy, every cell, no exceptions and no wildcard. */
  it('prices every (cancellable status × fault) cell of every effective policy', async () => {
    const policies = await rows<{ id: string; code: string; cells: string }>(sql`
      select p.id, p.code, count(r.*)::text as cells
        from forfeit_policies p
        left join forfeit_policy_rules r on r.policy_id = p.id
       where p.effective_from is not null
       group by p.id, p.code
    `);

    expect(policies.length).toBeGreaterThanOrEqual(1);

    for (const policy of policies) {
      expect(Number(policy.cells), `policy ${policy.code}`).toBe(CANCELLABLE_STATUSES * FAULT_PARTIES);
    }

    /* And named, so a count that happened to be right for the wrong reason still fails. */
    const missing = await rows<{ cell: string }>(sql`
      select p.code || ' ' || cell.from_status || '/' || cell.fault as cell
        from forfeit_policies p
        cross join (
          select distinct t.from_status, f.fault
            from order_status_transitions t
            cross join (values ('customer'), ('company')) as f(fault)
           where t.to_status = 'cancelled'
        ) as cell
       where p.effective_from is not null
         and not exists (
           select 1 from forfeit_policy_rules r
            where r.policy_id = p.id and r.from_status = cell.from_status and r.fault = cell.fault
         )
    `);

    expect(missing.map((row) => row.cell)).toEqual([]);
  });

  /*
   * 🚫 No `'ANY'`. Plan 7.8 forbids it because a wildcard is a value no CHECK can define — is
   * `('in_production','ANY')` beaten by `('in_production','customer')`? by `('ANY','customer')`?
   * Every answer is somebody's refund, and the row looks identical under all three readings.
   *
   * `packages/db`'s own note records that this was reachable until a CHECK was added, because
   * drizzle's `{ enum }` narrows TypeScript and narrows nothing in Postgres. This is the
   * apps/api-side statement of the same fact, and it fails from *this* repository if the CHECK
   * is ever dropped by a migration.
   */
  it('refuses a wildcard row', async () => {
    const [policy] = await rows<{ id: string }>(
      sql`select id from forfeit_policies order by created_at limit 1`,
    );
    expect(policy).toBeDefined();

    await expectRejection(
      db.execute(sql`
        insert into forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp)
        values (${policy?.id ?? ''}::uuid, 'ANY', 'customer', 0)
      `),
      /forfeit_policy_rules_from_status_known/u,
    );

    await expectRejection(
      db.execute(sql`
        insert into forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp)
        values (${policy?.id ?? ''}::uuid, 'in_production', 'ANY', 0)
      `),
      /forfeit_policy_rules_fault_known/u,
    );
  });

  /*
   * Structural, not a default. Aluminium is cut in `in_production`; at the freeze point nothing
   * has been committed, so a customer who confirms and changes their mind five minutes later
   * must not lose what a customer who waited for finished goods loses. Held by CHECK so that it
   * cannot be set by filling in a form.
   */
  it('cannot be made to forfeit anything at the freeze point', async () => {
    const [policy] = await rows<{ id: string }>(
      sql`select id from forfeit_policies order by created_at limit 1`,
    );

    await expectRejection(
      db.execute(sql`
        update forfeit_policy_rules set forfeit_bp = 1
         where policy_id = ${policy?.id ?? ''}::uuid
           and from_status = 'production_confirmed' and fault = 'customer'
      `),
      /forfeit_policy_rules_freeze_point_forfeits_nothing/u,
    );
  });

  /* The company's own mistake is never the customer's cost — in every status. */
  it('cannot be made to forfeit anything on the company’s fault', async () => {
    const [policy] = await rows<{ id: string }>(
      sql`select id from forfeit_policies order by created_at limit 1`,
    );

    await expectRejection(
      db.execute(sql`
        update forfeit_policy_rules set forfeit_bp = 1
         where policy_id = ${policy?.id ?? ''}::uuid
           and from_status = 'in_production' and fault = 'company'
      `),
      /forfeit_policy_rules_company_fault_forfeits_nothing/u,
    );
  });

  /**
   * ⚠️ WHAT IS SHIPPING, STATED OUT LOUD — plan 13: *"ริบ 0 ทุกช่อง = คืนเต็มเสมอ · ปลอดภัยกับ
   * ลูกค้า แต่ต้องรู้ตัวว่ากำลัง ship แบบนี้"*.
   *
   * Every cell of the only policy the migrations create is zero: every cancellation refunds in
   * full, from every status, including one an hour before delivery. That is a real exposure for
   * the company and it is deliberate, because the alternative is an invented percentage
   * presented as though somebody had agreed to it.
   *
   * This test exists so that the day an owner answers, somebody has to come here and change the
   * expectation — which is a conversation, rather than a number that drifted in.
   */
  it('ships forfeiting nothing, anywhere — a plan 13 DEFAULT and not a decision', async () => {
    const nonZero = await rows<{ from_status: string; fault: string; forfeit_bp: number }>(sql`
      select r.from_status, r.fault, r.forfeit_bp
        from forfeit_policy_rules r
        join forfeit_policies p on p.id = r.policy_id
       where p.code = 'plan13_default' and r.forfeit_bp <> 0
    `);

    expect(nonZero).toEqual([]);
  });
});
