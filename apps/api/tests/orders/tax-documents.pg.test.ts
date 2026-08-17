import { afterAll, describe, expect, it } from 'vitest';
import type { TaxDocumentWire } from '@wewin/contract/forfeit';

import { createPgHarness } from '../support/pg-harness';
import { client, makeActor, type Json } from './support/lifecycle-app';
import { liveLine } from '../payments/support/payments-app';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ออกเอกสารภาษี — raising a numbered document against an order.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ The property that shapes every test here: an issued document cannot be corrected. It is
 * frozen by a trigger that compares every column, so the only remedy for a wrong one is a credit
 * note and a new number. Everything this service refuses, it must refuse BEFORE it takes a
 * number — and a refusal that arrives after is a hole in a series somebody has to explain.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

describe.skipIf(url === undefined || url === '')('raising a tax document', () => {
  const base = createPgHarness(url ?? '');

  const harness = async () => {
    const { app, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'tax doc sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
      'organisation.read',
      'organisation.write',
    ]);

    /**
     * Switch the feature on the way a company would, through its own settings endpoint.
     *
     * ⚠️ Asserts its own status. The first draft did not, and every refusal it was meant to set
     * up arrived for the wrong reason — the endpoint was at a path that did not exist and the
     * tests read "ยังไม่ได้เปิดใช้เอกสารภาษี" as though it were the answer they were testing.
     */
    const settings = async (over: Record<string, boolean> = {}): Promise<Json> => {
      const written = await call('PUT', '/admin/organisation/tax-documents', {
        token: sales.token,
        body: {
          enabled: true,
          onInstalment: true,
          onDelivery: false,
          combinedReceipt: true,
          invoiceOnDemand: false,
          abbreviatedAllowed: false,
          ...over,
        },
      });
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      return written;
    };

    /* A company with no name of its own cannot issue anything; every test needs one. */
    const sellerProfile = async (): Promise<void> => {
      await db.execute(
        `update organisation_profile
            set legal_name_th = 'บริษัท วีวิน180 จำกัด',
                tax_id = '0105560000001',
                address_th = '1 ถนนทดสอบ อำเภอเมือง จังหวัดพิษณุโลก 65000'
          where id = 1` as never,
      );
    };

    const anOrder = async (): Promise<string> => {
      const created = await call('POST', '/orders', { token: sales.token, body: {} });
      return (created.body as { id: string }).id;
    };

    /**
     * An order carried far enough to have a FROZEN quotation, which is what a tax document
     * copies. Nothing shorter will do: `order_documents` is written at submit, and every test
     * about the body rather than about a refusal needs one to exist.
     *
     * ⚠️ It carries a real PRODUCT LINE as well as a charge, and the difference is not
     * decoration. The first version added only a charge, so `document.lines` was empty on every
     * order these tests built — and the whole goods path of `linesFrom()` went unexecuted while
     * the suite reported green. Forcing every goods amount to '0' changed no result at all,
     * which is how that was found.
     */
    const aSubmittedOrder = async (): Promise<string> => {
      const orderId = await anOrder();

      const beforeLine = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      const added = await call('POST', `/orders/${orderId}/quote/lines`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: (beforeLine.body as { quoteRevision: string }).quoteRevision },
          line: await liveLine(call),
        },
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);

      const current = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      const charge = await call('POST', `/orders/${orderId}/quote/charges`, {
        token: sales.token,
        body: {
          expect: { quoteRevision: (current.body as { quoteRevision: string }).quoteRevision },
          customerDescriptionTh: 'ชุดครัวสั่งทำ',
          amountText: '100000',
        },
      });
      expect(charge.status, JSON.stringify(charge.body)).toBe(201);

      const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_confirmation`, {
        token: sales.token,
        body: {
          contact: { email: `taxdoc-${orderId.slice(0, 8)}@probe.invalid`, name: 'ลูกค้าทดสอบ' },
        },
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      return orderId;
    };

    const billTo = (orderId: string): Promise<Json> =>
      call('PUT', `/orders/${orderId}/bill-to`, {
        token: sales.token,
        body: {
          buyerKind: 'juristic',
          legalName: 'บริษัท ผู้ซื้อ จำกัด',
          taxId: '0105560123456',
          branchCode: null,
          addressLine: '99/1 ถนนทดสอบ',
          postalCode: '65000',
          country: 'TH',
        },
      });

    const issue = (orderId: string, body: unknown, token = sales.token): Promise<Json> =>
      call('POST', `/orders/${orderId}/tax-documents`, { token, body });

    const list = (orderId: string, token = sales.token): Promise<Json> =>
      call('GET', `/orders/${orderId}/tax-documents`, { token });

    return {
      app, call, sales, db, settings, sellerProfile, anOrder, aSubmittedOrder, billTo,
      issue, list,
    };
  };

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ an order with no documents lists none, and that is not an error', async () => {
    const h = await harness();
    const orderId = await h.anOrder();

    const answer = await h.list(orderId);
    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual([]);
  });

  it('⛔ refuses everything while the feature is switched off', async () => {
    /*
     * The first gate, and the one that matters most on a fresh installation: a company that has
     * not sat down with its bookkeeper must not start numbering documents because an endpoint
     * was reachable.
     */
    const h = await harness();
    await h.settings({ enabled: false, onInstalment: false });
    const orderId = await h.anOrder();

    const refused = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('ยังไม่ได้เปิดใช้เอกสารภาษี');
  });

  it('⛔ refuses a kind whose own switch is off, even with the feature on', async () => {
    const h = await harness();
    await h.settings({ invoiceOnDemand: false, abbreviatedAllowed: false });
    const orderId = await h.anOrder();

    for (const kind of ['invoice', 'abbreviated_tax_invoice']) {
      const refused = await h.issue(orderId, { kind, instalmentId: null });
      expect(refused.status, `${kind}: ${JSON.stringify(refused.body)}`).toBe(422);
      expect(JSON.stringify(refused.body), kind).toContain('ยังไม่ได้เปิดใช้ในหน้าตั้งค่า');
    }
  });

  it('⛔ refuses a credit note raised on its own — it is what voiding produces', async () => {
    /*
     * `tax_documents_credit_note_cites` refuses one that names no document, and there is no
     * parameter here through which a caller could name one. Striking out and crediting are one
     * act; letting a caller do half of it would produce a credit note against nothing.
     */
    const h = await harness();
    await h.settings();
    const orderId = await h.anOrder();

    const refused = await h.issue(orderId, { kind: 'credit_note', instalmentId: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('ใบลดหนี้');
  });

  it('⛔ refuses a full tax invoice with no buyer block — the buyer could not use it', async () => {
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();

    const refused = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('ข้อมูลผู้ซื้อ');
  });

  it('⛔ refuses an order that never had a quotation', async () => {
    /*
     * A tax document copies the *frozen* agreement, not the live cart. An order with nothing
     * frozen has no agreed figures to copy, and inventing them from the catalogue would let a
     * price change between quotation and invoice without anybody choosing it.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.anOrder();
    await h.billTo(orderId);

    const refused = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('ใบเสนอราคา');
  });

  it('⭐ raises one, numbers it, freezes the body, and puts it on the order timeline', async () => {
    /*
     * The happy path, and every property this feature was built for in one place. Split into
     * separate `it`s each would need its own submitted order — four HTTP round trips apiece —
     * to assert facts about the same single document.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    const raised = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    const document = raised.body as TaxDocumentWire;

    /* ⭐ Numbered by the database, in the series that belongs to this kind, in the Buddhist year. */
    expect(document.documentNo).toMatch(/^TAX-\d{4}-\d{5}$/u);
    expect(document.documentNo).toContain(String(new Date().getFullYear() + 543));
    expect(document.status).toBe('issued');

    /* ⭐ The body is a COPY. Both parties are written into it, not referenced. */
    expect(document.body.seller.legalName).toBe('บริษัท วีวิน180 จำกัด');
    expect(document.body.buyer?.legalName).toBe('บริษัท ผู้ซื้อ จำกัด');
    expect(document.body.buyer?.taxId).toBe('0105560123456');
    /* `null` branch code prints as สำนักงานใหญ่; the Thai word is never stored. */
    expect(document.body.buyer?.branchCode).toBeNull();
    expect(document.body.subject).toStrictEqual({ kind: 'whole_order' });

    /* ⭐ And it foots. A document whose total disagrees with its parts is not evidence. */
    expect(BigInt(document.grandTotalThbMinor)).toBe(
      BigInt(document.netThbMinor) + BigInt(document.vatThbMinor),
    );
    expect(BigInt(document.grandTotalThbMinor)).toBeGreaterThan(0n);

    /* ⭐ 0062: a numbered document is never a thing that happened silently. */
    const events = await h.call('GET', `/orders/${orderId}/events`, { token: h.sales.token });
    const issued = (
      events.body as { events: readonly { eventType: string; payload: Record<string, unknown> }[] }
    ).events.filter((event) => event.eventType === 'tax_document_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.payload['document_no']).toBe(document.documentNo);
    expect(issued[0]?.payload['document_kind']).toBe('tax_invoice');

    /* ⭐ And it reads back the same way it was written. */
    const listed = await h.list(orderId);
    expect(listed.status).toBe(200);
    expect((listed.body as readonly TaxDocumentWire[])[0]?.documentNo).toBe(document.documentNo);
  });

  it('⭐ the lines carry the real goods, and the column adds up to the total', async () => {
    /*
     * ⛔ THE TEST THAT WOULD HAVE CAUGHT THE WORST BUG THIS FEATURE HAD.
     *
     * `linesFrom()` read `titleTh`, `quantity`, `unitThbMinor` and `amountThbMinor`. A frozen
     * quotation line has none of those: the name is `nameTh`, the count is `qty`, and money is
     * `netMinor`, a `{ unit, digits }` object rather than a string. Every fallback fired, so
     * every line of every document would have printed blank, quantity 1, ฿0.00 — beside a
     * correct grand total, on a numbered page that cannot be corrected after issue.
     *
     * The footing assertion is the one that generalises: a face whose figures do not add up to
     * its own total is wrong however the fields were named.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    const raised = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    const { body } = raised.body as TaxDocumentWire;

    expect(body.lines.length).toBeGreaterThan(0);
    for (const line of body.lines) {
      expect(line.descriptionTh, 'a line with no description').not.toBe('');
      expect(line.quantity).toBeGreaterThan(0);
      expect(BigInt(line.amountThbMinor), `${line.descriptionTh} is ฿0.00`).toBeGreaterThan(0n);
    }

    /* ⭐ Under the exclusive basis this order was priced on, the lines sum to the net. */
    const summed = body.lines.reduce((total, line) => total + BigInt(line.amountThbMinor), 0n);
    expect(summed).toBe(BigInt(body.netThbMinor));

    /* And the charge raised on this order is one of them — charges are supplies too. */
    expect(body.lines.some((line) => line.descriptionTh.includes('ชุดครัวสั่งทำ'))).toBe(true);
  });

  it('⭐ an instalment document names the instalment, not the whole order’s goods', async () => {
    /*
     * Printing four windows beside a figure that is 30% of them would be a face claiming that
     * four windows cost ฿35.31. One line, naming the งวด and the order it belongs to.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    /*
     * ⚠️ Read from the database rather than guessed off a response shape, and asserted to exist
     * rather than skipped when absent. A fixture lookup that returns early on a miss is a test
     * that reports green without running — the failure mode this suite has already had twice.
     */
    const found = await h.db.execute(
      `select id::text as id from order_instalments
        where order_id = '${orderId}' order by seq limit 1` as never,
    );
    const first = ((found as { rows?: readonly Record<string, unknown>[] }).rows ?? [])[0];
    expect(first, 'the submitted order has no instalments to document').toBeDefined();

    const raised = await h.issue(orderId, { kind: 'receipt', instalmentId: String(first?.['id']) });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    const { body } = raised.body as TaxDocumentWire;
    expect(body.lines).toHaveLength(1);
    expect(body.subject.kind).toBe('instalment');
    expect(body.lines[0]?.descriptionTh).toContain('งวดที่');
    expect(BigInt(body.lines[0]?.amountThbMinor ?? '0')).toBe(BigInt(body.netThbMinor));
  });

  it('⭐ the face, the row and the number agree about when it was issued', async () => {
    /*
     * Three clocks were in play: the body took Node's, the row took the server's `now()`, and
     * the number took its Buddhist year from `now()` in Asia/Bangkok. On a drifted machine — or
     * at 23:59 on 31 December — they could name different years on one frozen document.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    const document = (await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null }))
      .body as TaxDocumentWire;

    expect(document.body.issuedAt).toBe(document.issuedAt);
    const yearBe = new Date(document.issuedAt).getUTCFullYear() + 543;
    expect(document.documentNo).toContain(String(yearBe));
  });

  it('⭐ the buyer’s kind is frozen with the rest, so a null tax id can be explained', async () => {
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    const document = (await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null }))
      .body as TaxDocumentWire;

    expect(document.body.buyer?.buyerKind).toBe('juristic');
    /* The seller block is this company; the field is null there rather than guessed. */
    expect(document.body.seller.buyerKind).toBeNull();
  });

  it('⛔ refuses to tax-invoice the same supply twice', async () => {
    /*
     * ⚠️ Enforced by a partial unique index, not by a query in the service: the owner asked for
     * both issuing modes to be switchable independently, and a service check would be a race
     * between two people pressing at the same moment. What the service owes is a sentence
     * somebody at the counter can act on rather than a constraint name.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();
    const orderId = await h.aSubmittedOrder();
    await h.billTo(orderId);

    expect((await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null })).status).toBe(201);

    const second = await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(JSON.stringify(second.body)).toContain('ออกเอกสารชนิดนี้ไปแล้ว');
  });

  it('⚠️ a refused issue gives its number back, so the series has no holes', async () => {
    /*
     * THE REASON `next_document_no()` IS A COUNTER ROW AND NOT A SEQUENCE, asserted at the level
     * a person experiences it. Somebody presses ออกใบกำกับภาษี twice by accident; the second
     * attempt is refused; the next legitimate document must still take the next number rather
     * than the one after it. `nextval` cannot do this — `order_no_seq` stands at 1049 against
     * eight orders in the developer database, and an order number with holes is untidy where a
     * tax series with holes is one an auditor walks and finds missing.
     */
    const h = await harness();
    await h.settings();
    await h.sellerProfile();

    const first = await h.aSubmittedOrder();
    await h.billTo(first);
    const one = await h.issue(first, { kind: 'tax_invoice', instalmentId: null });
    expect(one.status, JSON.stringify(one.body)).toBe(201);

    /* A refused attempt in between, which takes a number and rolls back. */
    expect((await h.issue(first, { kind: 'tax_invoice', instalmentId: null })).status).toBe(409);

    const second = await h.aSubmittedOrder();
    await h.billTo(second);
    const two = await h.issue(second, { kind: 'tax_invoice', instalmentId: null });
    expect(two.status, JSON.stringify(two.body)).toBe(201);

    const seqOf = (no: string): number => Number(no.split('-')[2]);
    expect(seqOf((two.body as TaxDocumentWire).documentNo)).toBe(
      seqOf((one.body as TaxDocumentWire).documentNo) + 1,
    );
  });

  it('🔒 a stranger can neither list nor raise', async () => {
    const h = await harness();
    /* ⚠️ `h.app`, not a second `base.harness()`: opening another ends the first one's pool. */
    const stranger = await makeActor(h.db, h.app, 'a stranger', []);
    const orderId = await h.anOrder();

    /* 404 and not 403 — an order that is not yours is one you cannot be told about. */
    expect((await h.list(orderId, stranger.token)).status).toBe(404);
    expect(
      (await h.issue(orderId, { kind: 'tax_invoice', instalmentId: null }, stranger.token)).status,
    ).toBe(403);
  });

  it('⛔ refuses a body the schema does not recognise', async () => {
    const h = await harness();
    await h.settings();
    const orderId = await h.anOrder();

    for (const body of [
      { kind: 'delivery_note', instalmentId: null },
      { kind: 'tax_invoice' },
      { kind: 'tax_invoice', instalmentId: null, extra: 1 },
    ]) {
      const refused = await h.issue(orderId, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
  });
});

/**
 * ⚠️ Kept separate because it asserts a shape rather than a refusal: the six kinds the database
 * knows, the six series that number them, and the fact that neither list may grow without the
 * other. `SERIES_OF` in the service is the sixth hand-written copy of an enumeration this
 * feature already spells out five times.
 */
describe.skipIf(url === undefined || url === '')('the series behind each kind', () => {
  const base = createPgHarness(url ?? '');

  afterAll(async () => {
    await base.closeOpened();
  });

  it('⭐ every kind the database accepts has a series configured for it', async () => {
    /*
     * ⚠️ `SERIES_OF` in the service is the sixth hand-written copy of an enumeration this feature
     * spells out five times already. A kind added to the CHECK without a series would take the
     * first document raised under it straight to a foreign-key violation, at the counter.
     */
    const { db } = await base.harness();

    const rows = await db.execute(
      `select kind, count(*)::text as series_count from document_series group by kind` as never,
    );
    const bySeries = new Map(
      ((rows as { rows?: readonly Record<string, unknown>[] }).rows ?? []).map((row) => [
        String(row['kind']),
        Number(row['series_count']),
      ]),
    );

    for (const kind of [
      'invoice',
      'tax_invoice',
      'abbreviated_tax_invoice',
      'receipt',
      'tax_invoice_receipt',
      'credit_note',
    ]) {
      expect(bySeries.get(kind), `${kind} has no document series`).toBe(1);
    }
  });
});
