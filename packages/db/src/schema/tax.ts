import { boolean, char, check, index, integer, pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth.js';

/**
 * A destination the company actually sells to, and what tax it attracts there.
 *
 * `treatment` is `text` + CHECK rather than a `pgEnum`, following `bank_accounts.bank_code`:
 * the set is data, and an enum makes changing it a migration.
 *
 * `prices_include_tax` is the switch the whole feature turns on. It does NOT belong on
 * `TaxRule` — see the spec's §3 and the amended header of `packages/core/src/vat.ts`. It
 * says what a catalogue number *means* for this destination, and the caller picks
 * `fromNet` or `fromGrand` from it.
 */
export const taxCountries = pgTable(
  'tax_countries',
  {
    code: char('code', { length: 2 }).primaryKey(),
    nameTh: text('name_th').notNull(),
    rateBp: integer('rate_bp').notNull(),
    treatment: text('treatment').notNull(),
    pricesIncludeTax: boolean('prices_include_tax').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tax_countries_code_shape', sql`${t.code} ~ '^[A-Z]{2}$'`),
    /*
     * The ceiling has to be here. `assertRate` (packages/core/src/vat.ts:40-44) rejects
     * non-integers and negatives and has NO upper bound — a rate of 15000 computes without
     * complaint — and this table is read by code that calls core directly.
     */
    check('tax_countries_rate_in_range', sql`${t.rateBp} between 0 and 10000`),
    check(
      'tax_countries_treatment_allowed',
      sql`${t.treatment} in ('standard', 'zero_rated', 'exempt', 'out_of_scope')`,
    ),
    check('tax_countries_name_says_something', sql`length(btrim(${t.nameTh})) > 0`),
    index('tax_countries_active_idx').on(t.isActive, t.sortOrder),
  ],
);

/**
 * Append-only, before and after, every field.
 *
 * A VAT rate is the input to a ภ.พ.30 filing. The attack this guards is the same shape as
 * the one `bank_account_changes` guards: set a country to `zero_rated` for one deal, then set
 * it back. The pinned document proves what rate ran; only this table proves who moved it.
 */
export const taxCountryChanges = pgTable(
  'tax_country_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxCountryCode: char('tax_country_code', { length: 2 })
      .notNull()
      .references(() => taxCountries.code, { onDelete: 'restrict' }),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
  },
  (t) => [index('tax_country_changes_code_idx').on(t.taxCountryCode, t.changedAt)],
);
