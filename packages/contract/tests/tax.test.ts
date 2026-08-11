import { describe, expect, it } from 'vitest';
import {
  DESTINATION_TAX_BASES,
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
