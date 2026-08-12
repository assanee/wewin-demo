import { describe, expect, it } from 'vitest';

import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { fromNet } from '@wewin/core/vat';
import { resolveFxRate, type FxSnapshot } from '@wewin/core/fx';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
import type { MoneyWire } from '@wewin/contract/money';
import { encodeThb, type OrderDocumentWire, type OrderLineRequestWire } from '@wewin/contract/order';

import { AppError } from '../../src/common/errors/app-error';
import { DEFAULT_VAT_RULE } from '../../src/orders/defaults';
import {
  absorbedDeltaMinor,
  assertScopeUnchanged,
  orderDocumentHash,
  priceOrderDocument,
  scopeViolations,
  type CatalogEntry,
  type PinnedFxInput,
} from '../../src/orders/order-document';

/**
 * The pinned document — what it contains, what it hashes to, and the guard that reads it.
 *
 * No database and no HTTP: everything here is arithmetic over a fixture catalogue, which is
 * the level at which the two properties worth pinning actually live.
 *
 *   **VAT is computed once over the sum, not per line.** Plan 4.3(ข)'s "one rounding point
 *   per layer". Taxing each line and adding those up gives a different total, and the
 *   difference is the invoice failing to foot against the single `grand_total` that every
 *   instalment, forfeit and refund references.
 *
 *   **The re-approval guard is on scope and never on price.** Plan 7.2 records that the
 *   designer nearly put this in backwards, and the reviewer's objection is the reason it is
 *   tested from both sides here: a *more expensive* fix must pass, and a *larger opening*
 *   must fail, whatever it costs.
 */

/** A product with both group kinds, chosen so a line has selections *and* measurements. */
function fixtureProduct(): Product {
  const product = products.find((candidate) => candidate.groups.some((group) => group.kind === 'custom'));
  if (!product) throw new Error('the fixture catalogue has no product with a measurement');
  return product;
}

const VERSION_ID = '11111111-2222-4333-8444-555555555555';
const HASH = 'a'.repeat(64);

function entryFor(product: Product): CatalogEntry {
  return { productVersionId: VERSION_ID, documentHash: HASH, product };
}

/** A line at the catalogue's own defaults, so nothing here depends on a rule being satisfied by luck. */
function lineFor(product: Product, overrides: { qty?: number; scale?: bigint } = {}): OrderLineRequestWire {
  const selections: Record<string, string> = {};
  const measures: Record<string, ReturnType<typeof encodeUm>> = {};
  const enteredUnits: Record<string, 'cm' | 'mm'> = {};

  for (const group of product.groups) {
    if (group.kind === 'sku') {
      selections[group.code] = group.defaultValue;
    } else {
      const scaled = overrides.scale === undefined ? group.defaultUm : group.defaultUm - overrides.scale;
      measures[group.code] = encodeUm(scaled < group.minUm ? group.minUm : scaled);
      enteredUnits[group.code] = group.unit;
    }
  }

  return {
    productVersionId: VERSION_ID,
    documentHash: HASH,
    productId: product.id,
    selections,
    measures,
    enteredUnits,
    qty: overrides.qty ?? 1,
  };
}

/**
 * Price a cart the way the pin now receives it: as quote lines with no money on them.
 *
 * `priceOrderDocument` takes `QuoteDocumentLine`s rather than bare `PriceRequestWire`s since 5c,
 * because the pin freezes what the *quote* says — which is the configurations, the charges, the
 * promises and their provenance. Every figure is still recomputed here by `calcPrice`; the only
 * thing that changed is that the caller is `quote_lines` rather than a request body.
 */
function priceOne(
  lines: readonly OrderLineRequestWire[],
  revision = 1,
  extra: Partial<Parameters<typeof priceOrderDocument>[0]> = {},
): ReturnType<typeof priceOrderDocument> {
  const product = fixtureProduct();
  return priceOrderDocument({
    lines: lines.map((request, index) => ({
      quoteLineId: `line-${String(index + 1)}`,
      seq: index + 1,
      request,
      isVatApplicable: true,
      customerDescriptionTh: null,
    })),
    charges: [],
    overrides: [],
    leadTimeDays: 30,
    catalog: new Map([[product.id, entryFor(product)]]),
    vat: DEFAULT_VAT_RULE,
    /*
     * A cart that names no destination — the shape every case in this file was written
     * against, and what `resolveDestination(null)` hands back beside `DEFAULT_VAT_RULE`. Both
     * fields became required on `PriceOrderParams` when the destination started travelling
     * inside the document; `...extra` is how the cases that care override them.
     */
    destinationCountry: null,
    taxBasis: 'exclusive',
    /* Baht, like every case written before the rate existed. `...extra` opts a case in. */
    fx: null,
    locale: 'th',
    coreVersion: 'test',
    revision,
    ...extra,
  });
}

