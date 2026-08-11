import { describe, expect, it } from 'vitest';
import { CURRENCIES } from '@wewin/core/money';
import {
  DESTINATION_TAX_BASES,
  FX_CURRENCIES_WIRE,
  TAX_TREATMENTS_WIRE,
  destinationWireSchema,
  settingChangeWireSchema,
  taxCountryAvailabilitySchema,
  taxCountryCreateSchema,
  taxCountryPatchSchema,
  taxCountryWireSchema,
} from '../src/tax.js';

/**
 * Everything here goes through `JSON.parse(JSON.stringify(...))` rather than handing the
 * object straight to the schema, as `catalog.test.ts` does — an object that only survives
 * in-process proves nothing about a payload that crossed a socket.
 */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const fullCountry = () => ({
  code: 'SG',
  nameTh: 'สิงคโปร์',
  rateBp: 700,
  treatment: 'standard' as const,
  pricesIncludeTax: false,
  fxCurrency: 'SGD' as const,
  fxSpreadBp: 200,
  fxManualRate: null,
  isActive: true,
  sortOrder: 1,
  updatedAt: '2026-08-10T00:00:00.000Z',
});

describe('the closed sets', () => {
  it('names the two destination tax bases, and only those two', () => {
    expect(DESTINATION_TAX_BASES).toStrictEqual(['inclusive', 'exclusive']);
  });

  it('mirrors the four treatments the tax_countries CHECK allows', () => {
    expect(TAX_TREATMENTS_WIRE).toStrictEqual(['standard', 'zero_rated', 'exempt', 'out_of_scope']);
  });

  /**
   * ⭐ The drift test that makes the mirror safe. `FX_CURRENCIES_WIRE` is retyped in
   * `src/tax.ts` rather than imported, for the runtime-dependency reason stated there — so
   * this reads the real `CURRENCIES` and proves the two lists are the same set apart from the
   * one deliberate omission. A currency added to core and not to the wire fails here, rather
   * than becoming a destination the dashboard silently cannot offer.
   */
  it('offers every currency core knows except baht, which is not a conversion', () => {
    expect([...FX_CURRENCIES_WIRE, 'THB'].sort()).toStrictEqual([...CURRENCIES].sort());
    expect(FX_CURRENCIES_WIRE).not.toContain('THB');
  });
});

describe('taxCountryWireSchema — the read shape', () => {
  it('accepts a fully-formed country', () => {
    expect(taxCountryWireSchema.safeParse(wire(fullCountry())).success).toBe(true);
  });

  it('refuses a lower-case or otherwise malformed code', () => {
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), code: 'sg' }).success).toBe(false);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), code: 'SGP' }).success).toBe(false);
  });

  it('refuses a rate outside 0..10000 basis points', () => {
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), rateBp: -1 }).success).toBe(false);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), rateBp: 10_001 }).success).toBe(false);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), rateBp: 10_000 }).success).toBe(true);
  });

  it('refuses a treatment outside the closed set', () => {
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), treatment: 'reduced' }).success).toBe(false);
  });

  it('refuses an unknown field, strictly', () => {
    expect(
      taxCountryWireSchema.safeParse({ ...fullCountry(), rateDecimalPercent: 7 }).success,
    ).toBe(false);
  });

  it('carries all three FX settings as null for a destination quoted in baht', () => {
    const baht = { ...fullCountry(), fxCurrency: null, fxSpreadBp: 0, fxManualRate: null };
    expect(taxCountryWireSchema.safeParse(wire(baht)).success).toBe(true);
  });

  it('refuses an absent FX field — null and missing are different answers on the way out', () => {
    for (const key of ['fxCurrency', 'fxSpreadBp', 'fxManualRate'] as const) {
      const { [key]: _dropped, ...rest } = fullCountry();
      expect(taxCountryWireSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it('refuses THB as a destination currency — baht to baht is not a conversion', () => {
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), fxCurrency: 'THB' }).success).toBe(false);
  });

  it('refuses a spread outside the 0..2000 bp the CHECK allows', () => {
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), fxSpreadBp: -1 }).success).toBe(false);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), fxSpreadBp: 2_001 }).success).toBe(false);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), fxSpreadBp: 2_000 }).success).toBe(true);
  });

  /* A rate is digits on the wire, never a JSON number — see the note on `fxManualRate`. */
  it('reads the override back as the padded decimal string numeric(20,10) stores', () => {
    expect(
      taxCountryWireSchema.safeParse({ ...fullCountry(), fxManualRate: '27.0500000000' }).success,
    ).toBe(true);
    expect(taxCountryWireSchema.safeParse({ ...fullCountry(), fxManualRate: 27.05 }).success).toBe(
      false,
    );
  });
});

