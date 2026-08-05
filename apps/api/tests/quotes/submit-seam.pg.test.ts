import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { and, eq } from '@wewin/db/sql';
import { approvals, authorityLimits, orders, quoteLines, userGroups } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderDocumentWire, OrderWire, PriceRequestWire } from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { client, makeActor, type Actor, type Json } from '../orders/support/lifecycle-app';
import { bootQuotesApp, quotesEnv, type QuotesApp } from './support/quotes-app';

/**
 * ⭐ THE SEAM 5c SHIPPED WITHOUT: the quote is what gets pinned.
 *
 * `OrdersService.submit` priced `body.lines` — the cart the browser was holding — and never read
 * `quote_lines` at all. A red team measured the gap on one real order: **฿1.07 on the quote
 * screen, ฿14,791.68 in `orders.grand_total_thb_minor`**, and the two kept diverging afterwards
 * because `awaiting_payment` is an editable status with the payment schedule built off one of
 * them and the customer's screen built off the other. `AuthorityService.gate` had zero callers
 * anywhere in `src/`, so no concession was ever compared against a ceiling in the running
 * application.
 *
 * Everything below goes over real HTTP, through the assembled `AppModule`, against real Postgres.
 * That is not decoration: the properties are all *between* layers — a trigger, a transaction
 * boundary, a rollback, a permission — and none of them exists in a service call.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('the submit seam — the quote is the document', () => {
  let pool: Pool;
  let db: Database;
  let app: QuotesApp;
  let call: ReturnType<typeof client>;

  let sales: Actor;
  let approver: Actor;
  let owner: Actor;
  /** Publishes a product this suite creates, so no seeded version is ever archived. */
  let publisher: Actor;
  let line: PriceRequestWire;
  let salesGroupId: string;
  let approverGroupId: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootQuotesApp(quotesEnv(url ?? ''));
    call = client(app.baseUrl);

    sales = await makeActor(db, app, `seam sales ${tag}`, [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    approver = await makeActor(db, app, `seam approver ${tag}`, [
      'quotes.read',
      'quotes.write',
      'quotes.approve',
    ]);
    owner = await makeActor(db, app, `seam owner ${tag}`, ['groups.read', 'groups.write']);
    publisher = await makeActor(db, app, `seam publisher ${tag}`, [
      'catalog.read',
      'catalog.write',
      'catalog.publish',
    ]);

    salesGroupId = await groupIdOf(sales.userId);
    approverGroupId = await groupIdOf(approver.userId);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await db.delete(authorityLimits).where(eq(authorityLimits.groupId, salesGroupId));
    await db.delete(authorityLimits).where(eq(authorityLimits.groupId, approverGroupId));
    await app.close();
    await pool.end();
  });

  async function groupIdOf(userId: string): Promise<string> {
    const [row] = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId));
    if (row === undefined) throw new Error('fixture actor has no group');
    return row.groupId;
  }

  /* ---------------------------------------------------------------- *
   * Speaking the API
   * ---------------------------------------------------------------- */

  const auth = (actor: Actor): { token: string } => ({ token: actor.token });

  const newOrder = async (): Promise<string> => {
    const created = await call('POST', '/orders', { ...auth(sales), body: {} });
    expect(created.status).toBe(201);
    return (created.body as OrderWire).id;
  };

  const quote = async (orderId: string, actor: Actor = sales): Promise<QuoteWire> => {
    const read = await call('GET', `/orders/${orderId}/quote`, auth(actor));
    if (read.status !== 200) throw new Error(JSON.stringify(read.body));
    return read.body as QuoteWire;
  };

  const post = async (
    orderId: string,
    path: string,
    body: Record<string, unknown>,
    actor: Actor = sales,
  ): Promise<Json> => call('POST', `/orders/${orderId}/quote${path}`, { ...auth(actor), body });

  const addLine = async (orderId: string, qty = 2): Promise<QuoteWire> => {
    const current = await quote(orderId);
    const added = await post(orderId, '/lines', {
      expect: { quoteRevision: current.quoteRevision },
      line: { ...line, qty },
    });
    if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    return added.body as QuoteWire;
  };

  const submit = async (orderId: string, body: Record<string, unknown> = {}): Promise<Json> =>
    call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      ...auth(sales),
      body: {
        contact: { email: `seam-${randomUUID().slice(0, 8)}@probe.invalid`, name: `seam ${tag}` },
        ...body,
      },
    });

  const minor = (wire: unknown): bigint => toBigInt(wire as never);

  const grandTotalOf = async (orderId: string): Promise<bigint | null> => {
    const [row] = await db
      .select({ grand: orders.grandTotalThbMinor })
      .from(orders)
      .where(eq(orders.id, orderId));
    return row?.grand ?? null;
  };

  const documentOf = async (orderId: string, actor: Actor): Promise<OrderDocumentWire> => {
    const read = await call('GET', `/orders/${orderId}/document`, auth(actor));
    if (read.status !== 200) throw new Error(JSON.stringify(read.body));
    return read.body as OrderDocumentWire;
  };

  /* ================================================================ *
   * ① The divergence, closed
   * ================================================================ */

  /**
   * ⭐ The measurement that named this round's largest finding, inverted into an assertion.
   *
   * Set a line to ฿1.00 through the editor, submit, and read what the order row says. Before the
   * seam was closed the two were ฿1.07 and ฿14,791.68 and nothing anywhere compared them.
   */
  it('pins what the quote says, to the satang', async () => {
    const orderId = await newOrder();
    const withLine = await addLine(orderId);
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');

    const overridden = await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '1',
      reasonCode: 'goodwill',
    });
    expect(overridden.status).toBe(201);

    const onScreen = minor((overridden.body as QuoteWire).money.grandTotalThbMinor);
    expect(onScreen).toBe(107n);

    /* ฿1.07 is a 100%-ish concession, so a ceiling has to exist for the submit to pass at all —
     * which is itself the point: before the gate was wired, nothing asked. */
    await grantCeiling(salesGroupId, '10000000');

    const submitted = await submit(orderId);
    if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));

    expect(await grandTotalOf(orderId)).toBe(onScreen);

    const document = await documentOf(orderId, sales);
    expect(minor(document.grandTotalThbMinor)).toBe(onScreen);
    expect(document.documentSchemaVersion).toBe(2);

    await revokeCeiling(salesGroupId);
  });

  /**
   * Every layer plan 7.9(ก) names, present in the frozen document.
   *
   * A v1 document could hold none of this — no charge, no promise, no provenance — because
   * nothing could write one. The `documentSchemaVersion` bump is plan 4.5's rule kept rather
   * than plan 4.5's failure repeated.
   */
  it('freezes the computed figure, the promise and the person, beside the charge', async () => {
    const orderId = await newOrder();
    const withLine = await addLine(orderId);
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');
    const computed = minor(target.computedTotalThbMinor);

    const overridden = await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '17000',
      reasonCode: 'volume',
    });
    expect(overridden.status).toBe(201);

    const charged = await post(orderId, '/charges', {
      expect: { quoteRevision: (overridden.body as QuoteWire).quoteRevision },
      customerDescriptionTh: 'ค่าติดตั้งหน้างาน',
      amountText: '2000',
    });
    expect(charged.status).toBe(201);

    await grantCeiling(salesGroupId, '10000000');
    const submitted = await submit(orderId);
    if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));
    await revokeCeiling(salesGroupId);

    const document = await documentOf(orderId, sales);

    const frozen = document.lines[0];
    expect(minor(frozen?.netMinor)).toBe(1_700_000n);
    expect(minor(frozen?.computedNetMinor)).toBe(computed);
    expect(frozen?.override?.enteredValueText).toBe('17000');
    expect(frozen?.override?.reasonCode).toBe('volume');
    expect(frozen?.override?.setByUserId).toBe(sales.userId);
    expect(frozen?.override?.setByUserName).toBe(`seam sales ${tag}`);

    expect(document.charges).toHaveLength(1);
    expect(minor(document.charges[0]?.netMinor)).toBe(200_000n);
    expect(document.charges[0]?.customerDescriptionTh).toBe('ค่าติดตั้งหน้างาน');

    /* ฿17,000 + ฿2,000 = ฿19,000 net, VAT ฿1,330, ฿20,330 the customer transfers. */
    expect(minor(document.netThbMinor)).toBe(1_900_000n);
    expect(minor(document.vatThbMinor)).toBe(133_000n);
    expect(minor(document.grandTotalThbMinor)).toBe(2_033_000n);
    expect(await grandTotalOf(orderId)).toBe(2_033_000n);
  });

  it('refuses a quote with no lines rather than contracting for nothing', async () => {
    const orderId = await newOrder();

    const submitted = await submit(orderId);
    expect(submitted.status).toBe(422);
    expect(
      (submitted.body as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('empty_quote');
  });

  /**
   * The storefront's path: a browser cart, adopted into the quote and priced from there.
   *
   * This is the only way lines arrive without the editor, and it is what keeps the configurator
   * working unchanged. What it must never be is a *second* source for the document.
   */
  it('adopts a browser cart into the quote, and prices it from there', async () => {
    const orderId = await newOrder();

    const submitted = await submit(orderId, { lines: [line] });
    if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));

    const rows = await db
      .select({ id: quoteLines.id, computed: quoteLines.computedTotalThbMinor })
      .from(quoteLines)
      .where(eq(quoteLines.orderId, orderId));

    expect(rows).toHaveLength(1);
    expect(await grandTotalOf(orderId)).toBe(
      minor((await documentOf(orderId, sales)).grandTotalThbMinor),
    );
  });

  /* ================================================================ *
   * ② The gate, which had no callers
   * ================================================================ */

  const grantCeiling = async (groupId: string, ceiling: string): Promise<void> => {
    const granted = await call('PUT', '/quotes/authority/limits', {
      ...auth(owner),
      body: {
        groupId,
        dimension: 'margin',
        maxConcessionThbMinor: ceiling,
        noteTh: 'ทดสอบ',
      },
    });
    if (granted.status !== 200) throw new Error(JSON.stringify(granted.body));
  };

  const revokeCeiling = async (groupId: string): Promise<void> => {
    await db.delete(authorityLimits).where(eq(authorityLimits.groupId, groupId));
  };

  /**
   * ⭐ Plan 13's fail-closed, enforced at the one place it decides anything.
   *
   * With `authority_limits` empty — which is how this ships — a concession nobody has the
   * authority for stops the submit, **and the refusal rolls the pin back with it**. That last
   * clause is why `approvals` could not stay keyed to `order_documents`: the row a request would
   * have had to point at ceases to exist at the moment the request becomes necessary.
   */
  it('refuses a submit that concedes more than anybody may, and un-pins the document', async () => {
    const orderId = await newOrder();
    const withLine = await addLine(orderId);
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');

    const overridden = await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '9000',
      reasonCode: 'relationship',
    });
    expect(overridden.status).toBe(201);

    const refused = await submit(orderId);
    expect(refused.status).toBe(409);
    expect(
      (refused.body as { error: { details: { dimensions: readonly { dimension: string }[] } } }).error
        .details.dimensions[0]?.dimension,
    ).toBe('margin');

    /* Nothing was pinned, nothing moved, and the order is still a draft. */
    const [row] = await db
      .select({ status: orders.status, documentId: orders.documentId, grand: orders.grandTotalThbMinor })
      .from(orders)
      .where(eq(orders.id, orderId));
    expect(row?.status).toBe('draft');
    expect(row?.documentId).toBeNull();
    expect(row?.grand).toBeNull();
  });

  /**
   * ⭐ AN APPROVAL COVERS ONE QUOTE, AND THE QUOTE IS NAMED.
   *
   * The red team's ฿9,630-becomes-฿0.00 walk, refused. An approval used to be an absolute figure
   * attached to the *order*, so any later, smaller concession spent it — approve 6.97% on a
   * ฿138,240 line, then rewrite the quote and give a different line away entirely.
   */
  it('lets an approved quote through, and stops covering it the moment a line moves', async () => {
    const orderId = await newOrder();
    const withLine = await addLine(orderId);
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');

    const overridden = await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '9000',
      reasonCode: 'relationship',
    });
    expect(overridden.status).toBe(201);
    const revisionAtRequest = (overridden.body as QuoteWire).quoteRevision;

    const asked = await call('POST', '/quotes/approvals', {
      ...auth(sales),
      body: { orderId, dimension: 'margin', reasonTh: 'ลูกค้าเก่า สั่งซ้ำทุกปี' },
    });
    if (asked.status !== 201) throw new Error(JSON.stringify(asked.body));
    const approvalId = (asked.body as { id: string; quoteRevision: string }).id;
    expect((asked.body as { quoteRevision: string }).quoteRevision).toBe(revisionAtRequest);

    await grantCeiling(approverGroupId, '10000000');
    const decided = await call('POST', `/quotes/approvals/${approvalId}/decision`, {
      ...auth(approver),
      body: { decision: 'approved' },
    });
    if (decided.status !== 200) throw new Error(JSON.stringify(decided.body));
    /* The ceiling that made this decision legal, pinned beside it. */
    expect((decided.body as { decidedCeilingThbMinor: string }).decidedCeilingThbMinor).toBe(
      '10000000',
    );

    const assessed = await call('GET', `/quotes/authority/orders/${orderId}`, auth(sales));
    expect((assessed.body as { allowed: boolean }).allowed).toBe(true);

    /* Now rewrite the quote underneath the approval. */
    const current = await quote(orderId);
    const revoked = await post(orderId, `/overrides/${current.sales?.overrides[0]?.id ?? ''}/revocation`, {
      expect: { quoteRevision: current.quoteRevision },
    });
    expect(revoked.status).toBe(200);

    /*
     * ⚠️ A **smaller** concession, deliberately, and the whole mutation-testing value of this
     * test is in that word.
     *
     * The first pass rewrote the quote into one that conceded *more*, so the figure comparison
     * (`concessionThbMinor >= conceded`) refused it and the revision comparison was never
     * reached — neutralising the revision check left the suite green, which is evidence for
     * nothing. This is the red team's actual walk: approve a defensible figure, then spend the
     * headroom on a different, smaller giveaway that the approver never saw.
     */
    const rewritten = await post(orderId, '/charges', {
      expect: { quoteRevision: (revoked.body as QuoteWire).quoteRevision },
      customerDescriptionTh: 'ส่วนลดพิเศษ',
      amountText: '-1000',
    });
    expect(rewritten.status).toBe(201);

    const reassessed = await call('GET', `/quotes/authority/orders/${orderId}`, auth(sales));
    const wire = reassessed.body as {
      allowed: boolean;
      quoteRevision: string;
      margin: { outcome: string; concessionThbMinor: string };
    };

    /* ฿1,070 against ฿9,630 approved: the *amount* alone would call this covered. */
    expect(BigInt(wire.margin.concessionThbMinor)).toBe(107_000n);
    expect(BigInt(wire.margin.concessionThbMinor)).toBeLessThan(
      BigInt((asked.body as { concessionThbMinor: string }).concessionThbMinor),
    );

    /* A different quote, a different digest, and the approval no longer covers anything. */
    expect(wire.quoteRevision).not.toBe(revisionAtRequest);
    expect(wire.margin.outcome).toBe('needs_approval');
    expect(wire.allowed).toBe(false);

    const refused = await submit(orderId);
    expect(refused.status).toBe(409);

    await revokeCeiling(approverGroupId);
  });

  /* Recording the ask is always permitted, and it now works before there is any document —
   * which is the state a refused submit leaves the order in. */
  it('records a request against a quote that has never been pinned', async () => {
    const orderId = await newOrder();
    const withLine = await addLine(orderId);
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');

    await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '9000',
      reasonCode: 'relationship',
    });

    const asked = await call('POST', '/quotes/approvals', {
      ...auth(sales),
      body: { orderId, dimension: 'margin', reasonTh: 'ยังไม่ได้ส่งใบ' },
    });

    expect(asked.status).toBe(201);
    const [row] = await db
      .select({ documentId: approvals.orderDocumentId })
      .from(approvals)
      .where(and(eq(approvals.orderId, orderId), eq(approvals.dimension, 'margin')));
    expect(row?.documentId).toBeNull();
  });

  /* ================================================================ *
   * ③ A publish underneath an open quote blocks the submit — plan 7.9(จ)
   * ================================================================ */

  /**
   * ⭐ *"ลดราคา ฿18,432 → ฿17,000 ตอนบ่าย · ทีมอื่น publish ราคาใหม่ ฿20,000 ตอนเย็น"* — plan 7.9(จ).
   *
   * Publishing a second version archives the first, so the line's pinned version stops being the
   * published one and its promise's baseline is no longer a price anybody may be quoted.
   * `assertSubmittable` refuses the pin and names the line, the promise, the baseline it was made
   * against and what the same configuration costs now — because the recovery is per line and a
   * person has to look at each one.
   *
   * ⚠️ **A product this suite creates, published twice.** `vitest.config.ts` records what
   * publishing a *seeded* product costs: a published document is frozen and no DELETE takes it
   * back, which is what made `catalog-fidelity.pg.test.ts` pass or fail depending on file order
   * for a whole phase. This is the fix 5c wrote down and could not buy — it also gives the one
   * guard the round shipped without evidence for (`baselineFor` refusing a promise against an
   * already-stale baseline) a behavioural test.
   */
  it('blocks the submit when the catalogue is republished under a promise', async () => {
    const productId = `seam-${tag}`;
    const created = await call('POST', '/admin/catalog/products', {
      ...auth(publisher),
      body: productRequest(productId, 220_000n),
    });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));

    const publish = async (body: unknown): Promise<{ versionId: string; hash: string }> => {
      const wire = body as { productVersionId: string; documentHash: string };
      const published = await call('POST', `/admin/catalog/products/${productId}/draft/publish`, {
        ...auth(publisher),
        body: { productVersionId: wire.productVersionId, expectedDocumentHash: wire.documentHash },
      });
      if (published.status !== 201) throw new Error(JSON.stringify(published.body));
      const out = published.body as { productVersionId: string; documentHash: string };
      return { versionId: out.productVersionId, hash: out.documentHash };
    };

    const first = await publish(created.body);

    const orderId = await newOrder();
    const current = await quote(orderId);
    const added = await post(orderId, '/lines', {
      expect: { quoteRevision: current.quoteRevision },
      line: {
        productId,
        productVersionId: first.versionId,
        documentHash: first.hash,
        selections: { profile_color: 'SG' },
        measures: { width: { unit: 'um', digits: '1200000' }, height: { unit: 'um', digits: '1200000' } },
        enteredUnits: { width: 'mm', height: 'mm' },
        qty: 1,
      },
    });
    if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    const target = (added.body as QuoteWire).lines[0];
    if (!target) throw new Error('no line');

    const overridden = await post(orderId, '/overrides', {
      expect: { quoteRevision: (added.body as QuoteWire).quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '2000',
      reasonCode: 'volume',
    });
    expect(overridden.status).toBe(201);

    /* Somebody else, that evening: a new price, published under the promise. */
    const reopened = await call('POST', `/admin/catalog/products/${productId}/draft`, {
      ...auth(publisher),
      body: {},
    });
    if (reopened.status !== 201) throw new Error(JSON.stringify(reopened.body));
    const repriced = await call('PATCH', `/admin/catalog/products/${productId}/draft`, {
      ...auth(publisher),
      body: {
        expectedDocumentHash: (reopened.body as { documentHash: string }).documentHash,
        fields: { pricePerSqm: { unit: 'THB.satang/m2', digits: '400000' } },
      },
    });
    if (repriced.status !== 200) throw new Error(JSON.stringify(repriced.body));
    await publish(repriced.body);

    /* The editor's own screen says so on a plain GET, before anybody presses send. */
    const seen = await quote(orderId);
    expect(seen.sales?.staleBaselines[0]?.kind).toBe('promise_baseline_moved');
    expect(seen.sales?.staleBaselines[0]?.quoteLineId).toBe(target.id);

    const verification = await post(orderId, '/verification', {});
    expect(verification.status).toBe(409);
    const details = (
      verification.body as {
        error: { details: { reason: string; lines: readonly { kind: string; overrideId: string }[] } };
      }
    ).error.details;
    expect(details.reason).toBe('quote_baselines_stale');
    expect(details.lines[0]?.kind).toBe('promise_baseline_moved');

    const submitted = await submit(orderId);
    expect(submitted.status).toBe(409);
    expect(
      (submitted.body as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('quote_baselines_stale');

    /* Nothing was pinned. The quote is exactly where the salesperson left it. */
    expect(await grandTotalOf(orderId)).toBeNull();

    /*
     * ⚠️ AND THE GUARD 5c REPORTED AS HAVING NO INDEPENDENT EVIDENCE.
     *
     * `baselineFor` refuses a *new* promise taken against a baseline that is already stale —
     * recording ฿17,000 against ฿18,432 at a moment when the published price is ฿20,000, with a
     * fresh timestamp on it that makes the record look reliable. Mutation testing neutralised the
     * `if` and the suite stayed green, because producing a stale baseline needed exactly the
     * second publish this test now performs.
     */
    const promised = await post(orderId, '/overrides', {
      expect: { quoteRevision: seen.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '2500',
      reasonCode: 'price_match',
    });
    expect(promised.status).toBe(409);
    expect(
      (promised.body as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('quote_baselines_stale');
  });
});

/** A product of this suite's own, so nothing seeded is disturbed by publishing it twice. */
function productRequest(productId: string, pricePerSqm: bigint): Record<string, unknown> {
  return {
    id: productId,
    slug: productId,
    skuPrefix: 'SEAM',
    fields: {
      nameTh: 'สินค้าทดสอบรอยต่อการส่งใบเสนอราคา',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับทดสอบการเผยแพร่ราคาใหม่ใต้ราคาที่ตกลงไว้',
      heroImage: '/images/probe.svg',
      leadTimeDays: [7, 14],
      pricePerSqm: { unit: 'THB.satang/m2', digits: pricePerSqm.toString() },
      minBillableSqUm: { unit: 'um2', digits: '500000000000' },
      elevation: { panels: 1, operation: 'fixed', infill: 'louvre' },
    },
    options: {
      profile_color: { kind: 'sku', sortOrder: 0, valueCodes: ['SG', 'WH', 'BK'], defaultValueCode: 'SG' },
      width: {
        kind: 'custom',
        sortOrder: 1,
        minUm: { unit: 'um', digits: '600000' },
        maxUm: { unit: 'um', digits: '3000000' },
        stepUm: { unit: 'um', digits: '50000' },
        defaultUm: { unit: 'um', digits: '1200000' },
      },
      height: {
        kind: 'custom',
        sortOrder: 2,
        minUm: { unit: 'um', digits: '600000' },
        maxUm: { unit: 'um', digits: '3000000' },
        stepUm: { unit: 'um', digits: '50000' },
        defaultUm: { unit: 'um', digits: '1200000' },
      },
    },
  };
}

/** The first published product with a measurement, configured at its defaults. */
async function liveLine(call: ReturnType<typeof client>): Promise<PriceRequestWire> {
  const listed = await call('GET', '/catalog/products', {});
  if (listed.status !== 200) throw new Error(`the catalogue is not being served: ${listed.status}`);

  const wire = listed.body as {
    products: readonly { productVersionId: string; documentHash: string; product: { id: string } }[];
  };

  for (const published of wire.products) {
    const product = products.find((candidate: Product) => candidate.id === published.product.id);
    if (!product || !product.groups.some((group) => group.kind === 'custom')) continue;

    const selections: Record<string, string> = {};
    const measures: Record<string, ReturnType<typeof encodeUm>> = {};
    const enteredUnits: Record<string, 'cm' | 'mm'> = {};

    for (const group of product.groups) {
      if (group.kind === 'sku') selections[group.code] = group.defaultValue;
      else {
        measures[group.code] = encodeUm(group.defaultUm);
        enteredUnits[group.code] = group.unit;
      }
    }

    return {
      productVersionId: published.productVersionId,
      documentHash: published.documentHash,
      productId: product.id,
      selections,
      measures,
      enteredUnits,
      qty: 2,
    };
  }

  throw new Error('no published product with a measurement to quote');
}
