import { describe, expect, it } from 'vitest';
import { products } from '@wewin/core/fixtures';

import {
  catalogPriceDeltaSchema,
  createOptionValueRequestSchema,
  createProductRequestSchema,
  decodeLengthUm,
  decodePricePerSqmMinor,
  decodeStoredPriceDelta,
  draftOptionWireSchema,
  encodeLengthUm,
  encodePricePerSqmMinor,
  encodeStoredPriceDelta,
  positiveAreaSchema,
  positiveLengthSchema,
  pricePerSqmSchema,
  publishDraftRequestSchema,
  putDraftOptionRequestSchema,
  updateProductDraftRequestSchema,
  type StoredPriceDelta,
} from '../src/admin.js';
import { encodeMinBillableSqUm } from '../src/admin.js';
import { encodeMinor, encodeMinorPerSqm } from '../src/money.js';
import { encodeBasisPoints, encodeSqUm, encodeUm } from '../src/measure.js';
import { encodeElevation } from '../src/catalog.js';

/**
 * The write boundary, tested for the one thing it exists to make impossible.
 *
 * A read that misreads a unit shows a wrong number on a screen for as long as the page is
 * open. A *write* that misreads one stores a wrong number in a column that will be frozen
 * into a document and quoted from for the life of every order that references it. So the
 * assertions below are all of the same shape: take a payload that is plausible, correctly
 * typed as JSON, and means something else, and check that it does not parse.
 *
 * Everything goes through `JSON.parse(JSON.stringify(...))`, as `catalog.test.ts` does: an
 * object that only survives in-process proves nothing about a payload that crossed a
 * socket, and the write side is where somebody else's client is doing the writing.
 */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const hash = 'a'.repeat(64);
const uuid = '3f1c9d2e-5b47-4a10-9c8e-71d2f0a6b3e4';

describe('a centimetre where a micrometre is meant', () => {
  it('refuses a length whose digits count centimetres', () => {
    // The exact payload plan 4.1 warns about: 320 is a perfectly good number and it is
    // 320 cm, and nothing about `{"digits":"320"}` alone says which.
    expect(positiveLengthSchema.safeParse({ unit: 'cm', digits: '320' }).success).toBe(false);
    expect(positiveLengthSchema.safeParse(wire(encodeUm(3_200_000n))).success).toBe(true);
  });

  it('refuses a bare number where a length belongs', () => {
    expect(positiveLengthSchema.safeParse(3_200_000).success).toBe(false);
    expect(positiveLengthSchema.safeParse('3200000').success).toBe(false);
  });

  it('refuses an area tag where a length belongs, and the reverse', () => {
    expect(positiveLengthSchema.safeParse(wire(encodeSqUm(1n))).success).toBe(false);
    expect(positiveAreaSchema.safeParse(wire(encodeUm(1n))).success).toBe(false);
  });

  it('refuses a length at or below zero', () => {
    expect(positiveLengthSchema.safeParse(wire(encodeUm(0n))).success).toBe(false);
    expect(positiveLengthSchema.safeParse(wire(encodeUm(-25n))).success).toBe(false);
  });

  it('keeps a length exact through the decoder', () => {
    // Above 2^53: a `number` would have lost the low digits here, silently.
    const huge = 9_007_199_254_740_993n;
    const parsed = positiveLengthSchema.parse(wire(encodeUm(huge)));
    expect(decodeLengthUm(parsed)).toBe(huge);
    expect(decodeLengthUm(encodeLengthUm(huge))).toBe(huge);
  });
});

describe('a price that is not the rate it claims to be', () => {
  it('refuses a plain amount where a per-square-metre rate belongs', () => {
    /*
     * `THB.satang` and `THB.satang/m2` are both satang and both integers, and telling them
     * apart by field name alone is how a per-m² figure ends up added to a total. Here it is
     * the write direction: a rate column filled from an amount would be a price per square
     * metre that is really a one-off charge.
     */
    expect(pricePerSqmSchema.safeParse(wire(encodeMinor(150_000n, 'THB'))).success).toBe(false);
    expect(pricePerSqmSchema.safeParse(wire(encodeMinorPerSqm(150_000n, 'THB'))).success).toBe(true);
  });

  it('refuses another currency', () => {
    expect(pricePerSqmSchema.safeParse(wire(encodeMinorPerSqm(150_000n, 'USD'))).success).toBe(false);
  });

  it('refuses a fraction of a baht', () => {
    // `calcPrice` reaches `BigInt(product.pricePerSqm)` and would throw on ฿1,500.01, so
    // this is a price the server itself could not honour. Refused at the boundary rather
    // than at the compile, where the field name is long gone.
    expect(pricePerSqmSchema.safeParse(wire(encodeMinorPerSqm(150_001n, 'THB'))).success).toBe(false);
    expect(pricePerSqmSchema.safeParse(wire(encodeMinorPerSqm(0n, 'THB'))).success).toBe(false);
  });

  it('keeps satang exact through the decoder', () => {
    const parsed = pricePerSqmSchema.parse(wire(encodeMinorPerSqm(220_000n, 'THB')));
    expect(decodePricePerSqmMinor(parsed)).toBe(220_000n);
    expect(decodePricePerSqmMinor(encodePricePerSqmMinor(220_000n))).toBe(220_000n);
  });
});

