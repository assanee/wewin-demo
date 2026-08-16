import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';
import type { ForfeitPolicyWire } from '@wewin/contract/forfeit';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from '../orders/support/lifecycle-app';

/**
 * ⭐ อัตราริบมัดจำ — the screen that answers the last of plan 13's unanswered numbers.
 *
 * Every cell shipped at 0 bp, which is the answer that cannot cheat anybody while nobody has
 * decided. There was no way to change it: the API only ever read this table. These tests are
 * about the way in, and about the two things it must not do — touch an existing contract, or
 * accept a figure the database will refuse.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('publishing a forfeit policy', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const admin = await makeActor(db, app, 'forfeit admin', ['organisation.read', 'organisation.write']);
    const reader = await makeActor(db, app, 'forfeit reader', ['organisation.read']);

    const current = async (): Promise<ForfeitPolicyWire> => {
      const read = await call('GET', '/admin/organisation/forfeit-policy', { token: admin.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as ForfeitPolicyWire;
    };

    const publish = (cells: readonly { fromStatus: string; forfeitBp: number }[], descriptionTh = 'ทดสอบ'): Promise<Json> =>
      call('POST', '/admin/organisation/forfeit-policy', {
        token: admin.token,
        body: { descriptionTh, cells },
      });

    return { call, admin, reader, db, current, publish };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ shows every cell, and says which ones cannot be typed into', async () => {
    const h = await harness();
    const policy = await h.current();

    /* One per cancellable status × fault — the grid the completeness trigger demands. */
    expect(policy.cells.length).toBeGreaterThanOrEqual(12);
    expect(policy.cells.length % 2).toBe(0);

    const company = policy.cells.filter((cell) => cell.fault === 'company');
    expect(company.every((cell) => !cell.editable)).toBe(true);
    expect(company.every((cell) => cell.forfeitBp === 0)).toBe(true);
    expect(company.every((cell) => (cell.whyLockedTh ?? '').length > 0)).toBe(true);

    /*
     * ⛔ The freeze point is locked too, and this is the one a reader is most likely to think is
     * a mistake: the order is frozen at `production_confirmed` but nothing has been cut yet.
     */
    const freeze = policy.cells.find(
      (cell) => cell.fromStatus === 'production_confirmed' && cell.fault === 'customer',
    );
    expect(freeze?.editable).toBe(false);
    /*
     * ⚠️ Asserted on the *shape* of the reason rather than on a material noun. The first version
     * of this sentence named aluminium, on a surface every product shares — the rule the owner
     * gave and two migrations have already enforced. `tests/i18n/no-material-nouns.test.ts` now
     * fails on that class of wording wherever it is written.
     */
    expect(freeze?.whyLockedTh).toContain('ยังไม่เริ่มลงมือทำ');

    /* And the ones a person is here to set. */
    const inProduction = policy.cells.find(
      (cell) => cell.fromStatus === 'in_production' && cell.fault === 'customer',
    );
    expect(inProduction?.editable).toBe(true);
    expect(inProduction?.whyLockedTh).toBeNull();
  });

  it('⭐ publishes a new version, and the new rates are what a cancellation now reads', async () => {
    const h = await harness();
    const before = await h.current();

    const answer = await h.publish(
      [
        { fromStatus: 'in_production', forfeitBp: 5_000 },
        { fromStatus: 'awaiting_installation', forfeitBp: 7_500 },
      ],
      'ทดสอบ: ริบครึ่งหนึ่งเมื่อเริ่มผลิต',
    );

    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const published = answer.body as ForfeitPolicyWire;

    expect(published.code).not.toBe(before.code);
    expect(published.descriptionTh).toBe('ทดสอบ: ริบครึ่งหนึ่งเมื่อเริ่มผลิต');
    expect(rateOf(published, 'in_production')).toBe(5_000);
    expect(rateOf(published, 'awaiting_installation')).toBe(7_500);

    /* ⚠️ A cell nobody sent is 0, not the old policy's figure — publishing writes a whole policy. */
    expect(rateOf(published, 'awaiting_payment')).toBe(0);

    /* And the read comes back the same, so what the screen shows is what the ledger will use. */
    expect(await h.current()).toStrictEqual(published);
  });

  it('⛔ leaves every order already submitted on the policy it agreed to', async () => {
    /*
     * THE REASON THIS IS A NEW VERSION RATHER THAN AN EDIT. An order pins `forfeit_policy_id` at
     * submit; a policy edited in place would change what a customer gets back on a contract they
     * had already signed — months later, on the one screen where somebody is already unhappy.
     */
    const h = await harness();
    const pinned = await h.db.execute(sql`
      select o.id::text as id, p.code
        from orders o join forfeit_policies p on p.id = o.forfeit_policy_id
       limit 1
    `);
    const row = ((pinned as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
    if (row === undefined) return; /* No submitted order in this database; nothing to protect. */

    const codeBefore = String(row['code']);
    expect((await h.publish([{ fromStatus: 'in_production', forfeitBp: 9_000 }])).status).toBe(201);

    const after = await h.db.execute(sql`
      select p.code from orders o join forfeit_policies p on p.id = o.forfeit_policy_id
       where o.id = ${String(row['id'])}::uuid
    `);
    const stillPinned = ((after as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
    expect(String(stillPinned?.['code'])).toBe(codeBefore);
  });

  it('⛔ refuses a figure on a cell the database locks at zero', async () => {
    const h = await harness();

    const freeze = await h.publish([{ fromStatus: 'production_confirmed', forfeitBp: 5_000 }]);
    expect(freeze.status, JSON.stringify(freeze.body)).toBe(400);
    expect(JSON.stringify(freeze.body)).toContain('cell_is_locked');

    /* Zero on that cell is fine — it is what every policy says there. */
    expect((await h.publish([{ fromStatus: 'production_confirmed', forfeitBp: 0 }])).status).toBe(201);
  });

  it('⛔ refuses a status a cancellation cannot happen from', async () => {
    const h = await harness();
    const answer = await h.publish([{ fromStatus: 'delivered', forfeitBp: 1_000 }]);

    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(JSON.stringify(answer.body)).toContain('status_not_cancellable');
  });

  it('⛔ refuses the same status twice, rather than letting one silently win', async () => {
    const h = await harness();
    const answer = await h.publish([
      { fromStatus: 'in_production', forfeitBp: 1_000 },
      { fromStatus: 'in_production', forfeitBp: 9_000 },
    ]);

    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect(JSON.stringify(answer.body)).toContain('cell_sent_twice');
  });

  it('🔒 a reader may look and may not publish', async () => {
    const h = await harness();

    const read = await h.call('GET', '/admin/organisation/forfeit-policy', { token: h.reader.token });
    expect(read.status).toBe(200);

    const refused = await h.call('POST', '/admin/organisation/forfeit-policy', {
      token: h.reader.token,
      body: { descriptionTh: 'ไม่ควรผ่าน', cells: [{ fromStatus: 'in_production', forfeitBp: 1_000 }] },
    });
    expect(refused.status).toBe(403);
  });

  it('⚠️ every published version stays readable, in order', async () => {
    /*
     * The history is the point: a refund argued about next year is priced by the policy that was
     * effective when the order was submitted, and somebody has to be able to read it.
     */
    const h = await harness();
    /*
     * ⚠️ Both statuses asserted. Without this the ordering assertion below passes vacuously
     * when the second publish 500s — which is exactly how a colliding code was found: the
     * generated code stamped to the second, and two publishes inside one second is one
     * impatient double-click.
     */
    expect((await h.publish([{ fromStatus: 'in_production', forfeitBp: 2_500 }], 'ฉบับหนึ่ง')).status).toBe(201);
    expect((await h.publish([{ fromStatus: 'in_production', forfeitBp: 3_500 }], 'ฉบับสอง')).status).toBe(201);

    const rows = await h.db.execute(sql`
      select description_th, effective_from from forfeit_policies order by effective_from desc limit 2
    `);
    const found = (rows as { rows?: readonly Record<string, unknown>[] }).rows ?? [];

    expect(String(found[0]?.['description_th'])).toBe('ฉบับสอง');
    expect(String(found[1]?.['description_th'])).toBe('ฉบับหนึ่ง');
    /* ⚠️ Strictly ordered: `effectiveForfeitPolicy` throws when two share an instant. */
    expect(new Date(String(found[0]?.['effective_from'])).getTime()).toBeGreaterThanOrEqual(
      new Date(String(found[1]?.['effective_from'])).getTime(),
    );
  });
});

const rateOf = (policy: ForfeitPolicyWire, fromStatus: string): number | undefined =>
  policy.cells.find((cell) => cell.fromStatus === fromStatus && cell.fault === 'customer')?.forfeitBp;
