import { describe, expect, it } from 'vitest';
import { getProductBySlug } from '@wewin/core/fixtures';
import { calcPrice } from '@wewin/core/pricing';
import { validate } from '@wewin/core/validation';
import { optionStatesFor } from '@wewin/core/option-states';
import { buildSkuCode } from '@wewin/core/sku';
import { configHash } from '@wewin/core/hash';
import type { Product } from '@wewin/core';
import {
  decodePriceRequest,
  decodePriceResponse,
  encodePriceBreakdown,
  encodePriceRequest,
  encodePriceResponse,
  priceBreakdownWireSchema,
  priceRequestWireSchema,
  toPriceBreakdown,
} from '../src/pricing.js';
import type { PriceRequest, PriceResponse } from '../src/pricing.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// A real uuid and a real hex digest: the schemas pin both formats, and a placeholder
// that could never come out of the server would only ever test itself.
const ref = {
  productVersionId: '3f1c9d2e-5b47-4a10-9c8e-71d2f0a6b3e4',
  documentHash: 'a'.repeat(64),
};

function fixture(slug: string): Product {
  const product = getProductBySlug(slug);
  if (!product) throw new Error(`test fixture missing product "${slug}"`);
  return product;
}

/** The configuration `Configure.tsx` opens with: 320 × 160, catalogue defaults. */
const awning = fixture('awn-4t');
const measures = { width: 3_200_000n, height: 1_600_000n };
const selections = { profile_color: 'DW', glass_color: 'GRN', glass_thickness: 'T5' };

describe('pricing over the wire', () => {
  it('round-trips a real breakdown through JSON without touching a float', () => {
    const price = calcPrice(awning, selections, measures, 3);
    // The v1.0.0 figure this codebase pinned: ฿7,680 for 320 × 160 before options.
    expect(price.totalMinor).toBeGreaterThan(0n);

    const decoded = toPriceBreakdown(priceBreakdownWireSchema.parse(wire(encodePriceBreakdown(price))));
    expect(decoded).toEqual(price);
  });

  it('round-trips the breakdown for every product at its own defaults', () => {
    for (const qty of [1, 7, 99]) {
      const price = calcPrice(awning, selections, measures, qty);
      const decoded = toPriceBreakdown(
        priceBreakdownWireSchema.parse(wire(encodePriceBreakdown(price))),
      );
      expect(decoded.totalMinor).toBe(price.totalMinor);
      expect(decoded.unitPriceScaledMinor).toBe(price.unitPriceScaledMinor);
      expect(decoded.currency).toBe('THB');
    }
  });

  it('keeps the scaled unit price apart from the satang beside it', () => {
    const price = calcPrice(awning, selections, measures, 1);
    const json = JSON.stringify(encodePriceBreakdown(price));

    // Two figures a million million apart, in adjacent fields, both strings of digits.
    // The tag is the only thing between them.
    expect(json).toContain('"unitPriceMinor":{"unit":"THB.satang"');
    expect(json).toContain('"unitPriceScaledMinor":{"unit":"THB.satang/1e12"');
    expect(price.unitPriceScaledMinor).not.toBe(price.unitPriceMinor);
  });

  it('carries no separate currency field to contradict the amounts', () => {
    const price = calcPrice(awning, selections, measures, 1);
    const json = JSON.stringify(encodePriceBreakdown(price));

    expect(json).not.toContain('"currency"');
    expect(toPriceBreakdown(priceBreakdownWireSchema.parse(JSON.parse(json))).currency).toBe('THB');
  });

  it('refuses a breakdown whose amounts are not all one currency', () => {
    const price = calcPrice(awning, selections, measures, 1);
    const encoded = wire(encodePriceBreakdown(price)) as {
      baseMinor: { unit: string; digits: string };
    };
    // `quoteTotal` adds `totalMinor` across lines with no currency in sight
    // (quote.ts:169), so a stray cent figure would be summed as if it were satang.
    encoded.baseMinor = { unit: 'USD.cent', digits: encoded.baseMinor.digits };

    const result = priceBreakdownWireSchema.safeParse(encoded);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('baseMinor');
  });

  it('round-trips a price request, measurements and entered units intact', () => {
    const request: PriceRequest = {
      ...ref,
      productId: awning.id,
      selections,
      measures,
      // The customer measured in inches; the value is still canonical micrometres and
      // the unit rides beside it (plan 4.1) rather than rewriting it.
      enteredUnits: { width: 'in', height: 'cm' },
      qty: 2,
    };

    expect(decodePriceRequest(wire(encodePriceRequest(request)))).toEqual(request);
  });

  it('will not read a measurement in the unit that was on screen', () => {
    const encoded = wire(encodePriceRequest({
      ...ref,
      productId: awning.id,
      selections,
      measures,
      enteredUnits: { width: 'cm', height: 'cm' },
      qty: 1,
    })) as { measures: Record<string, { unit: string; digits: string }> };

    encoded.measures['width'] = { unit: 'cm', digits: '320' };
    expect(priceRequestWireSchema.safeParse(encoded).success).toBe(false);
  });

  it('rejects a request with no handle on the document it was priced against', () => {
    const request = wire(encodePriceRequest({
      ...ref,
      productId: awning.id,
      selections,
      measures,
      enteredUnits: {},
      qty: 1,
    })) as Record<string, unknown>;

    // Plan 5 point 5: the pair is not optional, so an endpoint cannot be written that
    // forgets to ask for it.
    delete request['documentHash'];
    expect(priceRequestWireSchema.safeParse(request).success).toBe(false);
  });

  it('rejects a quantity outside the bounds the reducer clamps to', () => {
    const base = wire(encodePriceRequest({
      ...ref,
      productId: awning.id,
      selections,
      measures,
      enteredUnits: {},
      qty: 1,
    })) as Record<string, unknown>;

    expect(priceRequestWireSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
    expect(priceRequestWireSchema.safeParse({ ...base, qty: 100 }).success).toBe(false);
    expect(priceRequestWireSchema.safeParse({ ...base, qty: 2.5 }).success).toBe(false);
    expect(priceRequestWireSchema.safeParse({ ...base, qty: 99 }).success).toBe(true);
  });

  it('round-trips a whole response — the page a customer is looking at', () => {
    // Deliberately a configuration that raises something: a 400 × 250 opening is over
    // the 8 m² cap, so `issues` and `optionStates` are not empty.
    const big = { width: 4_000_000n, height: 2_500_000n };
    const enteredUnits = { width: 'cm', height: 'cm' } as const;

    const response: PriceResponse = {
      ...ref,
      skuCode: buildSkuCode(awning, selections),
      configHash: configHash(buildSkuCode(awning, selections), big),
      price: calcPrice(awning, selections, big, 1),
      issues: validate(awning, selections, big, enteredUnits),
      optionStates: optionStatesFor(awning, selections, big, enteredUnits),
    };

    expect(response.issues.length).toBeGreaterThan(0);
    expect(decodePriceResponse(wire(encodePriceResponse(response)))).toEqual(response);
  });
});
