import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@wewin/db/sql';
import type { OrderWire } from '@wewin/contract/order';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor } from './support/lifecycle-app';

/**
 * ⭐ ลูกค้า walk-in — somebody standing at the counter, with no account and no browser session.
 *
 * A member of staff opens the order for them, prices it, and prints or sends the quotation.
 * That has always worked over the API; what it recorded was wrong. `createDraft` wrote
 * `customerUserId: actor.actorUserId`, so the order belonged to **the salesperson** — invisible
 * until somebody asks what a customer has bought before, or that salesperson leaves and their
 * account is closed and the order goes with them.
 *
 * These tests are about who the order belongs to, and about the two things that must not follow
 * from fixing it: the spine still has to say which member of staff acted, and nobody may be
 * handed a credential for the customer's cart.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('an order opened for a walk-in customer', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'walk-in sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);

    const customer = await makeActor(db, app, 'a signed-in customer', []);

    const rowOf = async (orderId: string): Promise<{ customer: string | null; guest: string | null }> => {
      const result = await db.execute(sql`
        select customer_user_id::text as customer, guest_id::text as guest
          from orders where id = ${orderId}::uuid
      `);
      const found = ((result as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
      return {
        customer: found?.['customer'] === null || found?.['customer'] === undefined ? null : String(found['customer']),
        guest: found?.['guest'] === null || found?.['guest'] === undefined ? null : String(found['guest']),
      };
    };

    return { call, sales, customer, db, rowOf };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⛔ does not record the salesperson as the customer', async () => {
    const h = await harness();

    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = (created.body as OrderWire).id;

    const owner = await h.rowOf(orderId);

    /* ⭐ The defect, as an assertion: this used to be the salesperson's own user id. */
    expect(owner.customer).not.toBe(h.sales.userId);
    expect(owner.customer).toBeNull();

    /* An anonymous customer — which is what a walk-in is — and `orders_has_an_owner` is satisfied. */
    expect(owner.guest).not.toBeNull();
  });

  it('⭐ still records which member of staff opened it, on the spine', async () => {
    /*
     * The order belongs to the customer; the *act* belongs to the salesperson. Losing the second
     * while fixing the first would trade one wrong answer for another — "who opened this?" is
     * asked at least as often as "whose is it?".
     */
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });
    const orderId = (created.body as OrderWire).id;

    const events = await h.db.execute(sql`
      select event_type, actor_kind, actor_user_id::text as actor
        from order_events where order_id = ${orderId}::uuid order by seq
    `);
    const first = ((events as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];

    expect(String(first?.['event_type'])).toBe('created');
    expect(String(first?.['actor_kind'])).toBe('staff');
    expect(String(first?.['actor'])).toBe(h.sales.userId);
  });

  it('🔒 hands the salesperson no cart credential of the customer’s', async () => {
    /*
     * The guest row is minted for the customer, not for the browser at the counter. A
     * `Set-Cookie` here would put the walk-in's cart into the salesperson's own browser — every
     * subsequent visit to the shop's storefront on that machine would carry it.
     */
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });

    expect(created.headers.get('set-cookie')).toBeNull();
  });

  it('⭐ staff can quote it and send it, which is the point of the counter', async () => {
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.sales.token, body: {} });
    const orderId = (created.body as OrderWire).id;

    const quote = await h.call('GET', `/orders/${orderId}/quote`, { token: h.sales.token });
    expect(quote.status).toBe(200);

    const charged = await h.call('POST', `/orders/${orderId}/quote/charges`, {
      token: h.sales.token,
      body: {
        expect: { quoteRevision: (quote.body as { quoteRevision: string }).quoteRevision },
        customerDescriptionTh: 'งานหน้าร้าน',
        amountText: '25000',
      },
    });
    expect(charged.status, JSON.stringify(charged.body)).toBe(201);

    const submitted = await h.call('POST', `/orders/${orderId}/transitions/awaiting_confirmation`, {
      token: h.sales.token,
      body: { contact: { name: 'ลูกค้าหน้าร้าน', phone: '+66812345678' } },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    /* ⚠️ No email — a walk-in may leave a telephone number and nothing else. */
    expect((submitted.body as OrderWire).contact.email).toBeNull();
  });

  it('⚠️ a customer opening their own order is unaffected', async () => {
    /*
     * The change is scoped to a staff actor. A signed-in customer still owns their own cart, or
     * the whole funnel would have been rewritten by a fix aimed at the counter.
     */
    const h = await harness();
    const created = await h.call('POST', '/orders', { token: h.customer.token, body: {} });
    const orderId = (created.body as OrderWire).id;

    expect((await h.rowOf(orderId)).customer).toBe(h.customer.userId);
  });
});
