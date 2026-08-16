import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from './support/lifecycle-app';
import { giveOrderHeldMoney } from '../payments/support/money-fixture';

/**
 * ⭐ การระบุยอดมัดจำ — a deposit chosen for one order, which is half of what the owner asked
 * staff to be able to do while a quotation is still unconfirmed.
 *
 * The company setting (`organisation_profile.deposit_bp`) applied to every order at submit and
 * nothing could move it on a single one. Three things had to be true for this to be more than a
 * column: the schedule is re-cut so the customer is actually asked for the new figure; the pinned
 * obligation moves with it, because that is what a cancellation forfeits against; and a later
 * re-issue does not quietly revert it — which it did in the design, and which the last test here
 * is about.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('the deposit for one order', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'deposit sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);

    /** An order worth ฿100,000 + VAT, sitting unconfirmed — where staff do this work. */
    const submitted = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      const orderId = (created.body as { id: string }).id;

      const quote = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      const charge = await call('POST', `/orders/${orderId}/quote/charges`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: (quote.body as { quoteRevision: string }).quoteRevision },
          customerDescriptionTh: 'ชุดครัวอะลูมิเนียม',
          amountText: '100000',
        },
      });
      if (charge.status !== 201) throw new Error(JSON.stringify(charge.body));

      const done = await call('POST', `/orders/${orderId}/transitions/awaiting_confirmation`, {
        token: sales.token,
        body: {
          contact: { email: `deposit-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' },
        },
      });
      if (done.status !== 200) throw new Error(JSON.stringify(done.body));
      return orderId;
    };

    const setDeposit = (orderId: string, depositBp: number): Promise<Json> =>
      call('PUT', `/orders/${orderId}/deposit`, { token: sales.token, body: { depositBp } });

    const row = async (orderId: string): Promise<{ deposit: bigint; authored: number | null; grand: bigint }> => {
      const result = await db.execute(sql`
        select scheduled_deposit_thb_minor::text as deposit,
               deposit_bp_authored,
               grand_total_thb_minor::text as grand
          from orders where id = ${orderId}::uuid
      `);
      const found = ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      return {
        deposit: BigInt(String(found?.['deposit'] ?? '0')),
        authored:
          found?.['deposit_bp_authored'] === null || found?.['deposit_bp_authored'] === undefined
            ? null
            : Number(found['deposit_bp_authored']),
        grand: BigInt(String(found?.['grand'] ?? '0')),
      };
    };

    const instalments = async (orderId: string): Promise<readonly bigint[]> => {
      const result = await db.execute(sql`
        select due_thb_minor::text as due from order_instalments
         where order_id = ${orderId}::uuid order by seq
      `);
      return ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? []).map((entry) =>
        BigInt(String(entry['due'])),
      );
    };

    const companyDepositBp = async (): Promise<number> => {
      const result = await db.execute(sql`select deposit_bp from organisation_profile where id = 1`);
      const found = ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      return Number(found?.['deposit_bp'] ?? 0);
    };

    /*
     * ⚠️ The company standard is a fixture input here, not a given. This database ships
     * `deposit_bp = 10000` (payment in full), where "raise the deposit" has nowhere to go —
     * which is a fact about the setting rather than about the feature, and a test that read it
     * and shrugged would prove nothing on the day somebody changed it.
     */
    const setCompanyDeposit = async (bp: number): Promise<void> => {
      await db.execute(sql`update organisation_profile set deposit_bp = ${bp} where id = 1`);
    };

    const allowBelowFloor = async (allowed: boolean): Promise<void> => {
      await db.execute(sql`
        update organisation_profile set deposit_below_floor_allowed = ${allowed} where id = 1
      `);
    };

    return {
      call,
      sales,
      db,
      submitted,
      setDeposit,
      row,
      instalments,
      companyDepositBp,
      setCompanyDeposit,
      allowBelowFloor,
    };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ raises the deposit, re-cuts the schedule, and moves the pinned obligation with it', async () => {
    const h = await harness();
    const restore = await h.companyDepositBp();
    await h.setCompanyDeposit(3_000);
    const orderId = await h.submitted();

    const before = await h.row(orderId);
    const raised = 5_000;

    const answer = await h.setDeposit(orderId, raised);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const after = await h.row(orderId);
    expect(after.authored).toBe(raised);
    expect(after.deposit).toBeGreaterThan(before.deposit);

    /*
     * ⛔ The schedule, not only the column. A pinned obligation the customer is never asked for
     * is the shape of the ฿13,805.57 the red team found: two numbers describing one contract,
     * agreeing with nothing.
     */
    const due = await h.instalments(orderId);
    expect(due[0]).toBe(after.deposit);
    expect(due.reduce((sum, amount) => sum + amount, 0n)).toBe(after.grand);

    await h.setCompanyDeposit(restore);
  });

  it('⛔ refuses below the company standard while the setting says staff may not', async () => {
    const h = await harness();
    await h.allowBelowFloor(false);
    const orderId = await h.submitted();
    const company = await h.companyDepositBp();

    const refused = await h.setDeposit(orderId, Math.max(1, company - 1_000));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('deposit_below_company_floor');

    /* Nothing moved: a refusal that had re-cut the schedule first would be worse than none. */
    expect((await h.row(orderId)).authored).toBeNull();
  });

  it('⚠️ with the setting on, the refusal moves to the authority ceiling — not to this rule', async () => {
    /*
     * The owner's decision was that "may staff go below?" is a setting rather than a rule in
     * code. Switching it on does not make the concession free: the gap is a `cashflow`
     * concession, `authority_limits` ships empty, and the system fails closed. What changes is
     * *which* refusal a salesperson gets, and this pins that difference — otherwise the setting
     * could do nothing at all and every test here would still pass.
     */
    const h = await harness();
    await h.allowBelowFloor(true);
    const orderId = await h.submitted();
    const company = await h.companyDepositBp();

    const answer = await h.setDeposit(orderId, Math.max(1, company - 1_000));
    expect(JSON.stringify(answer.body)).not.toContain('deposit_below_company_floor');

    await h.allowBelowFloor(false);
  });

  it('⛔ refuses once the customer has paid — the same rule the quote editor enforces', async () => {
    const h = await harness();
    const orderId = await h.submitted();

    /* Confirm, then take money: a deposit cannot be re-cut under a payment. */
    await h.call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      token: h.sales.token,
      body: {},
    });

    await giveOrderHeldMoney(h.db, {
      orderId,
      grandTotalThbMinor: 250_000n,
      paidThbMinor: 250_000n,
      payerName: 'ลูกค้าทดสอบ',
      payerAccountLast4: '1234',
      reviewerUserId: h.sales.userId,
    });

    const refused = await h.setDeposit(orderId, 10_000);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('QUOTE_HAS_MONEY');
  });

  it('⭐ survives a re-issue — the reversion the design would have shipped', async () => {
    /*
     * ⛔ THE DEFECT THIS TEST EXISTS FOR. `reissueQuote` re-plans the schedule, and it read the
     * *company* deposit to do it. So a deposit staff had authored — and the forfeit ceiling
     * derived from it — was silently reverted the next time anybody edited the quotation and
     * pressed send. Nothing on any screen would have said so; the number simply went back.
     */
    const h = await harness();
    const restore = await h.companyDepositBp();
    await h.setCompanyDeposit(3_000);
    const orderId = await h.submitted();
    const raised = 5_000;

    expect((await h.setDeposit(orderId, raised)).status).toBe(200);

    /* An edit, then a re-issue — the ordinary working day this defect was hiding in. */
    const quote = await h.call('GET', `/orders/${orderId}/quote`, { token: h.sales.token });
    const revision = (quote.body as { quoteRevision: string }).quoteRevision;
    await h.call('POST', `/orders/${orderId}/quote/charges`, {
      token: h.sales.token,
      body: { expect: { quoteRevision: revision }, customerDescriptionTh: 'ค่าติดตั้ง', amountText: '10000' },
    });

    const next = await h.call('GET', `/orders/${orderId}/quote`, { token: h.sales.token });
    const reissued = await h.call('POST', `/orders/${orderId}/quote/reissue`, {
      token: h.sales.token,
      body: { expect: { quoteRevision: (next.body as { quoteRevision: string }).quoteRevision } },
    });
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(200);

    const after = await h.row(orderId);
    expect(after.authored).toBe(raised);
    /* And the money followed the share: the deposit is the new total's, at the chosen rate. */
    expect(after.deposit).toBe((after.grand * BigInt(raised) + 5_000n) / 10_000n);

    await h.setCompanyDeposit(restore);
  });
});