describe('surcharges, in the units the columns hold', () => {
  it('refuses a percent that is not a whole percent', () => {
    // 850 bp is 8.5%, and `calcPrice` does `BigInt(value.delta.amount)` — 8.5 is not a
    // bigint. `option_values_delta_whole_units` says the same thing in Postgres.
    expect(
      catalogPriceDeltaSchema.safeParse(wire({ type: 'percent', amount: encodeBasisPoints(850n) })).success,
    ).toBe(false);
    expect(
      catalogPriceDeltaSchema.safeParse(wire({ type: 'percent', amount: encodeBasisPoints(800n) })).success,
    ).toBe(true);
  });

  it('refuses a flat surcharge that is not a whole baht', () => {
    expect(
      catalogPriceDeltaSchema.safeParse(wire({ type: 'flat', amount: encodeMinor(150n, 'THB') })).success,
    ).toBe(false);
  });

  it('refuses basis points where money belongs', () => {
    expect(
      catalogPriceDeltaSchema.safeParse(wire({ type: 'flat', amount: encodeBasisPoints(800n) })).success,
    ).toBe(false);
  });

  it('round-trips every delta shape through the storage form', () => {
    const cases: readonly StoredPriceDelta[] = [
      { type: 'none', minor: null, bp: null },
      { type: 'flat', minor: 45_000n, bp: null },
      { type: 'per_sqm', minor: 120_000n, bp: null },
      { type: 'percent', minor: null, bp: 800 },
    ];

    for (const stored of cases) {
      const parsed = catalogPriceDeltaSchema.parse(wire(encodeStoredPriceDelta(stored)));
      expect(decodeStoredPriceDelta(parsed)).toStrictEqual(stored);
    }
  });

  it('refuses to encode a row whose columns disagree with its own type', () => {
    // `option_values_delta_shape` makes this unrepresentable in Postgres. If a row ever
    // reaches here anyway, inventing ฿0 for it is the silent mispricing the CHECK exists
    // to prevent — so it throws instead.
    expect(() => encodeStoredPriceDelta({ type: 'flat', minor: null, bp: null })).toThrow(TypeError);
    expect(() => encodeStoredPriceDelta({ type: 'percent', minor: 100n, bp: null })).toThrow(TypeError);
  });
});

