import { afterAll, describe, expect, it } from 'vitest';
import type { OrderBillToWire } from '@wewin/contract/forfeit';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from './support/lifecycle-app';

/**
 * ⭐ ผู้ซื้อ — the block a tax document is made out to, which this system has never held.
 *
 * It holds a contact name, an email and a telephone number, and no address anywhere. That is
 * enough for a quotation and not for a document filed with the Revenue Department.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('who the document is made out to', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'bill-to sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    const stranger = await makeActor(db, app, 'a stranger', []);

    const anOrder = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      return (created.body as { id: string }).id;
    };

    const put = (orderId: string, body: unknown, token = sales.token): Promise<Json> =>
      call('PUT', `/orders/${orderId}/bill-to`, { token, body });

    const get = (orderId: string, token = sales.token): Promise<Json> =>
      call('GET', `/orders/${orderId}/bill-to`, { token });

    return { call, sales, stranger, db, anOrder, put, get };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ is absent until somebody fills it in, and null is not an error', async () => {
    const h = await harness();
    const orderId = await h.anOrder();

    const answer = await h.get(orderId);
    expect(answer.status).toBe(200);
    /* An order with no bill-to is the ordinary state, not a 404 — most orders never need one. */
    expect(answer.body).toBeNull();
  });

  it('⭐ takes an individual with an address and no tax id', async () => {
    const h = await harness();
    const orderId = await h.anOrder();

    const written = await h.put(orderId, {
      buyerKind: 'individual',
      legalName: 'สมชาย ใจดี',
      taxId: null,
      branchCode: null,
      addressLine: '99/1 หมู่ 4 ตำบลในเมือง อำเภอเมือง จังหวัดพิษณุโลก',
      postalCode: '65000',
      country: 'TH',
    });

    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect((written.body as OrderBillToWire).legalName).toBe('สมชาย ใจดี');
    expect((await h.get(orderId)).body).toMatchObject({ postalCode: '65000' });
  });

  it('⛔ refuses a company with no tax id — the document would be unusable to them', async () => {
    const h = await harness();
    const orderId = await h.anOrder();

    const refused = await h.put(orderId, {
      buyerKind: 'juristic',
      legalName: 'บริษัท ทดสอบ จำกัด',
      taxId: null,
      branchCode: null,
      addressLine: '1 ถนนทดสอบ',
      postalCode: null,
      country: 'TH',
    });

    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  });

  it('⛔ refuses a tax id that is not thirteen digits', async () => {
    const h = await harness();
    const orderId = await h.anOrder();

    for (const taxId of ['123', '12345678901234', 'abcdefghijklm']) {
      const refused = await h.put(orderId, {
        buyerKind: 'juristic',
        legalName: 'บริษัท ทดสอบ จำกัด',
        taxId,
        branchCode: null,
        addressLine: '1 ถนนทดสอบ',
        postalCode: null,
        country: 'TH',
      });
      expect(refused.status, `${taxId}: ${JSON.stringify(refused.body)}`).toBe(400);
    }
  });

  it('⭐ replaces what was there — one bill-to per order, correctable until it is used', async () => {
    /*
     * Correcting a misspelled company name before the document is issued is the whole point of
     * this table. After issue it changes nothing already printed: a tax document copies the
     * block into its own frozen body, which is what makes an issued document evidence.
     */
    const h = await harness();
    const orderId = await h.anOrder();

    await h.put(orderId, {
      buyerKind: 'juristic',
      legalName: 'บริษัท พิมพ์ผิด จำกัด',
      taxId: '1234567890123',
      branchCode: null,
      addressLine: '1 ถนนทดสอบ',
      postalCode: null,
      country: 'TH',
    });

    await h.put(orderId, {
      buyerKind: 'juristic',
      legalName: 'บริษัท ถูกต้อง จำกัด',
      taxId: '1234567890123',
      branchCode: '00001',
      addressLine: '1 ถนนทดสอบ',
      postalCode: null,
      country: 'TH',
    });

    const now = (await h.get(orderId)).body as OrderBillToWire;
    expect(now.legalName).toBe('บริษัท ถูกต้อง จำกัด');
    expect(now.branchCode).toBe('00001');
  });

  it('🔒 a stranger can neither read nor write somebody else’s', async () => {
    const h = await harness();
    const orderId = await h.anOrder();
    await h.put(orderId, {
      buyerKind: 'individual',
      legalName: 'สมชาย ใจดี',
      taxId: null,
      branchCode: null,
      addressLine: '99/1',
      postalCode: null,
      country: 'TH',
    });

    /* 404 and not 403 — an order that is not yours is one you cannot be told about. */
    expect((await h.get(orderId, h.stranger.token)).status).toBe(404);
    expect(
      (
        await h.put(
          orderId,
          {
            buyerKind: 'individual',
            legalName: 'คนอื่น',
            taxId: null,
            branchCode: null,
            addressLine: '2',
            postalCode: null,
            country: 'TH',
          },
          h.stranger.token,
        )
      ).status,
    ).toBe(404);
  });
});
