import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderWire } from '@wewin/contract/order';
import type { QuoteWire } from '@wewin/contract/quote';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from '../orders/support/lifecycle-app';
import { giveOrderHeldMoney } from '../payments/support/money-fixture';

/**
 * ⭐ POST /orders/:id/quote/reissue — the step that was missing between an edit and the customer.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────────
 *
 * Every write in the quote editor moves `quote_lines` and `quote_overrides`. **None of them
 * moves what the customer is asked for** — that is `orders.grand_total_thb_minor`, and until
 * this route existed only a submit ever wrote it. Sales could take ฿20,000 off an order in
 * `awaiting_payment`, watch the editor agree, and the payment page would go on asking for the
 * old figure with the order's own timeline saying nothing had happened.
 *
 * The first test below is that bug, written as the difference between two reads of the same
 * order: after the edit, and after the re-issue.
 *
 * ⚠️ `quote_revised` has been a permitted event type with a customer mail template since
 * migration 0051 and has never had a producer. This is the producer, so the assertion that the
 * event lands is not decoration — it is what makes the customer hear about any of this.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('re-issuing an edited quotation', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'reissue sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);

    const quote = async (orderId: string): Promise<QuoteWire> => {
      const read = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as QuoteWire;
    };

    const order = async (orderId: string): Promise<OrderWire> => {
      const read = await call('GET', `/orders/${orderId}`, { token: sales.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as OrderWire;
    };

    const charge = async (orderId: string, amountText: string, labelTh: string): Promise<Json> => {
      const current = await quote(orderId);
      return call('POST', `/orders/${orderId}/quote/charges`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: current.quoteRevision },
          customerDescriptionTh: labelTh,
          amountText,
        },
      });
    };

    /** A submitted order worth ฿100,000, with one charge line on it. */
    const submittedOrder = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      const orderId = (created.body as { id: string }).id;

      const first = await charge(orderId, '100000', 'ชุดครัวอะลูมิเนียม');
      if (first.status !== 201) throw new Error(JSON.stringify(first.body));

      const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
        token: sales.token,
        body: {
          contact: { email: `reissue-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' },
        },
      });
      if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));
      return orderId;
    };

    const reissue = async (orderId: string, revision?: string): Promise<Json> => {
      const token = revision ?? (await quote(orderId)).quoteRevision;
      return call('POST', `/orders/${orderId}/quote/reissue`, {
        token: sales.token,
        body: { expect: { quoteRevision: token } },
      });
    };

    /** What the row says, which is what every "how much do they owe?" screen reads. */
    const row = async (orderId: string): Promise<{ grand: bigint; deposit: bigint }> => {
      const result = await db.execute(sql`
        select grand_total_thb_minor::text as grand, scheduled_deposit_thb_minor::text as deposit
          from orders where id = ${orderId}::uuid
      `);
      const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
      const found = rows[0];
      return {
        grand: BigInt(String(found?.['grand'] ?? '0')),
        deposit: BigInt(String(found?.['deposit'] ?? '0')),
      };
    };

    const spine = async (orderId: string): Promise<readonly string[]> => {
      const result = await db.execute(sql`
        select event_type from order_events where order_id = ${orderId}::uuid order by seq
      `);
      const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
      return rows.map((entry) => String(entry['event_type']));
    };

    const instalments = async (orderId: string): Promise<readonly bigint[]> => {
      const result = await db.execute(sql`
        select due_thb_minor::text as due from order_instalments
         where order_id = ${orderId}::uuid order by seq
      `);
      const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
      return rows.map((entry) => BigInt(String(entry['due'])));
    };

    return { call, sales, db, quote, order, charge, submittedOrder, reissue, row, spine, instalments };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ carries the edit to the figure the customer is asked for', async () => {
    const h = await harness();
    const orderId = await h.submittedOrder();

    const asQuoted = await h.row(orderId);
    expect(asQuoted.grand).toBeGreaterThan(0n);

    /* Sales adds ฿10,000 of installation. */
    const added = await h.charge(orderId, '10000', 'ค่าติดตั้ง');
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    /*
     * ⛔ THE BUG, as an assertion. The quote now totals ฿10,000 more and the order — every
     * payment screen, the PDF, the outstanding list — still says the old figure. This line is
     * what makes the next one mean something.
     */
    const afterEdit = await h.row(orderId);
    expect(afterEdit.grand).toBe(asQuoted.grand);

    const sent = await h.reissue(orderId);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const afterReissue = await h.row(orderId);
    expect(afterReissue.grand).toBeGreaterThan(asQuoted.grand);

    /* And the response is that same order, so a dashboard need not re-fetch to show the new total. */
    const wire = (sent.body as OrderWire).grandTotalThbMinor;
    expect(wire === null ? null : toBigInt(wire)).toBe(afterReissue.grand);
  });

  it('⭐ appends `quote_revised`, the event that has had a mail template and no producer since 0051', async () => {
    const h = await harness();
    const orderId = await h.submittedOrder();
    await h.charge(orderId, '10000', 'ค่าติดตั้ง');

    expect(await h.spine(orderId)).not.toContain('quote_revised');
    expect((await h.reissue(orderId)).status).toBe(200);

    const events = await h.spine(orderId);
    expect(events).toContain('quote_revised');
    /* Status-less: the order has not moved, and the last status event is still the submit. */
    expect(events.filter((event) => event === 'submitted_for_payment')).toHaveLength(1);
    expect((await h.order(orderId)).status).toBe('awaiting_payment');
  });

  it('⚠️ re-plans the deposit from the new total, rather than leaving the old one standing', async () => {
    /*
     * The difference between `replace` and `recompute`, which is why the service chooses. A
     * deposit planned off the old total is a share nobody agreed: on a quote that grows, the
     * customer is asked for too little up front; on one that shrinks, too much.
     */
    const h = await harness();
    const orderId = await h.submittedOrder();

    const before = await h.row(orderId);
    const beforeDue = await h.instalments(orderId);

    await h.charge(orderId, '50000', 'ค่าติดตั้งและขนส่ง');
    expect((await h.reissue(orderId)).status).toBe(200);

    const after = await h.row(orderId);
    const afterDue = await h.instalments(orderId);

    /* The schedule foots to the new total — the database asserts this too, but say it here. */
    expect(afterDue.reduce((sum, due) => sum + due, 0n)).toBe(after.grand);
    expect(afterDue.reduce((sum, due) => sum + due, 0n)).not.toBe(
      beforeDue.reduce((sum, due) => sum + due, 0n),
    );

    /*
     * ⛔ And the pinned obligation moved with it. `orders.scheduled_deposit_thb_minor` is what a
     * cancellation forfeits against; a row left behind by a re-issue would forfeit a share of a
     * contract that no longer exists.
     */
    expect(after.deposit).not.toBe(before.deposit);
    expect(after.deposit).toBeGreaterThan(0n);
  });

  it('⛔ refuses once the customer has paid anything — the same rule the editor enforces', async () => {
    const h = await harness();
    const orderId = await h.submittedOrder();
    await h.charge(orderId, '10000', 'ค่าติดตั้ง');

    const token = (await h.quote(orderId)).quoteRevision;
    await giveOrderHeldMoney(h.db, {
      orderId,
      grandTotalThbMinor: 250_000n,
      paidThbMinor: 250_000n,
      payerName: 'ลูกค้าทดสอบ',
      payerAccountLast4: '1234',
      reviewerUserId: h.sales.userId,
    });

    const refused = await h.reissue(orderId, token);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('QUOTE_HAS_MONEY');

    /* Nothing moved: a refusal that had written the document first would be worse than none. */
    expect(await h.spine(orderId)).not.toContain('quote_revised');
  });

  it('⚠️ refuses a stale baseline — the colleague who edited while this tab was open', async () => {
    const h = await harness();
    const orderId = await h.submittedOrder();

    const stale = (await h.quote(orderId)).quoteRevision;
    await h.charge(orderId, '10000', 'ค่าติดตั้งที่เพิ่งเพิ่ม');

    const refused = await h.reissue(orderId, stale);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await h.spine(orderId)).not.toContain('quote_revised');

    /* The same request with today's token goes through — so the refusal was the baseline. */
    expect((await h.reissue(orderId)).status).toBe(200);
  });

  it('⛔ refuses a draft, where the route is a submit and not this', async () => {
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });
    const orderId = (created.body as { id: string }).id;
    await h.charge(orderId, '100000', 'ชุดครัวอะลูมิเนียม');

    const refused = await h.reissue(orderId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('order_not_awaiting_payment');
  });
});
