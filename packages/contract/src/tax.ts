import { z } from 'zod';

/** Inclusive or exclusive — a property of the destination's settings, never of a quote. */
export const DESTINATION_TAX_BASES = ['inclusive', 'exclusive'] as const;
export type DestinationTaxBasis = (typeof DESTINATION_TAX_BASES)[number];

/** Mirrors the CHECK on `tax_countries.treatment`. Four values, declared here for the wire. */
export const TAX_TREATMENTS_WIRE = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;

/**
 * The currencies a destination may be quoted in — `CURRENCIES` from `@wewin/core/money`,
 * less THB.
 *
 * Restated here rather than imported for the reason `./money.ts` states about its own copy:
 * this package's *runtime* dependency on core is kept to one small module, and a zod enum
 * needs a literal tuple to infer anything but `string`. `TAX_TREATMENTS_WIRE` directly above
 * is the same mirror of the same kind, and `tests/tax.test.ts` fails on drift in both — the
 * one for this list imports the real `CURRENCIES` and checks that adding THB back reproduces
 * it exactly, so a currency added to core and not here is a red test, not a silent gap.
 *
 * THB is absent because baht to baht is not a conversion; with a spread attached it would be
 * a silent mark-up of the domestic price. `tax_countries_fx_currency_not_thb` refuses to
 * store it and `resolveFxRate` refuses to compute it.
 */
export const FX_CURRENCIES_WIRE = ['CNY', 'EUR', 'INR', 'LAK', 'MYR', 'SGD', 'USD', 'VND'] as const;

const code = z.string().regex(/^[A-Z]{2}$/u, 'code must be an upper-case ISO 3166-1 alpha-2 pair');
const rateBp = z.int().min(0).max(10_000);

/** Mirrors `tax_countries_fx_spread_in_range`. 200 is 2%; the ceiling's argument is in 0036. */
const fxSpreadBp = z.int().min(0).max(2_000);

const fxCurrency = z.enum(FX_CURRENCIES_WIRE);

/**
 * The manual override rate: **baht per one whole unit** of `fxCurrency`, as digits.
 *
 * A string and not a number, for the reason `@wewin/core/money`'s `readSatang` gives about
 * amounts and `readRatio` repeats about rates: a decimal that survives a float round-trip is
 * luck. `numeric(20, 10)` is what stores it and what drizzle reads back — padded, so
 * `'35.90'` returns as `'35.9000000000'`, which is why the fraction allows ten places.
 *
 * The shape is checked here and positivity is checked here too, because
 * `tax_countries_fx_manual_rate_positive` would otherwise answer a plain `'0'` with a 422
 * carrying a constraint name instead of a sentence.
 */
const fxManualRate = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,10})?$/u, 'fxManualRate must be a decimal, e.g. 35.90')
  .refine((value) => /[1-9]/u.test(value), { message: 'fxManualRate must be greater than zero' });

/*
 * The three `fx*` fields are `.nullable()` and not `.optional()` on the way *out*: every row
 * has an answer for all three, and `null` is that answer for a destination quoted in baht.
 * An absent key would make "not set" and "not sent by this version of the server"
 * indistinguishable to a client, which is a distinction a settings screen needs.
 */
export const taxCountryWireSchema = z.strictObject({
  code,
  nameTh: z.string().min(1),
  rateBp,
  treatment: z.enum(TAX_TREATMENTS_WIRE),
  pricesIncludeTax: z.boolean(),
  fxCurrency: fxCurrency.nullable(),
  fxSpreadBp,
  fxManualRate: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.int(),
  updatedAt: z.string(),
});
export type TaxCountryWire = z.infer<typeof taxCountryWireSchema>;

export const taxCountryCreateSchema = z.strictObject({
  code,
  nameTh: z.string().min(1).max(120),
  rateBp,
  treatment: z.enum(TAX_TREATMENTS_WIRE),
  pricesIncludeTax: z.boolean(),
  /* Absent means the column's own default: no currency, no spread, no override — baht only. */
  fxCurrency: fxCurrency.optional(),
  fxSpreadBp: fxSpreadBp.optional(),
  fxManualRate: fxManualRate.optional(),
  sortOrder: z.int().min(0).max(9_999).optional(),
});
export type TaxCountryCreateRequest = z.infer<typeof taxCountryCreateSchema>;

/* Every field optional, but not all-absent: a PATCH that changes nothing would write a
   history row recording no change, which is worse than a 400. */
export const taxCountryPatchSchema = z
  .strictObject({
    nameTh: z.string().min(1).max(120).optional(),
    rateBp: rateBp.optional(),
    treatment: z.enum(TAX_TREATMENTS_WIRE).optional(),
    pricesIncludeTax: z.boolean().optional(),
    /*
     * Nullable *and* optional, unlike every field above, and the two mean different things:
     * absent leaves the setting alone, `null` clears it. Clearing has to be expressible —
     * withdrawing a manual override is how a destination goes back to the mid-market rate,
     * and it is the single most likely edit anyone will make to these three.
     */
    fxCurrency: fxCurrency.nullable().optional(),
    fxSpreadBp: fxSpreadBp.optional(),
    fxManualRate: fxManualRate.nullable().optional(),
    sortOrder: z.int().min(0).max(9_999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'a patch must change something' });
export type TaxCountryPatchRequest = z.infer<typeof taxCountryPatchSchema>;

export const taxCountryAvailabilitySchema = z.strictObject({ isActive: z.boolean() });
export type TaxCountryAvailabilityRequest = z.infer<typeof taxCountryAvailabilitySchema>;

/**
 * One shape for both change logs, tax-country and profile.
 *
 * `changedByUserId`, not a name: nothing in this feature joins `users`, and P1's
 * `bank_account_changes` reader puts the id on the wire for the same reason. A name would be a
 * second query and a second thing to keep true after erasure scrubs the actor to NULL.
 */
export const settingChangeWireSchema = z.strictObject({
  id: z.string(),
  changedAt: z.string(),
  changedByUserId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown(),
});
export type SettingChangeWire = z.infer<typeof settingChangeWireSchema>;

/**
 * What an anonymous storefront caller may know: the places we sell to, by name.
 *
 * No rate, no treatment, no basis. Tax policy belongs on the quotation the customer has
 * actually received, which is the same line P1 drew when it kept account numbers behind an
 * order rather than publishing a list.
 */
export const destinationWireSchema = z.strictObject({ code, nameTh: z.string().min(1) });
export type DestinationWire = z.infer<typeof destinationWireSchema>;
