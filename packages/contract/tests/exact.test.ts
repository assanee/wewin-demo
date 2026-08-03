import { describe, expect, it } from 'vitest';
import { encodeExact, exactSchema, toBigInt, unitOf } from '../src/exact.js';

const umSchema = exactSchema(['um']);

/** What `JSON.stringify` produces for a wire quantity, without any typed help. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('exact quantities', () => {
  it('is the reason this encoding exists at all', () => {
    expect(() => JSON.stringify({ um: 3_200_000n })).toThrow(TypeError);
    expect(() => JSON.stringify(encodeExact('um', 3_200_000n))).not.toThrow();
  });

  it('writes the unit beside the digits, and the digits as a string', () => {
    expect(asJson(encodeExact('um', 3_200_000n))).toEqual({ unit: 'um', digits: '3200000' });
    expect(asJson(encodeExact('THB.satang', 879_100n))).toEqual({
      unit: 'THB.satang',
      digits: '879100',
    });
  });

  it('round-trips every value the system can produce', () => {
    // 0, a window, a price, and unitPriceScaledMinor at full working precision.
    for (const value of [0n, -1n, 3_200_000n, 879_100n, 24_000_000_000_000n, 7_200_000_000_000_000_000n]) {
      const parsed = umSchema.parse(asJson(encodeExact('um', value)));
      expect(toBigInt(parsed)).toBe(value);
      expect(unitOf(parsed)).toBe('um');
    }
  });

  it('rejects a quantity whose unit is not the one this field counts', () => {
    // The whole point. 320 cm and 320 µm are both plausible window dimensions.
    expect(umSchema.safeParse({ unit: 'cm', digits: '320' }).success).toBe(false);
    expect(umSchema.safeParse({ unit: 'um2', digits: '320' }).success).toBe(false);
    expect(umSchema.safeParse({ unit: 'THB.satang', digits: '320' }).success).toBe(false);
  });

  it('rejects digits that are not digits', () => {
    for (const digits of ['', ' 1 ', '1.0', '+1', '1e3', '0x10', 'NaN', '一']) {
      expect(umSchema.safeParse({ unit: 'um', digits }).success).toBe(false);
    }
  });

  it('rejects a number where digits belong', () => {
    // `readMinor` in quote.ts refuses this too (quote.ts:236): a JSON number has
    // already lost precision by the time it is read, so accepting one would make the
    // exactness a coincidence of magnitude.
    expect(umSchema.safeParse({ unit: 'um', digits: 3_200_000 }).success).toBe(false);
  });

  it('insists on one spelling per value', () => {
    // `007` and `-0` both parse as integers a person would call correct, and both
    // give a payload two forms — which is one document with two hashes.
    expect(umSchema.safeParse({ unit: 'um', digits: '007' }).success).toBe(false);
    expect(umSchema.safeParse({ unit: 'um', digits: '-0' }).success).toBe(false);
    expect(umSchema.safeParse({ unit: 'um', digits: '0' }).success).toBe(true);
  });

  it('bounds the work an untrusted body can ask BigInt to do', () => {
    expect(umSchema.safeParse({ unit: 'um', digits: '1'.repeat(40) }).success).toBe(true);
    expect(umSchema.safeParse({ unit: 'um', digits: '1'.repeat(41) }).success).toBe(false);
    expect(umSchema.safeParse({ unit: 'um', digits: '9'.repeat(100_000) }).success).toBe(false);
  });

  it('accepts only the units a field declares, when a field declares several', () => {
    const constSchema = exactSchema(['um', 'um2', 'count']);
    expect(unitOf(constSchema.parse({ unit: 'um2', digits: '1000000000000' }))).toBe('um2');
    expect(constSchema.safeParse({ unit: 'bp', digits: '800' }).success).toBe(false);
  });
});
