import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { orders, userGroups } from '@wewin/db/schema';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderDocumentResponseWire, OrderWire } from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { client, makeActor, type Actor, type Json } from '../orders/support/lifecycle-app';
import { bootQuotesApp, quotesEnv, type QuotesApp } from './support/quotes-app';
import { purgeAuthorityLimits } from './support/authority-reset';

/**
 * ⭐ ONE QUOTE, END TO END, WITH THE NUMBERS PRINTED — plan 7.9 and plan 13's smoke path.
 *
 * Everything else in this directory asserts one property at a time. This walks the story the
 * plan tells, in the plan's own figures, and prints each total as it moves, because the thing
 * a person has to be able to believe about this feature is not that a guard fires — it is that
 * **the number on the salesperson's screen is the number in the contract and the number the
 * customer is shown**, and that the approval requirement moves with it.
 *
 *     ฿18,432.00 for two            plan 7.9(ข)'s worked example, priced by `calcPrice`
 *     → ฿17,000.00 on the line      plan 7.9(จ)'s afternoon discount
 *     + ฿2,000.00 delivery          plan 7.9(ค)'s "แถวใหม่"
 *     → the concession, the ceiling, and whether it may be sent
 *     → pinned, and read back as the customer
 *     → a publish lands under the promise, and the submit is refused
 *
 * `--disable-console-intercept` prints the table. The assertions are the same figures, so a
 * change to any of them fails here rather than only being visible in the log.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

/** `lvr-adj`, 107.0 × 391.5 cm, two of them: exactly ฿18,432.00 by `calcPrice`. */
const PRODUCT_ID = 'lvr-adj';
const WIDTH_UM = '1070000';
const HEIGHT_UM = '3915000';

