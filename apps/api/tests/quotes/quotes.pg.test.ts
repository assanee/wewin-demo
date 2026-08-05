import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type Pool } from '@wewin/db/client';
import { eq } from '@wewin/db/sql';
import { quoteLines, quoteOverrides } from '@wewin/db/schema';
import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type { OrderWire, PriceRequestWire } from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { client, makeActor, type Actor, type Json } from '../orders/support/lifecycle-app';
import { bootQuotesApp, quotesEnv, type QuotesApp } from './support/quotes-app';

/**
 * The sales-editable quote, over real HTTP, against a real Postgres, with nothing stubbed.
 *
 * Nothing here is asserted through a service call, because every property this round is about
 * lives *between* the layers:
 *
 *   - `quote_lines_guard_write()` is the thing that refuses to reprice a promised line, and it
 *     is a trigger — a test that never issues a statement never meets it;
 *   - the stamp-then-insert order that supersession requires is a fact about a partial unique
 *     index, and an in-memory double has no index;
 *   - the ownership term is a WHERE clause, and a mock has no WHERE clause;
 *   - "the API never accepts a money figure" is a claim about a request body reaching a
 *     controller, which can only be tested by sending one.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

const tag = randomUUID().slice(0, 8);

describeWithPg('the sales-editable quote end to end', () => {
  let pool: Pool;
  let db: Database;
  let app: QuotesApp;
  let call: ReturnType<typeof client>;

  /** Holds every grant a quote write needs. */
  let sales: Actor;
  /** Holds `orders.read`/`orders.write` and no quote permission at all. */
  let clerk: Actor;
  /** A signed-in person with nothing. Owns their own orders and sees no concession. */
  let customer: Actor;

  let line: PriceRequestWire;

  beforeAll(async () => {
    pool = createPool(url ?? '');
    db = createDatabase(pool);

    app = await bootQuotesApp(quotesEnv(url ?? ''));
    call = client(app.baseUrl);

    sales = await makeActor(db, app, `quote sales ${tag}`, [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    clerk = await makeActor(db, app, `quote clerk ${tag}`, ['orders.read', 'orders.write']);
    customer = await makeActor(db, app, `quote customer ${tag}`, []);

    line = await liveLine(call);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /* ---------------------------------------------------------------- *
   * Helpers that speak the API
   * ---------------------------------------------------------------- */

  const auth = (actor: Actor): { token: string } => ({ token: actor.token });

  const newOrder = async (): Promise<string> => {
    const created = await call('POST', '/orders', { ...auth(sales), body: {} });
    expect(created.status).toBe(201);
    return (created.body as OrderWire).id;
  };

  const quote = async (orderId: string, actor: Actor = sales): Promise<QuoteWire> => {
    const read = await call('GET', `/orders/${orderId}/quote`, auth(actor));
    expect(read.status).toBe(200);
    return read.body as QuoteWire;
  };

  const post = async (
    orderId: string,
    path: string,
    body: Record<string, unknown>,
    actor: Actor = sales,
  ): Promise<Json> => call('POST', `/orders/${orderId}/quote${path}`, { ...auth(actor), body });

  /** Add one configured line and hand back the quote it produced. */
  const addLine = async (orderId: string, over: Record<string, unknown> = {}): Promise<QuoteWire> => {
    const current = await quote(orderId);
    const added = await post(orderId, '/lines', {
      expect: { quoteRevision: current.quoteRevision },
      line,
      ...over,
    });
    /* The body rather than the status, because a 422 from a CHECK names the constraint and
     * `expected 422 to be 201` names nothing. */
    if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    return added.body as QuoteWire;
  };

  const minor = (wire: unknown): bigint => toBigInt(wire as never);

  /* ================================================================ *
   * The machine layer
   * ================================================================ */

  describe('computed is the machine’s, always — plan 7.9(ก)', () => {
    it('prices a line itself from the catalogue handle the client quoted', async () => {
      const orderId = await newOrder();
      const after = await addLine(orderId);

      const [only] = after.lines;
      expect(only?.kind).toBe('catalog');
      expect(only?.computedTotalThbMinor).not.toBeNull();
      expect(only?.chargeTotalThbMinor).toBeNull();
      /* No override yet, so the effective figure is the computed one and nothing else. */
      expect(only?.effectiveTotalThbMinor).toEqual(only?.computedTotalThbMinor);
      expect(minor(after.money.grandTotalThbMinor)).toBeGreaterThan(0n);
    });

    /*
     * ⭐ There is no field for a price to arrive in, and `z.strictObject` is what says so. A
     * request that carries one is a 400 before anything is loaded — which is the difference
     * between "we ignore it" and "it cannot be sent".
     */
    it('refuses a request that carries a money figure at all', async () => {
      const orderId = await newOrder();
      const current = await quote(orderId);

      const forged = await post(orderId, '/lines', {
        expect: { quoteRevision: current.quoteRevision },
        line,
        computedTotalThbMinor: { unit: 'THB.satang', digits: '1' },
      });

      expect(forged.status).toBe(400);
    });

    it('refuses a catalogue handle that is not the published one — 409 with the document', async () => {
      const orderId = await newOrder();
      const current = await quote(orderId);

      const stale = await post(orderId, '/lines', {
        expect: { quoteRevision: current.quoteRevision },
        line: { ...line, documentHash: 'f'.repeat(64) },
      });

      expect(stale.status).toBe(409);
      const details = (stale.body as { error: { details: { stale: { error: string } } } }).error.details;
      expect(details.stale.error).toBe('catalog_stale');
    });
  });

  /* ================================================================ *
   * The precondition
   * ================================================================ */

  describe('the 409s are two different 409s — plan 7.9(จ)', () => {
    it('refuses a write against a revision somebody else has moved past', async () => {
      const orderId = await newOrder();
      const before = await quote(orderId);

      await addLine(orderId);

      const late = await post(orderId, '/lines', {
        expect: { quoteRevision: before.quoteRevision },
        line,
      });

      expect(late.status).toBe(409);
      expect((late.body as { error: { details: { reason: string } } }).error.details.reason).toBe(
        'quote_stale',
      );
    });

    it('accepts the token it just handed out', async () => {
      const orderId = await newOrder();
      const first = await addLine(orderId);

      const second = await post(orderId, '/lines', {
        expect: { quoteRevision: first.quoteRevision },
        line,
      });

      expect(second.status).toBe(201);
      expect((second.body as QuoteWire).lines).toHaveLength(2);
    });

    it('changes the token when the quote changes and not otherwise', async () => {
      const orderId = await newOrder();
      const first = await addLine(orderId);

      expect((await quote(orderId)).quoteRevision).toBe(first.quoteRevision);

      const second = await addLine(orderId);
      expect(second.quoteRevision).not.toBe(first.quoteRevision);
    });
  });

  /* ================================================================ *
   * The override layer
   * ================================================================ */

  describe('one anchor per meaning — plan 7.9(ข)', () => {
    it('normalises a per-unit price onto the line total and remembers the box', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'unit_price',
        enteredValueText: '9,000',
        reasonCode: 'price_match',
      });

      expect(set.status).toBe(201);
      const after = set.body as QuoteWire;

      /* qty is 2 on the fixture line, so ฿9,000 per unit is ฿18,000 for the line. */
      expect(minor(after.lines[0]?.effectiveTotalThbMinor)).toBe(1_800_000n);
      /* …and the computed figure is untouched: three layers, never collapsed. */
      expect(after.lines[0]?.computedTotalThbMinor).toEqual(target.computedTotalThbMinor);

      const [override] = after.sales?.overrides ?? [];
      expect(override?.enteredAs).toBe('unit_price');
      expect(override?.enteredValueText).toBe('9,000');
      expect(minor(override?.overrideThbMinor)).toBe(1_800_000n);
      expect(override?.computedThbMinor).toEqual(target.computedTotalThbMinor);
    });

    it('stores the absolute figure a percentage produced, never the percentage', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'percent_discount',
        enteredValueText: '-15%',
        reasonCode: 'relationship',
      });

      expect(set.status).toBe(201);
      const [override] = (set.body as QuoteWire).sales?.overrides ?? [];

      /* The conversation survives verbatim; the money is absolute. Plan 7.9(ก): a delta would
       * silently reprice the day the catalogue moves. */
      expect(override?.enteredValueText).toBe('-15%');
      const computed = minor(target.computedTotalThbMinor);
      expect(minor(override?.overrideThbMinor)).toBeLessThan(computed);
      expect(minor(override?.overrideThbMinor) % 100n).toBe(0n);
    });

    it('refuses a per-unit price typed against the document total', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'grand_total',
        enteredAs: 'unit_price',
        enteredValueText: '9000',
        reasonCode: 'volume',
      });

      expect(set.status).toBe(400);
    });

    it('refuses an override equal to what the machine already says', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const baht = minor(target.computedTotalThbMinor) / 100n;
      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: baht.toString(),
        reasonCode: 'correction',
      });

      /*
       * ⭐ THE STATUS ALONE PROVES NOTHING HERE, AND THAT IS WHY THE DETAILS ARE ASSERTED.
       *
       * `quote_overrides_value_differs` refuses the same row in Postgres and `pg-errors.ts`
       * translates it to the same 422, so a test that checked only the code stayed green with
       * the API's own refusal deleted — two mechanisms behind one assertion, which is evidence
       * for neither. The API's refusal carries `{ anchor }`; the constraint translation carries
       * `{ constraint }`. Asserting the first is what makes this a test of *this* module.
       */
      expect(set.status).toBe(422);
      const details = (set.body as { error: { details: Record<string, unknown> } }).error.details;
      expect(details['anchor']).toBe('line_total');
      expect(details).not.toHaveProperty('constraint');
    });
  });

  describe('a document total sets what the customer transfers, and VAT follows', () => {
    it('divides the tax back out rather than adding it on top — plan 4.4', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'grand_total',
        enteredAs: 'grand_total',
        enteredValueText: '10000',
        reasonCode: 'goodwill',
      });

      expect(set.status).toBe(201);
      const money = (set.body as QuoteWire).money;

      expect(minor(money.grandTotalThbMinor)).toBe(1_000_000n);
      expect(minor(money.netThbMinor) + minor(money.vatThbMinor)).toBe(1_000_000n);
      expect(minor(money.vatThbMinor)).toBeGreaterThan(0n);
    });
  });

  /* ================================================================ *
   * Append-only, and the order of statements
   * ================================================================ */

  describe('an override is replaced, never edited', () => {
    it('supersedes the predecessor and points it at its successor', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const first = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'price_match',
      });
      expect(first.status).toBe(201);

      const second = await post(orderId, '/overrides', {
        expect: { quoteRevision: (first.body as QuoteWire).quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8200',
        reasonCode: 'relationship',
      });
      expect(second.status).toBe(201);

      const live = (second.body as QuoteWire).sales?.overrides ?? [];
      expect(live).toHaveLength(1);
      expect(minor(live[0]?.overrideThbMinor)).toBe(820_000n);

      /*
       * ⭐ Both rows are still there, and the chain says which replaced which — the
       * stamp-then-insert order the partial unique index forces, proved from the rows rather
       * than from the fact that the request did not error.
       */
      const rows = await db
        .select({
          id: quoteOverrides.id,
          supersededAt: quoteOverrides.supersededAt,
          successor: quoteOverrides.supersededByOverrideId,
          reason: quoteOverrides.supersessionReason,
          value: quoteOverrides.overrideThbMinor,
        })
        .from(quoteOverrides)
        .where(eq(quoteOverrides.orderId, orderId));

      expect(rows).toHaveLength(2);
      const predecessor = rows.find((row) => row.value === 850_000n);
      const successor = rows.find((row) => row.value === 820_000n);

      expect(predecessor?.supersededAt).not.toBeNull();
      expect(predecessor?.reason).toBe('replaced');
      expect(predecessor?.successor).toBe(successor?.id);
      expect(successor?.supersededAt).toBeNull();
    });

    it('withdraws one without naming a successor', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'price_match',
      });
      const overrideId = (set.body as QuoteWire).sales?.overrides[0]?.id;
      if (overrideId === undefined) throw new Error('no override');

      const revoked = await post(orderId, `/overrides/${overrideId}/revocation`, {
        expect: { quoteRevision: (set.body as QuoteWire).quoteRevision },
      });

      expect(revoked.status).toBe(200);
      const after = revoked.body as QuoteWire;
      expect(after.sales?.overrides).toHaveLength(0);
      expect(after.lines[0]?.effectiveTotalThbMinor).toEqual(target.computedTotalThbMinor);
      expect(minor(after.sales?.marginConcessionThbMinor)).toBe(0n);
    });
  });

  /* ================================================================ *
   * ⭐ Plan 7.9(ง)(2) — the finding with a line number on it
   * ================================================================ */

  describe('a promised line cannot be repriced underneath the promise', () => {
    it('refuses the quantity change that would drop ฿17,000-for-two silently', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '17000',
        reasonCode: 'volume',
      });
      expect(set.status).toBe(201);

      const revised = await post(orderId, `/lines/${target.id}/revision`, {
        expect: { quoteRevision: (set.body as QuoteWire).quoteRevision },
        line: { ...line, qty: 3 },
      });

      expect(revised.status).toBe(409);
      /* The message has to say what to do, not "reload and try again" — the recovery is one
       * extra deliberate act, and a retry loop is not it. */
      const body = revised.body as { error: { message: string; details: { operation: string } } };
      expect(body.error.details.operation).toBe('reprice_line');
      expect(body.error.message).toContain('ยกเลิก');

      /* The promise is still there and still ฿17,000 — the refusal did not half-apply. */
      const after = await quote(orderId);
      expect(minor(after.lines[0]?.effectiveTotalThbMinor)).toBe(1_700_000n);
      expect(after.lines[0]?.qty).toBe(2);
    });

    it('and allows it once the promise has been withdrawn', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '17000',
        reasonCode: 'volume',
      });
      const overrideId = (set.body as QuoteWire).sales?.overrides[0]?.id;
      if (overrideId === undefined) throw new Error('no override');

      const revoked = await post(orderId, `/overrides/${overrideId}/revocation`, {
        expect: { quoteRevision: (set.body as QuoteWire).quoteRevision },
      });

      const revised = await post(orderId, `/lines/${target.id}/revision`, {
        expect: { quoteRevision: (revoked.body as QuoteWire).quoteRevision },
        line: { ...line, qty: 3 },
      });

      expect(revised.status).toBe(200);
      expect((revised.body as QuoteWire).lines[0]?.qty).toBe(3);
    });

    /* The sentence the customer reads is the only freely editable field, and it is never a
     * repricing input — so it is not blocked by the promise. */
    it('but never refuses a change to the sentence the customer reads', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '17000',
        reasonCode: 'volume',
      });

      const presented = await post(orderId, `/lines/${target.id}/presentation`, {
        expect: { quoteRevision: (set.body as QuoteWire).quoteRevision },
        customerDescriptionTh: 'กระจกเทมเปอร์ 8 มม.',
      });

      expect(presented.status).toBe(200);
      const after = presented.body as QuoteWire;

      /* ⚠️ Plan 7.9(ค): the prose says 8 mm and the sku says whatever the selections resolve
       * to. Both survive, they disagree, and that is *allowed* — what must never happen is the
       * prose reaching the factory, which is `worksOrderLines`' job and is unit-tested there. */
      expect(after.lines[0]?.customerDescriptionTh).toBe('กระจกเทมเปอร์ 8 มม.');
      expect(after.lines[0]?.skuCode).toBe(target.skuCode);
    });
  });

  /* ================================================================ *
   * Free-form lines
   * ================================================================ */

  describe('free-form lines and service charges — plan 7.9(ค)’s "แถวใหม่"', () => {
    it('takes a typed charge as a baseline and not as something called "computed"', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);

      const charged = await post(orderId, '/charges', {
        expect: { quoteRevision: withLine.quoteRevision },
        customerDescriptionTh: 'ค่าติดตั้งหน้างาน',
        amountText: '2,000',
      });

      expect(charged.status).toBe(201);
      const added = (charged.body as QuoteWire).lines.find((row) => row.kind === 'freeform');

      expect(added?.computedTotalThbMinor).toBeNull();
      expect(minor(added?.chargeTotalThbMinor)).toBe(200_000n);
      expect(minor(added?.effectiveTotalThbMinor)).toBe(200_000n);
      /* A charge is not a concession. */
      expect(minor((charged.body as QuoteWire).sales?.marginConcessionThbMinor)).toBe(0n);
    });

    it('counts a credit line as a concession, with no override anywhere near it', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);

      const credited = await post(orderId, '/charges', {
        expect: { quoteRevision: withLine.quoteRevision },
        customerDescriptionTh: 'ส่วนลดพิเศษจากผู้จัดการ',
        amountText: '-1000',
      });

      expect(credited.status).toBe(201);
      /* ฿1,000 net is ฿1,070 the customer does not pay — plan 7.13's "a negative charge". */
      expect(minor((credited.body as QuoteWire).sales?.marginConcessionThbMinor)).toBe(107_000n);
    });

    it('refuses a line for nothing', async () => {
      const orderId = await newOrder();
      const current = await quote(orderId);

      const zero = await post(orderId, '/charges', {
        expect: { quoteRevision: current.quoteRevision },
        customerDescriptionTh: 'ไม่มีอะไร',
        amountText: '0',
      });

      expect(zero.status).toBe(422);
    });

    it('refuses a total set below the untaxed charges it would have to contain', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);

      const charged = await post(orderId, '/charges', {
        expect: { quoteRevision: withLine.quoteRevision },
        customerDescriptionTh: 'ค่าขนส่งต่างจังหวัด',
        amountText: '12000',
        isVatApplicable: false,
      });
      expect(charged.status).toBe(201);

      const impossible = await post(orderId, '/overrides', {
        expect: { quoteRevision: (charged.body as QuoteWire).quoteRevision },
        anchor: 'grand_total',
        enteredAs: 'grand_total',
        enteredValueText: '10000',
        reasonCode: 'other',
        noteTh: 'ลูกค้าต่อรองยอดรวม',
      });

      expect(impossible.status).toBe(422);
      /* And nothing was left behind by the refusal. */
      expect((await quote(orderId)).sales?.overrides).toHaveLength(0);
    });
  });

  /* ================================================================ *
   * Removal
   * ================================================================ */

  describe('taking a line off the quote', () => {
    it('deletes it before submit, because a draft is a cart', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const removed = await post(orderId, `/lines/${target.id}/removal`, {
        expect: { quoteRevision: withLine.quoteRevision },
      });

      expect(removed.status).toBe(200);
      expect((removed.body as QuoteWire).lines).toHaveLength(0);
    });

    /*
     * ⚠️ On a draft this refusal is **the API's alone**. `quote_lines_guard_write()` guards the
     * `removed_at` UPDATE, but a never-submitted line is `DELETE`d, the trigger's DELETE branch
     * asks only about `submitted_at`, and `quote_overrides_line_fk` is `ON DELETE CASCADE` — so
     * the database would take the promise with the line and say nothing. This test is therefore
     * evidence for a guard in `quotes.service.ts` and for no guard in Postgres, which is the
     * opposite of the usual division here and is worth knowing when reading it.
     */
    it('refuses to remove a line that carries a promise', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      const set = await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'goodwill',
      });

      const removed = await post(orderId, `/lines/${target.id}/removal`, {
        expect: { quoteRevision: (set.body as QuoteWire).quoteRevision },
      });

      expect(removed.status).toBe(409);
      expect(
        (removed.body as { error: { details: { operation: string } } }).error.details.operation,
      ).toBe('remove_line');
    });

    /**
     * ⭐ A browser cart cannot overwrite a quote sales has been editing.
     *
     * `SubmitOrderRequestWire.lines` is how a client that has never used the quote editor hands
     * its cart *in* — the storefront configurator keeps it in the browser. When a quote already
     * exists there are two candidate documents and no rule for which wins, which is plan
     * 7.9(ข)'s "which one wins" asked at the one endpoint where the answer is a contract. It is
     * refused, not merged.
     */
    it('refuses a cart in the submit body once the quote has lines of its own', async () => {
      const orderId = await newOrder();
      await addLine(orderId);

      const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
        ...auth(sales),
        body: {
          contact: { email: `quote-cart-${tag}@probe.invalid`, name: `quote probe ${tag}` },
          lines: [line],
        },
      });

      expect(submitted.status).toBe(409);
      expect(
        (submitted.body as { error: { details: { reason: string } } }).error.details.reason,
      ).toBe('quote_already_exists');
    });

    /*
     * The one place in this feature where the shape of the *write* depends on the locked row,
     * and therefore the concrete reason the lock precedes the payload schema (plan 7.4 trap 4).
     */
    it('stamps it after submit, because a sent quote is history', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      /*
       * ⚠️ No `lines` in the body, and that is the seam 5c closed.
       *
       * Submit prices `quote_lines` now. Sending the browser's cart for an order that already
       * has a quote is refused rather than merged — see the test below — because a stale cart
       * silently overwriting a negotiated quote is exactly the divergence this change ends.
       */
      const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
        ...auth(sales),
        body: {
          contact: { email: `quote-remove-${tag}@probe.invalid`, name: `quote probe ${tag}` },
        },
      });
      expect(submitted.status).toBe(200);

      const removed = await post(orderId, `/lines/${target.id}/removal`, {
        expect: { quoteRevision: withLine.quoteRevision },
      });

      expect(removed.status).toBe(200);
      expect((removed.body as QuoteWire).lines).toHaveLength(0);

      /* Stamped, not deleted: the row is still there and says who took it off and when. */
      const rows = await db
        .select({ id: quoteLines.id, removedAt: quoteLines.removedAt, by: quoteLines.removedByUserId })
        .from(quoteLines)
        .where(eq(quoteLines.orderId, orderId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.removedAt).not.toBeNull();
      expect(rows[0]?.by).toBe(sales.userId);
    });
  });

  /* ================================================================ *
   * Who sees what
   * ================================================================ */

  describe('audiences', () => {
    it('gives a customer the price and none of the negotiation', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'relationship',
        noteTh: 'ลูกค้าเก่าสิบปี',
      });

      /* The clerk holds `orders.read` and no quote permission: they may read the order and are
       * not thereby entitled to what the company was willing to concede. */
      const asClerk = await quote(orderId, clerk);
      expect(asClerk.sales).toBeNull();
      expect(JSON.stringify(asClerk)).not.toContain('ลูกค้าเก่าสิบปี');

      /*
       * ⭐ AND THE PER-LINE CONCESSION, WHICH IS ONE SUBTRACTION AWAY.
       *
       * `encodeLine` was audience-independent, so a customer's own GET carried
       * `computedTotalThbMinor` **and** `effectiveTotalThbMinor` on every line. `sales` was
       * stripped and the concession on each line was `computed − effective`, on a response that
       * otherwise carefully strips every concession-shaped fact into one nested block. That
       * contradicts this encoder's own stated rule: what the company was willing to come down to
       * is not the customer's record.
       *
       * `null` rather than "the effective figure twice", because a client that could not tell
       * the two apart would render "no discount" as confidently as it renders a real one.
       */
      expect(asClerk.lines[0]?.computedTotalThbMinor).toBeNull();
      expect(asClerk.lines[0]?.chargeTotalThbMinor).toBeNull();
      expect(toBigInt(asClerk.lines[0]?.effectiveTotalThbMinor as never)).toBe(850_000n);

      /* …and sales sees all of it. */
      const asSales = await quote(orderId);
      expect(asSales.sales?.overrides[0]?.noteTh).toBe('ลูกค้าเก่าสิบปี');
      expect(asSales.sales?.overrides[0]?.setByUserName).toBe(`quote sales ${tag}`);
      expect(asSales.lines[0]?.computedTotalThbMinor).not.toBeNull();
      /*
       * The other half of a `CatalogRef`, plus the product id — the three fields a
       * `ReviseLineRequestWire` needs that a quote line does not otherwise carry. Both were
       * missing for a round and qty was read-only on the editor as a direct result, so this
       * asserts the round trip rather than the presence: what the server serves is exactly what
       * the request that produced this line sent, which is what makes `+1` constructible.
       */
      expect(asSales.lines[0]?.documentHash).toBe(line.documentHash);
      expect(asSales.lines[0]?.productId).toBe(line.productId);

      const roundTrip = await post(orderId, `/lines/${asSales.lines[0]?.id ?? ''}/revision`, {
        expect: { quoteRevision: asSales.quoteRevision },
        line: {
          productVersionId: asSales.lines[0]?.productVersionId,
          documentHash: asSales.lines[0]?.documentHash,
          productId: asSales.lines[0]?.productId,
          selections: asSales.lines[0]?.selections,
          measures: asSales.lines[0]?.measures,
          enteredUnits: Object.fromEntries(
            Object.keys(asSales.lines[0]?.measures ?? {}).map((code) => [code, 'cm']),
          ),
          qty: 3,
        },
      });

      /*
       * ⚠️ 409 and not 400: the line still carries the ฿8,500 promise set above, and a request
       * built purely from the served quote is refused for the *right* reason — the promise —
       * rather than for a malformed handle. A 400 here would mean the fields do not round-trip.
       */
      expect(roundTrip.status).toBe(409);
      expect((roundTrip.body as { error: { details: { operation: string } } }).error.details.operation).toBe(
        'reprice_line',
      );
    });

    /* ================================================================ *
     * ⭐ A live document promise freezes the document — over HTTP
     * ================================================================ */

    /**
     * The API's sentence for `0018_quote_document_freeze.sql`, and the reason it is here as well
     * as in the trigger: a salesperson needs to be told *what to do*, and a translated
     * `restrict_violation` cannot say "withdraw the total you agreed, then edit the lines".
     *
     * Every request below used to return 200 or 201.
     */
    describe('a document total that has been agreed freezes the lines under it', () => {
      const withDocumentPromise = async (): Promise<{ orderId: string; quote: QuoteWire }> => {
        const orderId = await newOrder();
        const withLine = await addLine(orderId);

        const set = await post(orderId, '/overrides', {
          expect: { quoteRevision: withLine.quoteRevision },
          anchor: 'grand_total',
          enteredAs: 'grand_total',
          enteredValueText: '17000',
          reasonCode: 'relationship',
        });
        if (set.status !== 201) throw new Error(JSON.stringify(set.body));
        return { orderId, quote: set.body as QuoteWire };
      };

      const refusal = (response: Json): { reason: string; operation: string } =>
        (response.body as { error: { details: { reason: string; operation: string } } }).error
          .details;

      it('refuses a line added underneath it — the invisible discount', async () => {
        const { orderId, quote: current } = await withDocumentPromise();

        const added = await post(orderId, '/lines', {
          expect: { quoteRevision: current.quoteRevision },
          line,
        });

        expect(added.status).toBe(409);
        expect(refusal(added).reason).toBe('quote_document_promise');
        expect(refusal(added).operation).toBe('add_line');
      });

      it('refuses the last line being taken away, so the quote cannot become an invoice for nothing', async () => {
        const { orderId, quote: current } = await withDocumentPromise();
        const target = current.lines[0];
        if (!target) throw new Error('no line');

        const removed = await post(orderId, `/lines/${target.id}/removal`, {
          expect: { quoteRevision: current.quoteRevision },
        });

        expect(removed.status).toBe(409);
        expect(refusal(removed).operation).toBe('remove_line');
      });

      /*
       * ⚠️ The VAT *amount* is in plan 7.9(ค)'s "not editable" box and per-line taxability is
       * not — so this flip is a legitimate edit in general, and what is refused is making it
       * underneath a promise. One request moved ฿897.68 of the customer's money on the red
       * team's fixture, through the route whose whole purpose is prose nobody prices from.
       */
      it('refuses the taxability flip, and still lets the prose move', async () => {
        const { orderId, quote: current } = await withDocumentPromise();
        const target = current.lines[0];
        if (!target) throw new Error('no line');

        const untaxed = await post(orderId, `/lines/${target.id}/presentation`, {
          expect: { quoteRevision: current.quoteRevision },
          isVatApplicable: false,
        });
        expect(untaxed.status).toBe(409);
        expect(refusal(untaxed).operation).toBe('present_line');

        const described = await post(orderId, `/lines/${target.id}/presentation`, {
          expect: { quoteRevision: current.quoteRevision },
          customerDescriptionTh: 'กระจกเทมเปอร์ 8 มม.',
        });
        expect(described.status).toBe(200);
      });

      /*
       * ⭐ Both directions of the ordering problem `concession.ts` declares and nothing enforced.
       * Writing a line promise underneath a document promise made the measurement over-count by
       * ฿1,070; withdrawing one from underneath made it **under**-count by the same, which is
       * the fail-open direction and is the number the submit gate reads.
       */
      it('refuses a line promise written underneath it, and one withdrawn from underneath it', async () => {
        const { orderId, quote: current } = await withDocumentPromise();
        const target = current.lines[0];
        if (!target) throw new Error('no line');

        const promised = await post(orderId, '/overrides', {
          expect: { quoteRevision: current.quoteRevision },
          anchor: 'line_total',
          quoteLineId: target.id,
          enteredAs: 'line_total',
          enteredValueText: '8500',
          reasonCode: 'goodwill',
        });
        expect(promised.status).toBe(409);
        expect(refusal(promised).operation).toBe('line_override');

        /* The other direction, on a quote where the line promise was written first — the only
         * legal order. */
        const other = await newOrder();
        const withLine = await addLine(other);
        const line0 = withLine.lines[0];
        if (!line0) throw new Error('no line');

        const linePromise = await post(other, '/overrides', {
          expect: { quoteRevision: withLine.quoteRevision },
          anchor: 'line_total',
          quoteLineId: line0.id,
          enteredAs: 'line_total',
          enteredValueText: '8500',
          reasonCode: 'goodwill',
        });
        expect(linePromise.status).toBe(201);
        const promiseId = (linePromise.body as QuoteWire).sales?.overrides[0]?.id ?? '';

        const documentPromise = await post(other, '/overrides', {
          expect: { quoteRevision: (linePromise.body as QuoteWire).quoteRevision },
          anchor: 'grand_total',
          enteredAs: 'grand_total',
          enteredValueText: '8000',
          reasonCode: 'relationship',
        });
        expect(documentPromise.status).toBe(201);

        const revoked = await post(other, `/overrides/${promiseId}/revocation`, {
          expect: { quoteRevision: (documentPromise.body as QuoteWire).quoteRevision },
        });
        expect(revoked.status).toBe(409);
        expect(refusal(revoked).operation).toBe('line_override');
      });

      it('lets the document promise be withdrawn, and everything move again afterwards', async () => {
        const { orderId, quote: current } = await withDocumentPromise();
        const promiseId = current.sales?.overrides[0]?.id ?? '';

        const revoked = await post(orderId, `/overrides/${promiseId}/revocation`, {
          expect: { quoteRevision: current.quoteRevision },
        });
        expect(revoked.status).toBe(200);

        const added = await post(orderId, '/lines', {
          expect: { quoteRevision: (revoked.body as QuoteWire).quoteRevision },
          line,
        });
        expect(added.status).toBe(201);
      });
    });

    it('refuses a write to somebody who may read quotes but not write them', async () => {
      const orderId = await newOrder();
      const current = await quote(orderId);

      const attempt = await post(
        orderId,
        '/lines',
        { expect: { quoteRevision: current.quoteRevision }, line },
        clerk,
      );

      expect(attempt.status).toBe(403);
    });

    it('does not let a customer reach somebody else’s quote at all', async () => {
      const orderId = await newOrder();
      await addLine(orderId);

      const read = await call('GET', `/orders/${orderId}/quote`, auth(customer));
      /* 404 and not 403: an order that is not yours is one you cannot be told about. */
      expect(read.status).toBe(404);
    });
  });

  /* ================================================================ *
   * The submit gate
   * ================================================================ */

  describe('the verification pass — plan 7.9(จ)', () => {
    it('passes a quote whose baselines all still match', async () => {
      const orderId = await newOrder();
      const withLine = await addLine(orderId);
      const target = withLine.lines[0];
      if (!target) throw new Error('no line');

      await post(orderId, '/overrides', {
        expect: { quoteRevision: withLine.quoteRevision },
        anchor: 'line_total',
        quoteLineId: target.id,
        enteredAs: 'line_total',
        enteredValueText: '8500',
        reasonCode: 'price_match',
      });

      const verified = await post(orderId, '/verification', {});
      expect(verified.status).toBe(200);
      expect((verified.body as QuoteWire).sales?.staleBaselines).toHaveLength(0);
    });
  });
});

/**
 * A published product, its live catalogue handle, and a line configured at its defaults.
 *
 * Read out of the running application rather than out of the fixtures, so the handle is the one
 * the API will accept — which is the whole point of `productVersionId` + `documentHash`
 * travelling together (plan 5 point 5).
 */
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
