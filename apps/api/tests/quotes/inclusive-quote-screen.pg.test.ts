import { afterAll, describe, expect, it } from 'vitest';

import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type {
  OrderDocumentResponseWire,
  OrderDocumentWire,
  OrderWire,
  PriceRequestWire,
} from '@wewin/contract';
import type { QuoteWire } from '@wewin/contract/quote';

import { TaxCountryService } from '../../src/organisation/tax-country.service';
import { createPgHarness } from '../support/pg-harness';
import { client, makeActor } from '../orders/support/lifecycle-app';

/**
 * ⭐ Tasks 10 + 11: the money the staff screen shows is the money the customer is quoted.
 *
 * ── What was measured here before this pair of tasks, on this exact fixture ───────
 *
 * One configured line, qty 2, catalogue sum **฿13,824.00** (1 382 400 satang), destination `SG`
 * at 900 bp with `pricesIncludeTax: true`:
 *
 *   the quote screen   ฿14,791.68  — `DEFAULT_VAT_RULE`, 700 bp, added on top
 *   the pinned document ฿15,068.16 — 900 bp, still added on top, under `taxBasis: 'inclusive'`
 *
 * Two separate defects in one order. The screen and the document disagreed by ฿276.48 because
 * `effective()` hardcoded the Thai rate; and *both* were exclusive arithmetic under a document
 * that said `inclusive`, so the label Task 9 pinned was not merely unproven, it was **false**.
 * The right answer is ฿13,824.00 on both, with the VAT divided back out of it.
 *
 * ── Why the assertions are absolute figures and not only relationships ────────────
 *
 * `destination-pinning.pg.test.ts` passes today with the wrong totals, because it asserts only
 * what was *pinned* — the rate, the country, the basis label — and never what the arithmetic
 * did with them. A relationship (`screen == document`) would likewise have passed while both
 * were 700 bp exclusive. So every figure below is a number somebody can check by hand.
 *
 * ── Why a fresh database per test ─────────────────────────────────────────────────
 *
 * `SG` and `MY` are created here and `tax_countries_block_delete` means neither can be taken
 * back. Same reasoning, and the same `createPgHarness`, as `destination-pinning.pg.test.ts`.
 *
 * Skipped, not failed, without a database.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithPg = url === undefined ? describe.skip : describe;

/** The catalogue sum of the fixture line at qty 2 — the figure every case below starts from. */
const CATALOGUE_SUM = 1_382_400n;

const minor = (wire: unknown): bigint => toBigInt(wire as never);

interface Harness {
  readonly admin: { readonly id: string };
  readonly taxCountries: TaxCountryService;
  /** A draft owned by the sales actor, carrying this destination from the moment it exists. */
  readonly draftFor: (destinationCountry?: string) => Promise<string>;
  /** Add the fixture line through the quote editor, so the cart is `quote_lines` and not a body. */
  readonly addLine: (orderId: string) => Promise<QuoteWire>;
  /** `GET /orders/:id/quote` — what a salesperson is looking at. */
  readonly quoteScreen: (orderId: string) => Promise<QuoteWire>;
  /** Submit naming no lines: the quote is already there, and the document must come from it. */
  readonly submit: (orderId: string) => Promise<void>;
  readonly documentOf: (orderId: string) => Promise<OrderDocumentWire>;
}

