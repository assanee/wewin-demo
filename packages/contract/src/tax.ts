import { z } from 'zod';

/** Inclusive or exclusive — a property of the destination's settings, never of a quote. */
export const DESTINATION_TAX_BASES = ['inclusive', 'exclusive'] as const;
export type DestinationTaxBasis = (typeof DESTINATION_TAX_BASES)[number];

/** Mirrors the CHECK on `tax_countries.treatment`. Four values, declared here for the wire. */
export const TAX_TREATMENTS_WIRE = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;

const code = z.string().regex(/^[A-Z]{2}$/u, 'code must be an upper-case ISO 3166-1 alpha-2 pair');
const rateBp = z.int().min(0).max(10_000);

export const taxCountryWireSchema = z.strictObject({
  code,
  nameTh: z.string().min(1),
  rateBp,
  treatment: z.enum(TAX_TREATMENTS_WIRE),
  pricesIncludeTax: z.boolean(),
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
