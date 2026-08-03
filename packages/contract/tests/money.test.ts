import { describe, expect, it } from 'vitest';
import { CURRENCIES, MINOR_EXPONENT, money } from '@wewin/core/money';
import { PRICE_SCALE } from '@wewin/core/pricing';
import {
  MINOR_UNIT_NAME,
  currencyOf,
  decodeMoney,
  encodeMinor,
  encodeMinorPerSqm,
  encodeMoney,
  encodeScaledMinor,
  minorPerSqmTag,
  minorTag,
  moneyRateWireSchema,
  moneyWireSchema,
  scaledMinorTag,
  scaledMoneyWireSchema,
} from '../src/money.js';
import { toBigInt, unitOf } from '../src/exact.js';

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('money on the wire', () => {
  it('names a minor unit for every currency core knows, and no others', () => {
    expect(Object.keys(MINOR_UNIT_NAME).sort()).toEqual([...CURRENCIES].sort());
  });

  it('names the major unit for the currencies that have no minor one', () => {
    // Plan 4.3(c): `minorExponent` is the fact that a 100x error hides behind. The tag
    // puts it in the payload — "dong" and "kip" are what one digit buys, "satang" is
    // a hundredth of what one baht buys.
    for (const currency of CURRENCIES) {
      const isMajor = MINOR_EXPONENT[currency] === 0;
      expect([currency, isMajor]).toEqual([
        currency,
        ['dong', 'kip'].includes(MINOR_UNIT_NAME[currency]),
      ]);
    }
  });

  it('round-trips an amount in every currency', () => {
    for (const currency of CURRENCIES) {
      const wire = encodeMoney(money(879_100n, currency));
      const parsed = moneyWireSchema().parse(asJson(wire));
      expect(decodeMoney(parsed)).toEqual({ minor: 879_100n, currency });
    }
  });

  it('reads ₫1,000 as a thousand dong, not as ten of anything', () => {
    const wire = encodeMinor(1_000n, 'VND');
    expect(asJson(wire)).toEqual({ unit: 'VND.dong', digits: '1000' });
    expect(decodeMoney(moneyWireSchema().parse(asJson(wire)))).toEqual({
      minor: 1_000n,
      currency: 'VND',
    });
  });

  it('refuses a currency the field was pinned to reject', () => {
    // An endpoint that only ever answers in baht must not accept a cent figure it
    // would then add to one.
    const thbOnly = moneyWireSchema('THB');
    expect(thbOnly.safeParse(asJson(encodeMinor(1n, 'THB'))).success).toBe(true);
    expect(thbOnly.safeParse(asJson(encodeMinor(1n, 'USD'))).success).toBe(false);
  });

  it('keeps an amount, a rate and a scaled figure apart, in every currency', () => {
    const schemas = [moneyWireSchema(), moneyRateWireSchema(), scaledMoneyWireSchema()];

    for (const currency of CURRENCIES) {
      // Same digits, three different quantities. Without the tag they are one string.
      const encoded = [
        asJson(encodeMinor(120_000n, currency)),
        asJson(encodeMinorPerSqm(120_000n, currency)),
        asJson(encodeScaledMinor(120_000n, currency)),
      ];

      for (const [schemaIndex, schema] of schemas.entries()) {
        for (const [valueIndex, value] of encoded.entries()) {
          expect([currency, schemaIndex, valueIndex, schema.safeParse(value).success]).toEqual([
            currency,
            schemaIndex,
            valueIndex,
            schemaIndex === valueIndex,
          ]);
        }
      }
    }
  });

  it('spells the scaled tag with core’s own working precision', () => {
    // pricing.ts ties PRICE_SCALE to SQ_UM_PER_SQM, and the label has to move with it:
    // a `/1e12` suffix on a figure that is really scaled by 10^6 is off by a million.
    const exponent = PRICE_SCALE.toString().length - 1;
    expect(PRICE_SCALE).toBe(10n ** BigInt(exponent));
    expect(scaledMinorTag('THB')).toBe(`THB.satang/1e${String(exponent)}`);
  });

  it('recovers the currency from every tag shape', () => {
    expect(minorTag('THB')).toBe('THB.satang');
    expect(minorPerSqmTag('THB')).toBe('THB.satang/m2');
    expect(currencyOf(encodeMinor(1n, 'MYR'))).toBe('MYR');
    expect(currencyOf(encodeMinorPerSqm(1n, 'MYR'))).toBe('MYR');
    expect(currencyOf(encodeScaledMinor(1n, 'MYR'))).toBe('MYR');
  });

  it('keeps a figure exact past the range a JSON number could hold', () => {
    // 2^53 satang is ฿90 trillion; the point is not the amount, it is that nothing on
    // this path ever became a float.
    const huge = 9_007_199_254_740_993n;
    const parsed = moneyWireSchema().parse(asJson(encodeMinor(huge, 'THB')));
    expect(toBigInt(parsed)).toBe(huge);
    expect(unitOf(parsed)).toBe('THB.satang');
  });
});
