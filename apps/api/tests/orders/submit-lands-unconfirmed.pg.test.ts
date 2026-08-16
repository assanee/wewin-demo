import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';
import type { OrderWire } from '@wewin/contract/order';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from './support/lifecycle-app';

/**
 * ⭐ THE FLOW THE OWNER ASKED FOR, AS FOUR FACTS.
 *
 *   "หลังจากที่ลูกค้าขอใบเสนอราคา ให้ยังอยู่ในสถานะที่ยังไม่ยืนยันได้ไหม จนกว่าเจ้าหน้าที่จะเข้ามา
 *    ปรับปรุงข้อมูล และยืนยันอีกที ... ลูกค้าจึงจะสามารถชำระได้ หรือ ... ข้ามไปที่ขั้นตอนเริ่มผลิต
 *    เลยแล้วค่อยชำระทีเดียว"
 *
 * Everything else in this round is plumbing for these: a submit stops one status short of
 * payable; a customer cannot pay until staff say so; staff may instead release production
 * against an unpaid invoice, and when they do the system says so rather than claiming a
 * payment was confirmed.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('a quotation request, before anybody has agreed', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'confirmation sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);

    const submit = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      const orderId = (created.body as { id: string }).id;

      const current = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      const charge = await call('POST', `/orders/${orderId}/quote/charges`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: (current.body as { quoteRevision: string }).quoteRevision },
          customerDescriptionTh: 'ชุดครัวอะลูมิเนียม',
          amountText: '100000',
        },
      });
      if (charge.status !== 201) throw new Error(JSON.stringify(charge.body));

      const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_confirmation`, {
        token: sales.token,
        body: {
          contact: { email: `confirm-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' },
        },
      });
      if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));
      return orderId;
    };

    const move = (orderId: string, to: string, body: unknown = {}): Promise<Json> =>
      call('POST', `/orders/${orderId}/transitions/${to}`, { token: sales.token, body });

    const statusOf = async (orderId: string): Promise<string> => {
      const read = await call('GET', `/orders/${orderId}`, { token: sales.token });
      return (read.body as OrderWire).status;
    };

    const spine = async (orderId: string): Promise<readonly string[]> => {
      const result = await db.execute(sql`
        select event_type from order_events where order_id = ${orderId}::uuid order by seq
      `);
      const rows = (result as { rows?: readonly Record<string, unknown>[] }).rows ?? [];
      return rows.map((row) => String(row['event_type']));
    };

    return { call, sales, db, submit, move, statusOf, spine };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ lands in `awaiting_confirmation`, not in "please transfer money"', async () => {
    const h = await harness();
    const orderId = await h.submit();

    expect(await h.statusOf(orderId)).toBe('awaiting_confirmation');
    /* An order number and a pinned document all the same: the customer has a real quotation. */
    const order = (await h.call('GET', `/orders/${orderId}`, { token: h.sales.token }))
      .body as OrderWire;
    expect(order.orderNo).not.toBeNull();
    expect(order.documentRevision).toBe(1);
  });

  it('⛔ refuses a payment slip until staff confirm — in the database, not on the screen', async () => {
    /*
     * `payment_slips_live_orders_only` (0055 deliberately left it alone) is what makes the
     * hidden button on the storefront a rule rather than a decoration: an old link, a forwarded
     * email or a stale QR cannot put money against a price nobody has agreed.
     */
    const h = await harness();
    const orderId = await h.submit();

    /*
     * ⚠️ Attempted at the table rather than through the upload route, deliberately: the route
     * would refuse a malformed body first and the test would pass without ever reaching the
     * rule. What is being asserted is that **no writer at all** can put a slip here.
     */
    const attached = h.db.execute(sql`
      insert into payment_slips (order_id, status, amount_thb_minor, transferred_at, storage_key)
      values (${orderId}::uuid, 'submitted', 1000, now(), 'probe/never-stored')
    `);

    await expect(attached).rejects.toThrow();
  });

  it('⭐ becomes payable when staff confirm, and the customer is told', async () => {
    const h = await harness();
    const orderId = await h.submit();

    const confirmed = await h.move(orderId, 'awaiting_payment');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await h.statusOf(orderId)).toBe('awaiting_payment');
    expect(await h.spine(orderId)).toContain('quotation_confirmed');

    const mail = await h.db.execute(sql`
      select template_key from notifications
       where order_id = ${orderId}::uuid and template_key = 'order.quotation_confirmed.customer'
    `);
    expect(((mail as { rows?: readonly unknown[] }).rows ?? []).length).toBe(1);
  });

  it('⛔ BUG B: releasing production unpaid is recorded as itself, not as a payment', async () => {
    /*
     * The owner asks for this move. What was wrong is that it went onto the spine as
     * `payment_confirmed` and mailed the customer "เราตรวจสอบและยืนยันการชำระเงินของท่านแล้ว"
     * with ฿0 received. One (from, to) pair carries exactly one event type, so the honest act
     * needed an edge of its own — and the `reason` is required, because releasing the factory
     * against an unpaid invoice is a decision somebody must be able to defend later.
     */
    const h = await harness();
    const orderId = await h.submit();

    const noReason = await h.move(orderId, 'production_confirmed');
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(400);

    const authorised = await h.move(orderId, 'production_confirmed', {
      reason: 'ลูกค้าเป็นคู่ค้าประจำ ตกลงวางบิลปลายเดือน',
    });
    expect(authorised.status, JSON.stringify(authorised.body)).toBe(200);

    const events = await h.spine(orderId);
    expect(events).toContain('production_authorised_unpaid');
    /* ⛔ The whole point: nothing on this order claims a payment was confirmed. */
    expect(events).not.toContain('payment_confirmed');

    const mails = await h.db.execute(sql`
      select template_key from notifications where order_id = ${orderId}::uuid
    `);
    const keys = ((mails as { rows?: readonly Record<string, unknown>[] }).rows ?? []).map((row) =>
      String(row['template_key']),
    );
    expect(keys).toContain('order.production_authorised_unpaid.customer');
    expect(keys).not.toContain('order.payment_confirmed.customer');
  });

  it('⚠️ a browser tab loaded before the deploy still submits — the shim, with an end date', async () => {
    /*
     * `apps/web/src/lib/quote/submit.ts` posts the destination by name, so a page open at the
     * moment of the deploy asks for `awaiting_payment` from a draft. The row is gone; without
     * the rewrite in `OrdersService.transition` that customer would get a 409 about statuses on
     * their primary action. It lands where a submit lands, and nowhere else.
     */
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });
    const orderId = (created.body as { id: string }).id;

    const current = await h.call('GET', `/orders/${orderId}/quote`, { token: h.sales.token });
    await h.call('POST', `/orders/${orderId}/quote/charges`, {
      token: h.sales.token,
      body: {
        expect: { quoteRevision: (current.body as { quoteRevision: string }).quoteRevision },
        customerDescriptionTh: 'ชุดครัวอะลูมิเนียม',
        amountText: '100000',
      },
    });

    const oldWay = await h.move(orderId, 'awaiting_payment', {
      contact: { email: `stale-tab-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' },
    });

    expect(oldWay.status, JSON.stringify(oldWay.body)).toBe(200);
    expect(await h.statusOf(orderId)).toBe('awaiting_confirmation');
  });

  it('⚠️ staff may pull a confirmed order back while nothing has been paid', async () => {
    const h = await harness();
    const orderId = await h.submit();
    expect((await h.move(orderId, 'awaiting_payment')).status).toBe(200);

    const reopened = await h.move(orderId, 'awaiting_confirmation');
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(await h.statusOf(orderId)).toBe('awaiting_confirmation');

    /*
     * Without this edge an order that had been confirmed could never reach the unpaid
     * authorisation, and every order already in flight when this shipped would have lost that
     * for good — which is why it exists rather than being left for later.
     */
    expect(await h.spine(orderId)).toContain('quotation_reopened');
  });
});
