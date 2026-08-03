import { describe, expect, it } from 'vitest';
import { productSchema } from '@wewin/core/schema';
import { products as coreProducts } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { fromDocument, referencedGroupCodes, toDocument } from '../src/compile.js';
import { canonicalJson, documentHash } from '../src/hash.js';

/**
 * The document has to be able to hold the catalogue, exactly.
 *
 * This is the check that the storage shape is not quietly lossy. It needs no database:
 * the two conversions are pure, and running them over all 81 products and re-parsing the
 * result with core's own zod schema is a stronger statement than any single fixture —
 * if a field is dropped, `productSchema` says which one.
 */
describe('document round-trip', () => {
  it('carries all 81 products through storage and back into a valid Product', () => {
    expect(coreProducts.length).toBe(81);

    for (const product of coreProducts) {
      const restored = fromDocument(toDocument(product));
      const parsed = productSchema.safeParse(restored);

      expect(parsed.success, `${product.id}: ${parsed.error?.message ?? ''}`).toBe(true);
      expect(restored).toStrictEqual(product);
    }
  });

  it('prices identically before and after the round-trip', () => {
    // Money is where a lost digit would matter and where it would be least visible, so
    // the round-trip is checked through the price rather than only through the fields.
    for (const product of coreProducts) {
      const restored = fromDocument(toDocument(product));
      const measures = Object.fromEntries(
        product.groups
          .filter((group) => group.kind === 'custom')
          .map((group) => [group.code, group.kind === 'custom' ? group.defaultUm : 0n]),
      );

      expect(calcPrice(restored, {}, measures, 3).totalMinor).toBe(
        calcPrice(product, {}, measures, 3).totalMinor,
      );
    }
  });

  it('keeps stock out of the frozen document', () => {
    // Plan 5 point 2. A CHECK in 0001_catalog_freeze.sql says the same thing to the
    // database; this says it to whoever edits `toDocument`.
    for (const product of coreProducts) {
      expect(canonicalJson(toDocument(product))).not.toContain('"available"');
    }

    // …and the value that comes back is the live one, not a frozen one.
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const soldOut = fromDocument(toDocument(source), () => false);
    const skuGroups = soldOut.groups.filter((group) => group.kind === 'sku');

    expect(skuGroups.length).toBeGreaterThan(0);
    expect(skuGroups.every((group) => group.values.every((value) => !value.available))).toBe(true);
  });

  it('reports the groups an area rule reads, which the AST does not name', () => {
    const areaRule = coreProducts
      .flatMap((product) => product.rules)
      .find((rule) => rule.id === 'awn4t-max-area');
    if (!areaRule) throw new Error('the awn-4t area rule is missing from the catalogue');

    // `{ n: 'area' }` names no group, but `calcAreaSqUm` reads exactly these two — a
    // referenced-code list that said "nothing" would let the publish-time integrity
    // check pass for a version that cannot evaluate the rule at all.
    expect(referencedGroupCodes(areaRule.when)).toStrictEqual(['height', 'width']);
  });
});

describe('document hash', () => {
  it('ignores key order, because jsonb does not preserve it', () => {
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const document = toDocument(source);
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(document).reverse())),
    ) as typeof document;

    expect(documentHash(reordered)).toBe(documentHash(document));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(document));
  });

  it('changes when a price changes', () => {
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');

    const document = toDocument(source);
    const dearer = { ...document, pricePerSqmMinor: '999900' };

    expect(documentHash(dearer)).not.toBe(documentHash(document));
  });
});

/*
 * The satang that got away.
 *
 * `fromDocument` used to read money with `Number(BigInt(minor) / 100n)`, and integer
 * division does not complain: a document holding ฿1,500.01/m² came back as ฿1,500 and
 * compared equal to a catalogue that says ฿1,500. It was found by hand-mutating exactly
 * that field in Postgres while `apps/api/tests/catalog-fidelity.pg.test.ts` watched, and
 * the test stayed green — the round trip was lossy in the one direction nothing else
 * covers, because `toDocument` can only ever produce whole baht from a whole-baht table.
 *
 * The column has a CHECK for this (`products_price_whole_baht`); the jsonb document
 * cannot, so the read is the only place left to refuse it.
 */
describe('money the pricer could not honour', () => {
  const document = () => {
    const source = coreProducts[0];
    if (!source) throw new Error('the catalogue fixture is empty');
    return toDocument(source);
  };

  it('refuses a base price that is not a whole baht instead of truncating it', () => {
    const fraction = { ...document(), pricePerSqmMinor: '150001' };

    expect(() => fromDocument(fraction)).toThrow(/not a whole baht/);
  });

  it('refuses a flat surcharge with a fraction of a baht in it', () => {
    const base = document();
    const withFlat = {
      ...base,
      groups: [
        {
          kind: 'sku' as const,
          code: 'probe',
          labelTh: 'probe',
          input: 'chip' as const,
          includeInSkuCode: false,
          defaultValue: 'X',
          values: [
            {
              code: 'X',
              labelTh: 'x',
              delta: { type: 'flat' as const, currency: 'THB' as const, minor: '180050' },
            },
          ],
        },
      ],
    };

    expect(() => fromDocument(withFlat)).toThrow(/not a whole baht/);
  });

  it('refuses a percent surcharge that is not a whole percent', () => {
    const base = document();
    const withPercent = {
      ...base,
      groups: [
        {
          kind: 'sku' as const,
          code: 'probe',
          labelTh: 'probe',
          input: 'chip' as const,
          includeInSkuCode: false,
          defaultValue: 'X',
          values: [
            { code: 'X', labelTh: 'x', delta: { type: 'percent' as const, bp: 801 } },
          ],
        },
      ],
    };

    expect(() => fromDocument(withPercent)).toThrow(/not a whole percent/);
  });

  it('still accepts every figure the real catalogue holds', () => {
    // The guard must refuse fractions and nothing else; all 81 products go through it in
    // the round-trip test above, and this states the claim where the guard is defined.
    for (const product of coreProducts) {
      expect(() => fromDocument(toDocument(product))).not.toThrow();
    }
  });
});
