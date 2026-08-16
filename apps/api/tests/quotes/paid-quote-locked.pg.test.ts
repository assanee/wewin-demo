import { afterAll, describe, expect, it } from 'vitest';
import type { QuoteWire } from '@wewin/contract/quote';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from '../orders/support/lifecycle-app';
import { giveOrderHeldMoney } from '../payments/support/money-fixture';

/**
 * ⛔ THE OWNER'S RULE: once the customer has paid anything, the quotation is closed to edits.
 *
 * ── Why the refusal is at the write and not at the re-issue ─────────────────────
 *
 * A `quote_overrides` row changes nothing a customer owes. The amount they are asked for
 * comes from `orders.grand_total_thb_minor`, which only a submit — and, in future, a
 * re-issue — rewrites. Once money has arrived a re-issue is refused outright, because
 * `ScheduleService.replace` throws on any instalment with an allocation.
 *
 * So if the refusal lived only at the re-issue, staff could still *write* the discount: it
 * would be accepted, stored, shown back in the editor, and be permanently unable to reach the
 * customer. That is the silent trap this whole round has been about, moved to a new place.
 * These tests pin it at the write, where the person deciding is still in the room.
 *
 * ⚠️ Money arrives through `giveOrderHeldMoney`, the payments module's own fixture, and not
 * through hand-written SQL. The first draft of this file inserted `deposit_held` straight
 * into `ledger_entries` and was refused: money lives in `ledger_postings` as two balanced
 * legs, and `ledger_entries_balance` is a deferred constraint trigger that would have caught
 * a single-legged posting anyway. A fixture that writes the ledger the way the application
 * writes it is the only kind worth trusting — a hand-rolled one tests the guard against a
 * ledger shape that never occurs.
 */

const url = process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('a quotation the customer has paid against', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'paid quote sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);

    const draft = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      return (created.body as { id: string }).id;
    };

    /*
     * ⚠️ Submitted, not left a draft — and that is a fact about the money, not about the quote.
     *
     * The first draft of this file put money on a draft order and the database refused it:
     * `order_child_require_status` (0007) locks the parent and rejects a payment slip against
     * anything that is not `awaiting_payment`. So the only shape in which "the customer has
     * paid and staff want to edit the quote" can exist at all is a submitted order — which is
     * exactly the situation the owner described.
     *
     * ⚠️ No `lines` in the body: `quote_already_exists` refuses a browser cart once the quote
     * editor has written lines of its own.
     */
    const submit = async (orderId: string): Promise<void> => {
      const done = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
        token: sales.token,
        body: { contact: { email: `paid-quote-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' } },
      });
      if (done.status !== 200) throw new Error(JSON.stringify(done.body));
    };

    const quote = async (orderId: string): Promise<QuoteWire> => {
      const read = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as QuoteWire;
    };

    /** A charge line, so the quote has something an override can be anchored to. */
    const addCharge = async (orderId: string): Promise<Json> => {
      const current = await quote(orderId);
      return call('POST', `/orders/${orderId}/quote/charges`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: current.quoteRevision },
          customerDescriptionTh: 'ค่าติดตั้ง',
          /*
           * ⚠️ Large on purpose. A slip may not be allocated beyond its instalment
           * (`assert_instalment_allocation`), so the order has to be worth more than the money
           * these tests put on it — ฿100,000 of goods leaves room for every figure below.
           */
          amountText: '100000',
        },
      });
    };

    const setGrandTotalDiscount = async (orderId: string): Promise<Json> => {
      const current = await quote(orderId);
      return call('POST', `/orders/${orderId}/quote/overrides`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: current.quoteRevision },
          anchor: 'grand_total',
          enteredAs: 'percent_discount',
          enteredValueText: '-5%',
          reasonCode: 'volume',
        },
      });
    };

    /** Money in hand: an accepted slip, its allocation, and the ledger entry that records it. */
    const receiveMoney = async (orderId: string, satang: bigint): Promise<void> => {
      await giveOrderHeldMoney(db, {
        orderId,
        grandTotalThbMinor: satang,
        paidThbMinor: satang,
        payerName: 'ลูกค้าทดสอบ',
        payerAccountLast4: '1234',
        reviewerUserId: sales.userId,
      });
    };

    return { call, sales, draft, submit, quote, addCharge, setGrandTotalDiscount, receiveMoney, db };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ refuses a discount once money has been received', async () => {
    const h = await harness();
    const orderId = await h.draft();
    expect((await h.addCharge(orderId)).status).toBe(201);
    await h.submit(orderId);

    /* Before any money, the same write is allowed — otherwise this proves nothing. */
    const allowed = await h.setGrandTotalDiscount(orderId);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    await h.receiveMoney(orderId, 250_000n);

    const refused = await h.setGrandTotalDiscount(orderId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('QUOTE_HAS_MONEY');
  });

  it('⚠️ the refusal names the amount held, so the message is checkable', async () => {
    const h = await harness();
    const orderId = await h.draft();
    await h.addCharge(orderId);
    await h.submit(orderId);
    await h.receiveMoney(orderId, 123_456n);

    const refused = await h.setGrandTotalDiscount(orderId);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('123456');
  });

  it('⛔ closes EVERY quote write, not only overrides', async () => {
    /*
     * The guard sits in `QuotesService.write`, the single wrapper every mutation goes
     * through — adding a line, revising one, removing one, setting an override. A guard on
     * the discount alone would leave a salesperson able to delete a line off a paid order.
     */
    const h = await harness();
    const orderId = await h.draft();
    await h.addCharge(orderId);
    await h.submit(orderId);
    await h.receiveMoney(orderId, 1n);

    const current = await h.quote(orderId);
    const anotherCharge = await h.call('POST', `/orders/${orderId}/quote/charges`, {
      token: h.sales.token,
      body: {
        expect: { quoteRevision: current.quoteRevision },
        customerDescriptionTh: 'ค่าขนส่ง',
        amountText: '500',
      },
    });

    expect(anotherCharge.status, JSON.stringify(anotherCharge.body)).toBe(409);
  });

  it('⚠️ a single satang is enough — "paid something" is not "paid enough"', async () => {
    /*
     * The rule is about whether the company is holding the customer's money at all, not about
     * whether the deposit is satisfied. A threshold would be a second definition of "paid".
     */
    const h = await harness();
    const orderId = await h.draft();
    await h.addCharge(orderId);
    await h.submit(orderId);
    await h.receiveMoney(orderId, 1n);

    expect((await h.setGrandTotalDiscount(orderId)).status).toBe(409);
  });
});