describe('draft options', () => {
  const bounds = {
    minUm: encodeUm(600_000n),
    maxUm: encodeUm(3_000_000n),
    stepUm: encodeUm(50_000n),
    defaultUm: encodeUm(1_200_000n),
  };

  it('accepts a measurement group whose bounds all carry their unit', () => {
    expect(
      draftOptionWireSchema.safeParse(wire({ kind: 'custom', sortOrder: 0, ...bounds })).success,
    ).toBe(true);
  });

  it('refuses a measurement group whose bounds are bare numbers', () => {
    expect(
      draftOptionWireSchema.safeParse(
        wire({ kind: 'custom', sortOrder: 0, minUm: 600_000, maxUm: 3_000_000, stepUm: 50_000, defaultUm: 1_200_000 }),
      ).success,
    ).toBe(false);
  });

  it('refuses a measurement group whose bounds are millimetres', () => {
    expect(
      draftOptionWireSchema.safeParse(
        wire({
          kind: 'custom',
          sortOrder: 0,
          minUm: { unit: 'mm', digits: '600' },
          maxUm: { unit: 'mm', digits: '3000' },
          stepUm: { unit: 'mm', digits: '50' },
          defaultUm: { unit: 'mm', digits: '1200' },
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a sku group with no values', () => {
    expect(
      draftOptionWireSchema.safeParse(wire({ kind: 'sku', sortOrder: 0, valueCodes: [], defaultValueCode: 'WH' }))
        .success,
    ).toBe(false);
  });

  it('refuses a value code in the wrong casing', () => {
    // Codes are concatenated into a sku code. Two spellings of one code are two codes, and
    // the place that finds out is a quote that cannot be matched to an order.
    expect(
      draftOptionWireSchema.safeParse(
        wire({ kind: 'sku', sortOrder: 0, valueCodes: ['wh'], defaultValueCode: 'wh' }),
      ).success,
    ).toBe(false);
  });
});

describe('every mutation names the draft it is editing', () => {
  it('refuses an option change with no expected hash', () => {
    const option = { kind: 'sku', sortOrder: 0, valueCodes: ['WH'], defaultValueCode: 'WH' };
    expect(putDraftOptionRequestSchema.safeParse(wire({ option })).success).toBe(false);
    expect(putDraftOptionRequestSchema.safeParse(wire({ expectedDocumentHash: hash, option })).success).toBe(true);
  });

  it('refuses a hash that is not a hex digest', () => {
    expect(updateProductDraftRequestSchema.safeParse(wire({ expectedDocumentHash: 'nope' })).success).toBe(false);
    expect(
      updateProductDraftRequestSchema.safeParse(wire({ expectedDocumentHash: 'A'.repeat(64) })).success,
    ).toBe(false);
  });

  it('refuses a publish that does not name a version', () => {
    expect(publishDraftRequestSchema.safeParse(wire({ expectedDocumentHash: hash })).success).toBe(false);
    expect(
      publishDraftRequestSchema.safeParse(wire({ expectedDocumentHash: hash, productVersionId: 'lvr-adj' })).success,
    ).toBe(false);
    expect(
      publishDraftRequestSchema.safeParse(wire({ expectedDocumentHash: hash, productVersionId: uuid })).success,
    ).toBe(true);
  });
});

describe('creating a product', () => {
  const [first] = products;
  if (!first) throw new Error('the fixture catalogue is empty');

  const fields = {
    nameTh: first.nameTh,
    categoryId: first.categoryId,
    summaryTh: first.summaryTh,
    heroImage: first.heroImage,
    leadTimeDays: first.leadTimeDays,
    pricePerSqm: encodePricePerSqmMinor(BigInt(first.pricePerSqm) * 100n),
    minBillableSqUm: encodeMinBillableSqUm(first.minBillableSqUm),
    elevation: encodeElevation(first.elevation),
  };

  const request = {
    id: 'probe-product',
    slug: 'probe-product',
    skuPrefix: 'PROBE',
    fields,
    options: {
      width: { kind: 'custom', sortOrder: 0, minUm: encodeUm(600_000n), maxUm: encodeUm(3_000_000n), stepUm: encodeUm(50_000n), defaultUm: encodeUm(1_200_000n) },
    },
  };

  it('accepts a well-formed request', () => {
    expect(createProductRequestSchema.safeParse(wire(request)).success).toBe(true);
  });

  it('refuses an upper-case slug', () => {
    expect(createProductRequestSchema.safeParse(wire({ ...request, slug: 'Probe-Product' })).success).toBe(false);
  });

  it('refuses a lower-case sku prefix', () => {
    expect(createProductRequestSchema.safeParse(wire({ ...request, skuPrefix: 'probe' })).success).toBe(false);
  });

  it('refuses an option group code that is not lower snake_case', () => {
    expect(
      createProductRequestSchema.safeParse(
        wire({ ...request, options: { 'Width Group': request.options.width } }),
      ).success,
    ).toBe(false);
  });

  it('refuses an elevation whose operation is not one core draws', () => {
    expect(
      createProductRequestSchema.safeParse(
        wire({ ...request, fields: { ...fields, elevation: { panels: 2, operation: 'levitate', infill: 'glass' } } }),
      ).success,
    ).toBe(false);
  });

  it('lets a cross-field elevation mistake through, on purpose', () => {
    /*
     * `movingPanels: [5]` on a two-panel elevation is nonsense, and this schema accepts it.
     *
     * That is the same stance `catalog.ts` takes and it is worth pinning rather than
     * discovering: the schemas here check *shape*, and the invariants that read one field
     * against another belong to core's `productSchema` and to Postgres (plan 5 point 3).
     * Restating this one here would be a second opinion about the same fact, and two
     * opinions is two things to keep in step.
     *
     * It is caught — `apps/api`'s draft compiler runs `productSchema.parse` on every edit
     * and answers 422, and `tests/admin/draft-document.test.ts` is where that is asserted.
     * If this ever starts returning `false`, the duplication has arrived and one of the two
     * checks should go.
     */
    expect(
      createProductRequestSchema.safeParse(
        wire({
          ...request,
          fields: { ...fields, elevation: { panels: 2, operation: 'slide', infill: 'glass', movingPanels: [5] } },
        }),
      ).success,
    ).toBe(true);
  });
});

describe('creating an option value', () => {
  it('refuses a swatch that is not #RRGGBB', () => {
    const base = { code: 'WH', labelTh: 'ขาว', delta: { type: 'none' }, sortOrder: 0 };
    expect(createOptionValueRequestSchema.safeParse(wire({ ...base, swatchHex: 'white' })).success).toBe(false);
    expect(createOptionValueRequestSchema.safeParse(wire({ ...base, swatchHex: '#FFFFFF' })).success).toBe(true);
  });
});
