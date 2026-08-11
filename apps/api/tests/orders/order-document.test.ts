import { describe, expect, it } from 'vitest';

import { products } from '@wewin/core/fixtures';
import type { Product } from '@wewin/core';
import { fromNet } from '@wewin/core/vat';
import { encodeUm } from '@wewin/contract/measure';
import { toBigInt } from '@wewin/contract/exact';
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