describe('taxCountryCreateSchema — the write shape', () => {
  const create = () => ({
    code: 'MY',
    nameTh: 'มาเลเซีย',
    rateBp: 0,
    treatment: 'zero_rated' as const,
    pricesIncludeTax: true,
  });

  it('accepts a country with no sortOrder — the server may default it', () => {
    expect(taxCountryCreateSchema.safeParse(wire(create())).success).toBe(true);
  });

  it('accepts an explicit sortOrder within bounds and refuses one outside', () => {
    expect(taxCountryCreateSchema.safeParse({ ...create(), sortOrder: 9_999 }).success).toBe(true);
    expect(taxCountryCreateSchema.safeParse({ ...create(), sortOrder: 10_000 }).success).toBe(false);
  });

  it('has no isActive field — a created country cannot be created inactive', () => {
    expect(taxCountryCreateSchema.safeParse({ ...create(), isActive: false }).success).toBe(false);
  });

  it('accepts a country created with FX settings, and one created with none', () => {
    expect(taxCountryCreateSchema.safeParse(wire(create())).success).toBe(true);
    expect(
      taxCountryCreateSchema.safeParse({
        ...create(),
        fxCurrency: 'MYR',
        fxSpreadBp: 250,
        fxManualRate: '7.85',
      }).success,
    ).toBe(true);
  });

  it('refuses a null FX setting on create — absent is how "not set" is spelled here', () => {
    expect(taxCountryCreateSchema.safeParse({ ...create(), fxCurrency: null }).success).toBe(false);
  });

  it('refuses an override that is not a positive decimal', () => {
    for (const bad of ['0', '0.0000000000', '-1', '', 'abc', '1,000', '.5', '12345678901']) {
      expect(
        taxCountryCreateSchema.safeParse({ ...create(), fxCurrency: 'USD', fxManualRate: bad })
          .success,
        `fxManualRate ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });
});

describe('taxCountryPatchSchema — a patch must change something', () => {
  it('refuses an empty patch', () => {
    expect(taxCountryPatchSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single-field patch', () => {
    expect(taxCountryPatchSchema.safeParse({ rateBp: 800 }).success).toBe(true);
    expect(taxCountryPatchSchema.safeParse({ nameTh: 'ใหม่' }).success).toBe(true);
  });

  it('refuses a field that is not one of the patchable ones', () => {
    expect(taxCountryPatchSchema.safeParse({ code: 'TH' }).success).toBe(false);
  });

  /**
   * ⭐ Clearing has to be expressible. Withdrawing a manual override is how a destination goes
   * back to the mid-market rate, and it is the likeliest edit anyone will make here — a schema
   * that only accepted a *new* rate would leave the old one in place for ever.
   */
  it('accepts null for the two clearable FX settings, and distinguishes it from absent', () => {
    expect(taxCountryPatchSchema.safeParse({ fxManualRate: null }).success).toBe(true);
    expect(taxCountryPatchSchema.safeParse({ fxCurrency: null }).success).toBe(true);
    expect(taxCountryPatchSchema.safeParse({ fxSpreadBp: 0 }).success).toBe(true);
    // A spread has no "unset": zero is the setting that means mid-market.
    expect(taxCountryPatchSchema.safeParse({ fxSpreadBp: null }).success).toBe(false);
  });

  it('applies the same bounds to a patch as to a create', () => {
    expect(taxCountryPatchSchema.safeParse({ fxSpreadBp: 2_001 }).success).toBe(false);
    expect(taxCountryPatchSchema.safeParse({ fxCurrency: 'THB' }).success).toBe(false);
    expect(taxCountryPatchSchema.safeParse({ fxManualRate: '0' }).success).toBe(false);
  });
});

describe('taxCountryAvailabilitySchema', () => {
  it('is exactly one boolean', () => {
    expect(taxCountryAvailabilitySchema.safeParse({ isActive: false }).success).toBe(true);
    expect(taxCountryAvailabilitySchema.safeParse({}).success).toBe(false);
    expect(taxCountryAvailabilitySchema.safeParse({ isActive: false, rateBp: 0 }).success).toBe(false);
  });
});

describe('settingChangeWireSchema — one shape for two change logs', () => {
  const entry = () => ({
    id: 'a1b2c3',
    changedAt: '2026-08-10T00:00:00.000Z',
    changedByUserId: 'user-1',
    before: null,
    after: { rateBp: 700 },
  });

  it('accepts a real change, before and after', () => {
    expect(settingChangeWireSchema.safeParse(wire(entry())).success).toBe(true);
  });

  it('accepts the first-ever change, where there is no before', () => {
    expect(settingChangeWireSchema.safeParse({ ...entry(), before: null }).success).toBe(true);
  });

  it('carries an id, not a name, for the actor — erasure scrubs it to null and this must survive that', () => {
    expect(settingChangeWireSchema.safeParse({ ...entry(), changedByUserId: null }).success).toBe(true);
  });
});

describe('destinationWireSchema — the public read, deliberately thin', () => {
  it('accepts code and nameTh alone', () => {
    expect(destinationWireSchema.safeParse({ code: 'SG', nameTh: 'สิงคโปร์' }).success).toBe(true);
  });

  it('refuses a rate or a treatment riding along — an anonymous caller gets no tax policy', () => {
    expect(
      destinationWireSchema.safeParse({ code: 'SG', nameTh: 'สิงคโปร์', rateBp: 700 }).success,
    ).toBe(false);
    expect(
      destinationWireSchema.safeParse({ code: 'SG', nameTh: 'สิงคโปร์', treatment: 'standard' }).success,
    ).toBe(false);
  });
});