const baht = (minor: bigint): string => {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const satang = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}฿${whole.toLocaleString('en-US')}.${satang}`;
};

const say = (label: string, value: string): void => {
  // eslint-disable-next-line no-console
  console.log(`    ${label.padEnd(46, ' ')} ${value}`);
};

describeWithPg('one quote, end to end', () => {
  let pool: Pool;
  let db: Database;
  let app: QuotesApp;
  let call: ReturnType<typeof client>;

  let sales: Actor;
  let owner: Actor;
  let publisher: Actor;
  let clerk: Actor;
  let salesGroupId: string;
  let productVersionId: string;
  let documentHash: string;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);
    app = await bootQuotesApp(quotesEnv(url ?? ''));
    call = client(app.baseUrl);

    sales = await makeActor(db, app, `walk sales ${tag}`, [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    owner = await makeActor(db, app, `walk owner ${tag}`, ['groups.read', 'groups.write']);
    publisher = await makeActor(db, app, `walk publisher ${tag}`, [
      'catalog.read',
      'catalog.write',
      'catalog.publish',
    ]);
    /* `orders.read` and no quote permission: may read the order, and is not thereby entitled to
     * the record of what the company was willing to concede. */
    clerk = await makeActor(db, app, `walk clerk ${tag}`, ['orders.read', 'orders.write']);
    salesGroupId = await groupIdOf(sales.userId);

    const listed = await call('GET', '/catalog/products', {});
    const wire = listed.body as {
      products: readonly {
        productVersionId: string;
        documentHash: string;
        product: { id: string };
      }[];
    };
    const entry = wire.products.find((candidate) => candidate.product.id === PRODUCT_ID);
    if (entry === undefined) throw new Error(`${PRODUCT_ID} is not published`);
    productVersionId = entry.productVersionId;
    documentHash = entry.documentHash;
  }, 60_000);

  afterAll(async () => {
    await purgeAuthorityLimits(db, salesGroupId);
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

  const auth = (actor: Actor): { token: string } => ({ token: actor.token });
  const minor = (wire: unknown): bigint => toBigInt(wire as never);

  const post = async (
    orderId: string,
    path: string,
    body: Record<string, unknown>,
    actor: Actor = sales,
  ): Promise<Json> => call('POST', `/orders/${orderId}/quote${path}`, { ...auth(actor), body });

  const quote = async (orderId: string, actor: Actor = sales): Promise<QuoteWire> => {
    const read = await call('GET', `/orders/${orderId}/quote`, auth(actor));
    if (read.status !== 200) throw new Error(JSON.stringify(read.body));
    return read.body as QuoteWire;
  };

  const assess = async (
    orderId: string,
  ): Promise<{
    allowed: boolean;
    margin: { outcome: string; concessionThbMinor: string; ceilingThbMinor: string | null };
  }> => {
    const read = await call('GET', `/quotes/authority/orders/${orderId}`, auth(sales));
    if (read.status !== 200) throw new Error(JSON.stringify(read.body));
    return read.body as never;
  };

  const lineRequest = (qty: number): Record<string, unknown> => ({
    productId: PRODUCT_ID,
    productVersionId,
    documentHash,
    selections: {},
    measures: {
      width: { unit: 'um', digits: WIDTH_UM },
      height: { unit: 'um', digits: HEIGHT_UM },
    },
    enteredUnits: { width: 'cm', height: 'cm' },
    qty,
  });

  it('walks the plan’s own quote, and every figure moves where the plan says it does', async () => {
    /* ── ① price ───────────────────────────────────────────────────── */

    const created = await call('POST', '/orders', { ...auth(sales), body: {} });
    expect(created.status).toBe(201);
    const orderId = (created.body as OrderWire).id;

    const empty = await quote(orderId);
    const added = await post(orderId, '/lines', {
      expect: { quoteRevision: empty.quoteRevision },
      line: lineRequest(2),
      customerDescriptionTh: 'บานเกล็ดปรับได้ 107 × 391.5 ซม.',
    });
    if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    const priced = added.body as QuoteWire;
    const target = priced.lines[0];
    if (!target) throw new Error('no line');

    say('① calcPrice, two units, net', baht(minor(priced.money.netThbMinor)));
    say('   VAT 700 bp, taken once over the taxable subtotal', baht(minor(priced.money.vatThbMinor)));
    say('   grand total, VAT-inclusive', baht(minor(priced.money.grandTotalThbMinor)));
    say('   conceded so far', baht(minor(priced.sales?.marginConcessionThbMinor)));

    expect(minor(priced.money.netThbMinor)).toBe(1_843_200n);
    expect(minor(priced.money.vatThbMinor)).toBe(129_024n);
    expect(minor(priced.money.grandTotalThbMinor)).toBe(1_972_224n);
    expect(minor(priced.sales?.marginConcessionThbMinor)).toBe(0n);

    /* ── ② discount one line ───────────────────────────────────────── */

    const discounted = await post(orderId, '/overrides', {
      expect: { quoteRevision: priced.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '17000',
      reasonCode: 'volume',
      noteTh: 'ลูกค้าสั่งซ้ำทุกปี',
    });
    if (discounted.status !== 201) throw new Error(JSON.stringify(discounted.body));
    const afterDiscount = discounted.body as QuoteWire;

    // eslint-disable-next-line no-console
    console.log('');
    say('② the line, promised at ฿17,000.00 — net', baht(minor(afterDiscount.money.netThbMinor)));
    say('   grand total', baht(minor(afterDiscount.money.grandTotalThbMinor)));
    say('   conceded (VAT-inclusive, measureMargin)', baht(minor(afterDiscount.sales?.marginConcessionThbMinor)));

    /* ฿1,432.00 off a taxable line is ฿1,532.24 the customer does not transfer. */
    expect(minor(afterDiscount.money.netThbMinor)).toBe(1_700_000n);
    expect(minor(afterDiscount.money.grandTotalThbMinor)).toBe(1_819_000n);
    expect(minor(afterDiscount.sales?.marginConcessionThbMinor)).toBe(153_224n);

    const beforeCharge = await assess(orderId);
    say('   may this be sent? (authority_limits is empty)', String(beforeCharge.allowed));
    say('   outcome', beforeCharge.margin.outcome);
    expect(beforeCharge.allowed).toBe(false);
    expect(beforeCharge.margin.outcome).toBe('needs_approval');
    /* ⚠️ plan 13's fail-closed, and this null is what it looks like: not "a ceiling of zero",
     * but "this role carries no authority row at all". */
    expect(beforeCharge.margin.ceilingThbMinor).toBeNull();

    /* ── ③ add a charge ────────────────────────────────────────────── */

    const charged = await post(orderId, '/charges', {
      expect: { quoteRevision: afterDiscount.quoteRevision },
      customerDescriptionTh: 'ค่าขนส่งและติดตั้งหน้างาน',
      amountText: '2000',
    });
    if (charged.status !== 201) throw new Error(JSON.stringify(charged.body));
    const afterCharge = charged.body as QuoteWire;

    // eslint-disable-next-line no-console
    console.log('');
    say('③ + ฿2,000.00 delivery — net', baht(minor(afterCharge.money.netThbMinor)));
    say('   VAT', baht(minor(afterCharge.money.vatThbMinor)));
    say('   grand total', baht(minor(afterCharge.money.grandTotalThbMinor)));
    say('   conceded — unchanged, a charge is not a discount', baht(minor(afterCharge.sales?.marginConcessionThbMinor)));

    expect(minor(afterCharge.money.netThbMinor)).toBe(1_900_000n);
    expect(minor(afterCharge.money.vatThbMinor)).toBe(133_000n);
    expect(minor(afterCharge.money.grandTotalThbMinor)).toBe(2_033_000n);
    expect(minor(afterCharge.sales?.marginConcessionThbMinor)).toBe(153_224n);

    /* ── ④ the approval requirement moves with the ceiling ─────────── */

    const granted = await call('PUT', '/quotes/authority/limits', {
      ...auth(owner),
      body: {
        groupId: salesGroupId,
        dimension: 'margin',
        maxConcessionThbMinor: '200000',
        noteTh: 'เพดานทดสอบ ฿2,000',
      },
    });
    expect(granted.status).toBe(200);

    const withCeiling = await assess(orderId);
    // eslint-disable-next-line no-console
    console.log('');
    say('④ ceiling granted to this role', baht(200_000n));
    say('   conceded', baht(BigInt(withCeiling.margin.concessionThbMinor)));
    say('   outcome', withCeiling.margin.outcome);
    say('   may this be sent?', String(withCeiling.allowed));
    expect(withCeiling.margin.outcome).toBe('within_authority');
    expect(withCeiling.allowed).toBe(true);

    /* ── ⑤ submit, and read it back as the customer ───────────────── */

    const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      ...auth(sales),
      body: {
        contact: { email: `walk-${tag}@probe.invalid`, name: `walk ${tag}` },
      },
    });
    if (submitted.status !== 200) throw new Error(JSON.stringify(submitted.body));

    const [row] = await db
      .select({
        grand: orders.grandTotalThbMinor,
        deposit: orders.scheduledDepositThbMinor,
        no: orders.orderNo,
      })
      .from(orders)
      .where(eq(orders.id, orderId));

    /* ⚠️ `seller` is beside `document`, not inside it — see `OrderDocumentResponseWire`. */
    const document = (
      (await call('GET', `/orders/${orderId}/document`, auth(sales))).body as OrderDocumentResponseWire
    ).document;

    // eslint-disable-next-line no-console
    console.log('');
    say('⑤ submitted as', row?.no ?? '—');
    say('   orders.grand_total_thb_minor', baht(row?.grand ?? 0n));
    say('   frozen document, grand total', baht(minor(document.grandTotalThbMinor)));
    say('   frozen document, schema version', String(document.documentSchemaVersion));
    say('   frozen line: computed', baht(minor(document.lines[0]?.computedNetMinor)));
    say('   frozen line: charged', baht(minor(document.lines[0]?.netMinor)));
    say('   frozen line: promised by', document.lines[0]?.override?.setByUserName ?? '—');
    say('   frozen line: typed', document.lines[0]?.override?.enteredValueText ?? '—');
    say('   frozen charge', baht(minor(document.charges[0]?.netMinor)));
    say('   scheduled deposit (plan 13: payment in full)', baht(row?.deposit ?? 0n));

    expect(row?.grand).toBe(2_033_000n);
    expect(minor(document.grandTotalThbMinor)).toBe(2_033_000n);
    expect(document.documentSchemaVersion).toBe(2);
    expect(minor(document.lines[0]?.computedNetMinor)).toBe(1_843_200n);
    expect(minor(document.lines[0]?.netMinor)).toBe(1_700_000n);
    expect(document.lines[0]?.override?.enteredValueText).toBe('17000');

    /*
     * ⭐ What the customer is shown: the frozen document's total, and no trace of the
     * negotiation that produced it. `clerk` holds `orders.read` and no quote permission, which
     * is the audience `encodeQuote` derives from the caller rather than from a flag.
     */
    const asSales = await quote(orderId, sales);
    const asCustomer = await quote(orderId, clerk);

    // eslint-disable-next-line no-console
    console.log('');
    say('   the contract says', baht(minor(document.grandTotalThbMinor)));
    say('   the sales screen says', baht(minor(asSales.money.grandTotalThbMinor)));
    say('   the customer’s copy says', baht(minor(asCustomer.money.grandTotalThbMinor)));
    say('   …and the customer’s copy shows', asCustomer.sales === null ? 'no concession at all' : '!!');
    say('   …per line, computed', String(asCustomer.lines[0]?.computedTotalThbMinor));

    expect(minor(asSales.money.grandTotalThbMinor)).toBe(minor(document.grandTotalThbMinor));
    expect(minor(asCustomer.money.grandTotalThbMinor)).toBe(minor(document.grandTotalThbMinor));
    expect(asCustomer.sales).toBeNull();
    /* The per-line concession is one subtraction away from `computed` beside `effective`, so
     * `computed` is not served to a customer at all. */
    expect(asCustomer.lines[0]?.computedTotalThbMinor).toBeNull();
    expect(minor(asCustomer.lines[0]?.effectiveTotalThbMinor)).toBe(1_700_000n);
  }, 60_000);

  /**
   * ⑥ *"ลดราคา ฿18,432 → ฿17,000 ตอนบ่าย · ทีมอื่น publish ราคาใหม่ ฿20,000 ตอนเย็น"*
   *
   * A product of this suite's own, published twice — because publishing a *seeded* product
   * archives a version no DELETE takes back, which is what `vitest.config.ts` records as having
   * made a neighbouring suite order-dependent for a whole phase.
   */
  it('blocks the submit when a publish lands underneath the promise', async () => {
    const productId = `walk-${tag}`;
    const created = await call('POST', '/admin/catalog/products', {
      ...auth(publisher),
      body: productRequest(productId, 220_000n),
    });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));

    const publish = async (from: unknown): Promise<{ versionId: string; hash: string }> => {
      const wire = from as { productVersionId: string; documentHash: string };
      const published = await call('POST', `/admin/catalog/products/${productId}/draft/publish`, {
        ...auth(publisher),
        body: { productVersionId: wire.productVersionId, expectedDocumentHash: wire.documentHash },
      });
      if (published.status !== 201) throw new Error(JSON.stringify(published.body));
      const out = published.body as { productVersionId: string; documentHash: string };
      return { versionId: out.productVersionId, hash: out.documentHash };
    };

    const first = await publish(created.body);

    const order = await call('POST', '/orders', { ...auth(sales), body: {} });
    const orderId = (order.body as OrderWire).id;

    const empty = await quote(orderId);
    const added = await post(orderId, '/lines', {
      expect: { quoteRevision: empty.quoteRevision },
      line: {
        productId,
        productVersionId: first.versionId,
        documentHash: first.hash,
        selections: { profile_color: 'SG' },
        measures: {
          width: { unit: 'um', digits: '1200000' },
          height: { unit: 'um', digits: '1200000' },
        },
        enteredUnits: { width: 'mm', height: 'mm' },
        qty: 1,
      },
    });
    if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    const withLine = added.body as QuoteWire;
    const target = withLine.lines[0];
    if (!target) throw new Error('no line');

    const promised = await post(orderId, '/overrides', {
      expect: { quoteRevision: withLine.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '2500',
      reasonCode: 'price_match',
    });
    expect(promised.status).toBe(201);

    // eslint-disable-next-line no-console
    console.log('');
    say('⑥ line priced at', baht(minor(target.computedTotalThbMinor)));
    say('   promised at', baht(250_000n));

    /* That evening: somebody publishes a new price. */
    const reopened = await call('POST', `/admin/catalog/products/${productId}/draft`, {
      ...auth(publisher),
      body: {},
    });
    const repriced = await call('PATCH', `/admin/catalog/products/${productId}/draft`, {
      ...auth(publisher),
      body: {
        expectedDocumentHash: (reopened.body as { documentHash: string }).documentHash,
        fields: { pricePerSqm: { unit: 'THB.satang/m2', digits: '400000' } },
      },
    });
    await publish(repriced.body);

    const seen = await quote(orderId);
    const stale = seen.sales?.staleBaselines[0];
    say('   after the publish, the editor says', stale?.kind ?? 'nothing');
    say('   promised', baht(minor(stale?.promisedThbMinor)));
    say('   was taken against', baht(minor(stale?.baselineThbMinor)));
    say('   the same configuration now costs', baht(minor(stale?.currentComputedThbMinor)));

    /*
     * ⭐ AND A NEW PROMISE CANNOT BE MADE AGAINST THE STALE FIGURE EITHER.
     *
     * `baselineFor` refuses to write an override when the line it is anchored to is already
     * stale — otherwise ฿2,600 would be recorded against a ฿3,168 baseline at a moment when the
     * published price is ฿5,760, with a fresh timestamp on it making the record look reliable.
     * That `if` was the one guard in this feature with no independent behavioural evidence,
     * because producing a stale baseline needs a product published twice; this suite already has
     * one of its own, so the evidence is here rather than the apology in the comment.
     */
    const overStale = await post(orderId, '/overrides', {
      expect: { quoteRevision: seen.quoteRevision },
      anchor: 'line_total',
      quoteLineId: target.id,
      enteredAs: 'line_total',
      enteredValueText: '2600',
      reasonCode: 'price_match',
    });
    const overStaleReason = (overStale.body as { error: { details: { reason: string } } }).error
      .details.reason;
    say('   re-promising on the stale line', `${String(overStale.status)} ${overStaleReason}`);
    expect(overStale.status).toBe(409);
    expect(overStaleReason).toBe('quote_baselines_stale');

    const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
      ...auth(sales),
      body: { contact: { email: `walk-stale-${tag}@probe.invalid`, name: `walk ${tag}` } },
    });
    const reason = (submitted.body as { error: { details: { reason: string } } }).error.details
      .reason;
    say('   submit', `${String(submitted.status)} ${reason}`);

    const [row] = await db
      .select({ grand: orders.grandTotalThbMinor, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));
    say('   orders.grand_total_thb_minor', row?.grand === null ? 'NULL — nothing was pinned' : '!!');
    say('   orders.status', row?.status ?? '—');

    expect(stale?.kind).toBe('promise_baseline_moved');
    expect(submitted.status).toBe(409);
    expect(reason).toBe('quote_baselines_stale');
    expect(row?.grand).toBeNull();
    expect(row?.status).toBe('draft');
  }, 60_000);
});

/** A product of this suite's own, so nothing seeded is disturbed by publishing it twice. */
function productRequest(productId: string, pricePerSqm: bigint): Record<string, unknown> {
  return {
    id: productId,
    slug: productId,
    skuPrefix: 'WALK',
    fields: {
      nameTh: 'สินค้าทดสอบการเดินใบเสนอราคา',
      categoryId: 'louvers',
      summaryTh: 'สินค้าสำหรับเดินเรื่องใบเสนอราคาตั้งแต่ต้นจนจบ',
      heroImage: '/images/probe.svg',
      leadTimeDays: [7, 14],
      pricePerSqm: { unit: 'THB.satang/m2', digits: pricePerSqm.toString() },
      minBillableSqUm: { unit: 'um2', digits: '500000000000' },
      elevation: { panels: 1, operation: 'fixed', infill: 'louvre' },
    },
    options: {
      profile_color: {
        kind: 'sku',
        sortOrder: 0,
        valueCodes: ['SG', 'WH', 'BK'],
        defaultValueCode: 'SG',
      },
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