const statusOf = (thrown: unknown): number | undefined =>
  thrown instanceof AppError ? thrown.status : undefined;

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('pricing and pinning a document', () => {
  const product = fixtureProduct();

  it('foots: grand = net + vat, with VAT taken once over the sum of the lines', () => {
    const priced = priceOne([lineFor(product), lineFor(product, { qty: 3 })]);

    expect(priced.grandTotalThbMinor).toBe(priced.netThbMinor + priced.vatThbMinor);

    const lineTotals = priced.document.lines.map((line) => toBigInt(line.netMinor));
    const sum = lineTotals.reduce((total, amount) => total + amount, 0n);
    expect(priced.netThbMinor).toBe(sum);

    /*
     * The mutation this is aimed at: tax each line and add the taxes up. On these two lines
     * that is off by a satang often enough to matter, and the assertion states the rule
     * rather than the number — `fromNet` over the sum is the one definition.
     */
    expect(priced.vatThbMinor).toBe(fromNet(sum, DEFAULT_VAT_RULE).vatMinor);
  });

  it('pins the catalogue handle on every line — the half of trap 3 that is a foreign key', () => {
    const priced = priceOne([lineFor(product)]);

    expect(priced.productVersionIds).toStrictEqual([VERSION_ID]);
    for (const line of priced.document.lines) {
      expect(line.productVersionId).toBe(VERSION_ID);
      expect(line.documentHash).toBe(HASH);
    }
  });

  it('refuses a line whose catalogue handle has moved, and hands back the current document', () => {
    /*
     * Plan 5 point 5 and trap 3 together: the customer configured against a version that has
     * since been republished. 409 rather than repricing them silently against a document
     * they never saw.
     */
    const stale = { ...lineFor(product), documentHash: 'b'.repeat(64) };
    const thrown = caught(() => priceOne([stale]));

    expect(statusOf(thrown)).toBe(409);
    expect(JSON.stringify(thrown instanceof AppError ? thrown.details : {})).toContain(HASH);
  });

  it('refuses a product that is not in the published catalogue', () => {
    const orphan = { ...lineFor(product), productId: 'no-such-product' };
    expect(statusOf(caught(() => priceOne([orphan])))).toBe(422);
  });

  it('hashes the document over everything except the hash, and reproduces it', () => {
    const priced = priceOne([lineFor(product)]);

    expect(priced.document.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(orderDocumentHash(priced.document)).toBe(priced.documentHash);

    /*
     * Key order must not matter, and this is not a hypothetical: `jsonb` stores a parsed
     * value, so the document that comes back out of Postgres has its keys in the server's
     * order and not in the one this process built. Hashing `JSON.stringify(row)` would
     * therefore disagree with the stored digest on every read — and the mismatch would look
     * exactly like the tampering the hash exists to detect.
     */
    const reordered = Object.fromEntries(
      Object.entries(priced.document).reverse(),
    ) as OrderDocumentWire;
    expect(Object.keys(reordered)).not.toStrictEqual(Object.keys(priced.document));
    expect(orderDocumentHash(reordered)).toBe(priced.documentHash);

    /* And it must actually depend on the contents, or it is a label rather than a checksum. */
    const tampered: OrderDocumentWire = { ...priced.document, revision: 2 };
    expect(orderDocumentHash(tampered)).not.toBe(priced.documentHash);
  });
});

describe('the re-approval guard — plan 7.2, on scope and never on price', () => {
  const product = fixtureProduct();
  const contracted = priceOne([lineFor(product), lineFor(product, { qty: 2 })]).document;

  it('lets a more expensive fix through, which is the case it exists for', () => {
    /*
     * The rejected proposal was "the recomputed price must not exceed the original". A design
     * that cannot be manufactured is usually fixed with something more expensive — a thicker
     * profile, double glazing, another lock point — so that guard would block precisely the
     * case it was built for. Here the proposal costs more and passes, and what the company
     * absorbs is recorded.
     */
    const proposal = bumped(contracted, 500_00n);

    expect(scopeViolations(contracted, proposal)).toStrictEqual([]);
    expect(caught(() => assertScopeUnchanged(contracted, proposal))).toBeUndefined();
    expect(absorbedDeltaMinor(contracted, proposal)).toBe(500_00n);
  });

  it('records a cheaper fix as a negative absorbed delta rather than as nothing', () => {
    // A signed number is what makes the cost-of-quality report add up over a year rather
    // than count only the expensive half.
    expect(absorbedDeltaMinor(contracted, bumped(contracted, -250_00n))).toBe(-250_00n);
  });

  it('refuses a larger opening, whatever it costs', () => {
    const first = contracted.lines[0];
    if (!first) throw new Error('fixture has no lines');

    const [code, measure] = Object.entries(first.measures)[0] ?? [];
    if (code === undefined || measure === undefined) throw new Error('fixture line has no measurement');

    const widened: OrderDocumentWire = {
      ...contracted,
      lines: [
        { ...first, measures: { ...first.measures, [code]: encodeUm(toBigInt(measure) + 1n) } },
        ...contracted.lines.slice(1),
      ],
    };

    const violations = scopeViolations(contracted, widened);
    expect(violations.map((violation) => violation.field)).toStrictEqual([`measures.${code}`]);
    expect(statusOf(caught(() => assertScopeUnchanged(contracted, widened)))).toBe(422);

    /* One micrometre. The guard is on the canonical integer, so "about the same size" is not a size. */
    const narrower: OrderDocumentWire = {
      ...contracted,
      lines: [
        { ...first, measures: { ...first.measures, [code]: encodeUm(toBigInt(measure) - 1n) } },
        ...contracted.lines.slice(1),
      ],
    };
    expect(scopeViolations(contracted, narrower)).toStrictEqual([]);
  });

  it('refuses a different product, a larger quantity, and a line nobody asked for', () => {
    const first = contracted.lines[0];
    const second = contracted.lines[1];
    if (!first || !second) throw new Error('fixture needs two lines');

    const swapped: OrderDocumentWire = {
      ...contracted,
      lines: [{ ...first, productId: 'something-else' }, second],
    };
    expect(scopeViolations(contracted, swapped).map((v) => v.field)).toContain('productId');

    const more: OrderDocumentWire = {
      ...contracted,
      lines: [{ ...first, qty: first.qty + 1 }, second],
    };
    expect(scopeViolations(contracted, more).map((v) => v.field)).toContain('qty');

    const extra: OrderDocumentWire = {
      ...contracted,
      lines: [...contracted.lines, { ...first, lineNo: 99 }],
    };
    expect(scopeViolations(contracted, extra).map((v) => v.field)).toContain('lineNo');
  });

  it('lets the selections change, because changing them is what a redesign is', () => {
    const first = contracted.lines[0];
    if (!first) throw new Error('fixture has no lines');

    const [group, value] = Object.entries(first.selections)[0] ?? [];
    if (group === undefined || value === undefined) throw new Error('fixture line has no selection');

    const restyled: OrderDocumentWire = {
      ...contracted,
      lines: [
        { ...first, selections: { ...first.selections, [group]: `${value}_ALT` } },
        ...contracted.lines.slice(1),
      ],
    };

    expect(scopeViolations(contracted, restyled)).toStrictEqual([]);
  });
});

/**
 * The same document, priced `delta` satang differently — and *only* differently priced.
 *
 * Every scope-bearing field is untouched, which is the point: plan 7.2's guard must see no
 * violation in a document that costs more, and the only way to state that is to change the
 * price and nothing else.
 */
function bumped(document: OrderDocumentWire, delta: bigint): OrderDocumentWire {
  return {
    ...document,
    grandTotalThbMinor: encodeThb(toBigInt(document.grandTotalThbMinor) + delta),
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ THE PINNED RATE — and the three identities that have to survive it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In baht the document satisfies:
 *
 *   ① net + vat = grand                     — always
 *   ② Σ(lines) + Σ(charges) = grand          — inclusive basis, no grand-total override
 *   ③ Σ(lines) + Σ(charges) = net            — exclusive basis, no grand-total override
 *
 * A conversion that broke any of them would put a page in front of a customer whose own
 * figures contradict each other. These assert them in the *foreign* currency, off the frozen
 * document, exactly as the printed page reads them — not off intermediate variables.
 */
const SGD_SNAPSHOT: FxSnapshot = { base: 'USD', rates: { USD: 1, THB: 36.5, SGD: 1.35 } };

const sgdRate = (spreadBp = 200, manual: string | null = null): PinnedFxInput => {
  const resolved = resolveFxRate('SGD', { spreadBp, manualRateThbPerUnit: manual }, SGD_SNAPSHOT);
  if (!resolved.ok) throw new Error(`expected a rate, got ${resolved.reason}`);
  return { rate: resolved.rate, observedAt: manual === null ? '2026-08-12T01:00:00.000Z' : null };
};

/**
 * Minor units out of a tagged wire amount, whatever currency it names.
 *
 * `toBigInt` and not `BigInt(wire.digits)`: `Exact` is opaque on purpose (`contract/exact.ts`)
 * and exposes no readable member, so reaching for `.digits` does not typecheck — which is the
 * type doing its job. `0n` for an absent figure is safe here because every assertion below is
 * an equality against another figure from the same document; a missing one lands as `0` and
 * fails loudly rather than being skipped.
 */
const minorOf = (wire: MoneyWire | undefined): bigint => (wire === undefined ? 0n : toBigInt(wire));

const fxOf = (document: OrderDocumentWire) => {
  const fx = document.fx;
  if (fx === undefined) throw new Error('expected the document to carry a pinned rate');
  return fx;
};

describe('⭐ a quotation for a foreign destination prints in that currency', () => {
  /** Three lines and two charges — one of them a credit, so signs are mixed. */
  const foreignDocument = (
    basis: 'inclusive' | 'exclusive',
    fx: PinnedFxInput = sgdRate(),
  ): OrderDocumentWire => {
    const product = fixtureProduct();
    return priceOne(
      [lineFor(product), lineFor(product, { qty: 3 }), lineFor(product, { scale: 2n })],
      1,
      {
        destinationCountry: 'SG',
        taxBasis: basis,
        fx,
        charges: [
          {
            quoteLineId: 'charge-1',
            seq: 90,
            netMinor: 250_000n,
            isVatApplicable: true,
            customerDescriptionTh: 'ค่าจัดส่ง',
          },
          {
            quoteLineId: 'charge-2',
            seq: 91,
            netMinor: -33_331n,
            isVatApplicable: true,
            customerDescriptionTh: 'ส่วนลดพิเศษ',
          },
        ],
      },
    ).document;
  };

  /**
   * ⚠️ A **sweep**, and it has to be one.
   *
   * The first version of this asserted the identity on the single document above and passed
   * against an implementation that converted VAT separately instead of subtracting — because
   * that document's three figures happened to round the same way under both rules. Deriving
   * VAT by a second conversion diverges on roughly one grand total in fifty at this rate, so
   * one fixture is a coin toss and a green result means nothing.
   *
   * A `grand_total` override is what makes the sweep possible: it sets the total to an exact
   * figure, `fromGrand` derives net and VAT from it, and 400 consecutive satang walk the
   * rounding boundary densely enough to hit the divergence many times over.
   */
  const withPromisedGrand = (grandThbMinor: bigint): OrderDocumentWire => {
    const product = fixtureProduct();
    return priceOne([lineFor(product)], 1, {
      destinationCountry: 'SG',
      taxBasis: 'exclusive',
      fx: sgdRate(),
      overrides: [
        {
          id: '99999999-8888-4777-8666-555555555555',
          anchor: 'grand_total',
          quoteLineId: null,
          computedThbMinor: null,
          overrideThbMinor: grandThbMinor,
          computedDays: null,
          overrideDays: null,
          enteredAs: 'amount',
          enteredValueText: String(grandThbMinor),
          reasonCode: 'negotiated',
          setByUserId: '11111111-1111-4111-8111-111111111111',
          setByUserName: 'ทดสอบ',
        },
      ],
    }).document;
  };

  it('① net + vat = grand, exactly, across 400 consecutive totals', () => {
    for (let grand = 100_000n; grand < 100_400n; grand++) {
      const fx = fxOf(withPromisedGrand(grand));
      expect(minorOf(fx.netMinor) + minorOf(fx.vatMinor)).toBe(minorOf(fx.grandTotalMinor));
    }
  });

  it('① holds on the ordinary document too, on both bases', () => {
    for (const basis of ['inclusive', 'exclusive'] as const) {
      const fx = fxOf(foreignDocument(basis));
      expect(minorOf(fx.netMinor) + minorOf(fx.vatMinor)).toBe(minorOf(fx.grandTotalMinor));
    }
  });

  it('② lines and charges sum to the grand total under an inclusive basis', () => {
    const document = foreignDocument('inclusive');
    const fx = fxOf(document);

    const column =
      document.lines.reduce((sum, line) => sum + minorOf(line.fxMinor), 0n) +
      document.charges.reduce((sum, charge) => sum + minorOf(charge.fxMinor), 0n);

    expect(column).toBe(minorOf(fx.grandTotalMinor));
    /* And the baht identity it mirrors still holds, so the two pages agree about what foots. */
    const bahtColumn =
      document.lines.reduce((sum, line) => sum + toBigInt(line.netMinor), 0n) +
      document.charges.reduce((sum, charge) => sum + toBigInt(charge.netMinor), 0n);
    expect(bahtColumn).toBe(toBigInt(document.grandTotalThbMinor));
  });

  it('③ lines and charges sum to the net under an exclusive basis', () => {
    const document = foreignDocument('exclusive');
    const fx = fxOf(document);

    const column =
      document.lines.reduce((sum, line) => sum + minorOf(line.fxMinor), 0n) +
      document.charges.reduce((sum, charge) => sum + minorOf(charge.fxMinor), 0n);

    expect(column).toBe(minorOf(fx.netMinor));
  });

  it('pins the provenance a reader would need years later, without asking any table', () => {
    const fx = fxOf(foreignDocument('exclusive'));

    expect(fx.currency).toBe('SGD');
    expect(fx.source).toBe('mid_market');
    expect(fx.spreadBp).toBe(200);
    expect(fx.observedAt).toBe('2026-08-12T01:00:00.000Z');
    expect(fx.provider).toEqual({ base: 'USD', thbPerBase: 36.5, unitPerBase: 1.35 });

    /* ⭐ The exact ratio reproduces the grand total. This is the property the whole pin
       exists for: no `tax_countries` read, no `fx_rates` read, just these two integers. */
    const grandThb = toBigInt(foreignDocument('exclusive').grandTotalThbMinor);
    const reproduced =
      (grandThb * 100n * BigInt(fx.rateDenominator) * 2n + BigInt(fx.rateNumerator) * 100n) /
      (BigInt(fx.rateNumerator) * 100n * 2n);
    expect(reproduced).toBe(minorOf(fx.grandTotalMinor));
  });

  it('reports the spread as applied, which is zero for a manual override', () => {
    /* THE RULE: an override is a rate somebody read off a bank's screen and already carries
       the bank's margin, so the percentage is not applied on top of it. */
    const fx = fxOf(foreignDocument('exclusive', sgdRate(200, '27.05')));

    expect(fx.source).toBe('manual');
    expect(fx.spreadBp).toBe(0);
    expect(fx.provider).toBeNull();
    /* No market observation exists for a rate a human typed, and inventing one would dress a
       policy figure up as a measurement. */
    expect(fx.observedAt).toBeNull();
    expect(fx.rateText).toBe('27.050000');
  });

  it('leaves the baht figures exactly where they were', () => {
    /* The books do not move. A presentment layer is additional fields beside the THB ones,
       never a reinterpretation of them. */
    const baht = priceOne([lineFor(fixtureProduct())], 1, {
      destinationCountry: 'SG',
      taxBasis: 'exclusive',
    });
    const foreign = priceOne([lineFor(fixtureProduct())], 1, {
      destinationCountry: 'SG',
      taxBasis: 'exclusive',
      fx: sgdRate(),
    });

    expect(foreign.netThbMinor).toBe(baht.netThbMinor);
    expect(foreign.vatThbMinor).toBe(baht.vatThbMinor);
    expect(foreign.grandTotalThbMinor).toBe(baht.grandTotalThbMinor);
    expect(foreign.document.currency).toBe('THB');
  });

  it('omits the block entirely on a baht quotation, rather than writing a null', () => {
    const document = priceOne([lineFor(fixtureProduct())]).document;

    expect(document.fx).toBeUndefined();
    expect('fx' in document).toBe(false);
    expect(document.lines[0]?.fxMinor).toBeUndefined();
  });

  it('changes the document hash, because a different rate is a different offer', () => {
    const cheap = orderDocumentHash(foreignDocument('exclusive', sgdRate(0)));
    const dear = orderDocumentHash(foreignDocument('exclusive', sgdRate(200)));

    expect(cheap).not.toBe(dear);
  });
});