describeWithPg('the quote screen and the pinned document, per destination', () => {
  const base = createPgHarness(url ?? '');

  const harness = async (): Promise<Harness> => {
    const { app, actor, db } = await base.harness();
    const call = client(app.baseUrl);

    const sales = await makeActor(db, app, 'inclusive screen sales', [
      'quotes.read',
      'quotes.write',
      'orders.read',
      'orders.write',
    ]);
    const line = await liveLine(call);

    const quoteScreen = async (orderId: string): Promise<QuoteWire> => {
      const read = await call('GET', `/orders/${orderId}/quote`, { token: sales.token });
      if (read.status !== 200) throw new Error(JSON.stringify(read.body));
      return read.body as QuoteWire;
    };

    return {
      admin: actor,
      taxCountries: app.app.get(TaxCountryService),
      quoteScreen,

      draftFor: async (destinationCountry) => {
        const created = await call('POST', '/orders', {
          token: sales.token,
          body:
            destinationCountry === undefined
              ? {}
              : { contact: { email: 'a@b.co', destinationCountry } },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        return (created.body as OrderWire).id;
      },

      addLine: async (orderId) => {
        const current = await quoteScreen(orderId);
        const added = await call('POST', `/orders/${orderId}/quote/lines`, {
          token: sales.token,
          body: { expect: { quoteRevision: current.quoteRevision }, line },
        });
        if (added.status !== 201) throw new Error(JSON.stringify(added.body));
        return added.body as QuoteWire;
      },

      submit: async (orderId) => {
        const submitted = await call('POST', `/orders/${orderId}/transitions/awaiting_payment`, {
          token: sales.token,
          body: { contact: { email: 'a@b.co' } },
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      },

      documentOf: async (orderId) => {
        const read = await call('GET', `/orders/${orderId}/document`, { token: sales.token });
        if (read.status !== 200) throw new Error(JSON.stringify(read.body));
        return (read.body as OrderDocumentResponseWire).document;
      },
    };
  };

  afterAll(base.closeOpened);

  /**
   * ⭐ The whole unit, on one order: the basis, the rate, the screen, and the document.
   *
   * The `netThbMinor` assertion is the one that could not have passed before Task 10 — under
   * exclusive arithmetic the net *is* the catalogue sum and the grand total is above it. Here
   * the catalogue sum is the grand total and the net is what is left after the tax is divided
   * back out: 1 382 400 × 10 000 ÷ 10 900 = 1 268 257 (half away from zero), VAT the remainder.
   */
  it('quotes an inclusive destination at the catalogue sum, tax divided out, screen and document alike', async () => {
    const { admin, taxCountries, draftFor, addLine, quoteScreen, submit, documentOf } =
      await harness();
    await taxCountries.create(
      { code: 'SG', nameTh: 'สิงคโปร์', rateBp: 900, treatment: 'standard', pricesIncludeTax: true },
      admin.id,
    );

    const orderId = await draftFor('SG');
    const withLine = await addLine(orderId);
    /* The machine layer, untouched by any of this: what `calcPrice` said the line costs. */
    expect(minor(withLine.lines[0]?.computedTotalThbMinor)).toBe(CATALOGUE_SUM);

    const onScreen = await quoteScreen(orderId);

    /* ① The printed rate. Left at `DEFAULT_VAT_RULE` the screen says "VAT 7%" over money
       computed at 9% — the totals would agree and the sentence beside them would not. */
    expect(onScreen.money.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });

    /* ② The quoted gross *is* the catalogue sum — ฿13,824.00, not ฿15,068.16. */
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_382_400n);

    /* ③ VAT backed *out* of the gross, not added on to it. */
    expect(minor(onScreen.money.netThbMinor)).toBe(1_268_257n);
    expect(minor(onScreen.money.vatThbMinor)).toBe(114_143n);
    expect(minor(onScreen.money.netThbMinor) + minor(onScreen.money.vatThbMinor)).toBe(
      minor(onScreen.money.grandTotalThbMinor),
    );
    expect(minor(onScreen.money.vatThbMinor)).toBe(
      divRoundHalfUp(minor(onScreen.money.grandTotalThbMinor) * 900n, 10_900n),
    );

    /*
     * ④ ⭐ The assertion that catches a missed `applyOverrides` baseline site.
     *
     * `baseline` is "what this quote would say with nothing negotiated", and nothing here has
     * been negotiated — so it must equal the effective money exactly. Left on `fromNet` it
     * lands ~9% above, and the dashboard shows staff a "before negotiation" figure higher than
     * what the customer is charged on *every* inclusive quote. The authority gate cannot catch
     * it: `measureMargin`'s input is `{ vat, lines, overrides }` and `measureFor` never calls
     * `applyOverrides`, so a gate assertion passes either way.
     */
    expect(onScreen.sales, 'the sales view is what carries the baseline').not.toBeNull();
    expect(minor(onScreen.sales?.baselineGrandTotalThbMinor)).toBe(
      minor(onScreen.money.grandTotalThbMinor),
    );

    await submit(orderId);
    const pinned = await documentOf(orderId);

    /* ⑤ The pinned label equals the branch that actually ran. This is what ties Task 9's pin
       to Task 10's formula: before this, the document said `inclusive` and the arithmetic was
       exclusive, and no constraint in the database compared them. */
    expect(pinned.taxBasis).toBe('inclusive');
    expect(pinned.vat).toStrictEqual({ rateBp: 900, treatment: 'standard' });

    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
    expect(minor(pinned.netThbMinor)).toBe(minor(onScreen.money.netThbMinor));
    expect(minor(pinned.vatThbMinor)).toBe(minor(onScreen.money.vatThbMinor));
  }, 60_000);

  /**
   * Exclusive is unchanged — at a rate this suite has never used before.
   *
   * 600 bp deliberately, and not 700: `DEFAULT_VAT_RULE` is 700, so an `effective()` that
   * ignored the destination entirely would still produce the right answer for a 700 bp country
   * and this test would pass for the wrong reason. At 600 the old behaviour is distinguishable
   * from the new one, which is the only way a passing exclusive test means anything.
   */
  it('leaves an exclusive destination adding the tax on top, at its own rate', async () => {
    const { admin, taxCountries, draftFor, addLine, quoteScreen, submit, documentOf } =
      await harness();
    await taxCountries.create(
      { code: 'MY', nameTh: 'มาเลเซีย', rateBp: 600, treatment: 'standard', pricesIncludeTax: false },
      admin.id,
    );

    const orderId = await draftFor('MY');
    await addLine(orderId);
    const onScreen = await quoteScreen(orderId);

    expect(onScreen.money.vat).toStrictEqual({ rateBp: 600, treatment: 'standard' });

    /* grand = net × 1.06, and the net is the catalogue sum. ฿13,824.00 → ฿14,653.44. */
    expect(minor(onScreen.money.netThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.vatThbMinor)).toBe(82_944n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_465_344n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(
      minor(onScreen.money.netThbMinor) + divRoundHalfUp(CATALOGUE_SUM * 600n, 10_000n),
    );

    await submit(orderId);
    const pinned = await documentOf(orderId);

    expect(pinned.taxBasis).toBe('exclusive');
    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
    expect(minor(pinned.netThbMinor)).toBe(minor(onScreen.money.netThbMinor));
    expect(minor(pinned.vatThbMinor)).toBe(minor(onScreen.money.vatThbMinor));
  }, 60_000);

  /**
   * An order that names no destination at all — the path every legacy cart takes.
   *
   * `resolveDestination(null, …)` answers `DEFAULT_VAT_RULE` and `exclusive`, so this is the
   * behaviour that must not have moved a satang. It is the regression half of the pair.
   */
  it('is unchanged for an order that names no destination', async () => {
    const { draftFor, addLine, quoteScreen, submit, documentOf } = await harness();

    const orderId = await draftFor();
    await addLine(orderId);
    const onScreen = await quoteScreen(orderId);

    expect(onScreen.money.vat).toStrictEqual({ rateBp: 700, treatment: 'standard' });
    expect(minor(onScreen.money.netThbMinor)).toBe(CATALOGUE_SUM);
    expect(minor(onScreen.money.vatThbMinor)).toBe(96_768n);
    expect(minor(onScreen.money.grandTotalThbMinor)).toBe(1_479_168n);

    await submit(orderId);
    const pinned = await documentOf(orderId);

    /* Absent, not `null` — the document names no country, so it carries no basis either. */
    expect(pinned.taxBasis).toBeUndefined();
    expect(minor(pinned.grandTotalThbMinor)).toBe(minor(onScreen.money.grandTotalThbMinor));
  }, 60_000);
});

/** `divRoundHalfUp` restated in the test, so the expected figure is not the code's own answer. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const doubled = numerator * 2n;
  const quotient = doubled / denominator;
  const rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  return rounded / 2n;
}

/**
 * A line the *running* catalogue would accept, built from the published document it names.
 *
 * Copied from `submit-seam.pg.test.ts` rather than shared, matching this directory's
 * convention of one self-contained helper per `.pg.test.ts` file.
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
