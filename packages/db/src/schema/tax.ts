import {
  boolean,
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { CURRENCIES } from '@wewin/core/money';
import { users } from './auth.js';

/** Same helper `profile.ts` uses, for the same reason: one definition, no hand-copied list. */
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((value) => `'${value}'`).join(', ')})`);

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

    /* ── Exchange-rate settings: how a baht figure becomes a figure in this destination's
     * currency. Nothing reads these yet — `packages/core/src/fx.ts` is the arithmetic, and
     * its header carries the full argument for each. Three columns and not two, because a
     * rate with no currency attached is a number with no meaning: see `fxCurrency` below.
     * ───────────────────────────────────────────────────────────────────────────────── */

    /**
     * What this destination is quoted in. `NULL` — the default and what Thailand keeps —
     * means baht only, and no conversion happens at all.
     *
     * The list comes from `CURRENCIES` in `@wewin/core/money` rather than being retyped, the
     * same way `user_preferences.display_currency` does it, so the CHECK cannot drift from the
     * union. THB is refused outright: converting baht to baht is not a conversion, and with a
     * spread attached it would be a silent mark-up of the domestic price.
     */
    fxCurrency: char('fx_currency', { length: 3, enum: CURRENCIES }),

    /**
     * Basis points shaved off the mid-market rate before it is applied, so 2% is 200 —
     * `rate_bp`'s unit, for the same reason it is `rate_bp`'s unit: 2% is 2% in every currency.
     *
     * Open Exchange Rates publishes the mid-market rate, which is the midpoint of a spread
     * nobody transacts at. This is the estimate of the half of that spread the bank takes:
     * `effective = mid × (1 − spread)`. `0` is a real setting and the default, so every
     * existing row and every new one converts at mid-market until somebody decides otherwise.
     */
    fxSpreadBp: integer('fx_spread_bp').notNull().default(0),

    /**
     * A rate taken from a bank, used **instead of** the mid-market rate — baht per one whole
     * unit of `fx_currency`, so `35.90000000` for USD.
     *
     * ⚠️ When this is set, `fx_spread_bp` is **not** applied on top. A quoted bank rate
     * already carries the bank's margin; the spread exists to estimate a margin that is not
     * yet in the number, and applying it to a rate that already has one charges it twice.
     * `resolveFxRate` (`packages/core/src/fx.ts`) is the single place that decides this, and
     * its header carries the argument. The spread is deliberately not cleared when this is
     * set — it stays on the row so that removing the override restores the old behaviour, and
     * so `tax_country_changes` records the two independently.
     *
     * `numeric`, not `double precision` and not an integer of some invented minor unit: a
     * rate is a decimal ratio between two currencies (the header of `fx_rates` in `./fx.ts`
     * makes the same call), and drizzle hands a `numeric` back as an exact decimal *string*,
     * which is what `readRatio` reads as digits rather than as a float. `(20, 10)` holds both
     * ends of the currency list — 39.xxx for EUR and 0.0014321000 for VND.
     */
    fxManualRate: numeric('fx_manual_rate', { precision: 20, scale: 10 }),

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
    /*
     * The pairing a document actually prints. `packages/core/src/quotation.ts:184` renders
     * the rate as `String(document.vatRateBp / 100)` with no awareness of `treatment` at all
     * — spec §8.3 chose that deliberately, on the grounds that "VAT 0%" is correct wording on
     * a Thai export invoice. That reasoning holds only while a non-`standard` treatment
     * always carries `rate_bp = 0`; without this CHECK a `zero_rated` row at 900 bp stores
     * fine, computes ฿0 VAT (`charges()`, packages/core/src/vat.ts:46, requires
     * `treatment === 'standard'`), and prints "VAT 9%" on a frozen document nobody can
     * reconcile. `standard` at 0 bp stays legal on purpose — see the note two constraints up
     * on why `charges()` treats it differently from `exempt`.
     */
    check('tax_countries_rate_matches_treatment', sql`${t.treatment} = 'standard' or ${t.rateBp} = 0`),

    /* ── The three FX guards ────────────────────────────────────────────────────────── */
    /*
     * Membership, built from the imported list rather than a hand-copied one — see the column.
     * `tests/review.test.ts` reads `user_preferences_currency_known` back out of
     * `pg_constraint` to prove that pattern cannot drift; this constraint is built the
     * identical way for the identical reason.
     */
    check(
      'tax_countries_fx_currency_known',
      sql`${t.fxCurrency} is null or ${t.fxCurrency} in ${inList(CURRENCIES)}`,
    ),
    /*
     * Baht to baht is not a conversion. Left legal, a destination set to THB with a 2% spread
     * would mark the domestic price up by 2% with nothing on the document saying so — the
     * quietest possible way for this feature to overcharge. `resolveFxRate` refuses it too,
     * so neither guard depends on the other being present.
     */
    check(
      'tax_countries_fx_currency_not_thb',
      sql`${t.fxCurrency} is null or ${t.fxCurrency} <> 'THB'`,
    ),
    /*
     * The ceiling is here for the same reason `tax_countries_rate_in_range` is: core bounds
     * the spread only where the arithmetic breaks (100%, where the effective rate is zero and
     * the division is undefined). 2,000 bp is five times the worst retail FX spread, so
     * anything above it is a typo — a `20` meant as 20 basis points and read as 20 per cent
     * is exactly the mistake this catches.
     */
    check('tax_countries_fx_spread_in_range', sql`${t.fxSpreadBp} between 0 and 2000`),
    /*
     * A rate is a ratio *of* something. Without a currency the figure is unusable and
     * unreviewable, and the pair is the one shape a half-finished edit leaves behind.
     * `num_nonnulls`-style pairing, the same idea `user_preferences_says_something` uses.
     */
    check(
      'tax_countries_fx_manual_rate_needs_currency',
      sql`${t.fxManualRate} is null or ${t.fxCurrency} is not null`,
    ),
    /*
     * `readRatio` returns null for a zero or negative rate and `resolveFxRate` then refuses
     * the whole conversion, so a stored zero would be a row that silently converts nothing.
     * Refused at rest instead.
     */
    check(
      'tax_countries_fx_manual_rate_positive',
      sql`${t.fxManualRate} is null or ${t.fxManualRate} > 0`,
    ),

    index('tax_countries_active_idx').on(t.isActive, t.sortOrder),
  ],
);

/**
 * Append-only, before and after, every field.
 *
 * A VAT rate is the input to a ภ.พ.30 filing. The attack this guards is the same shape as
 * the one `bank_account_changes` guards: set a country to `zero_rated` for one deal, then set
 * it back. The pinned document proves what rate ran; only this table proves who moved it.
 *
 * ⚠️ The three `fx_*` columns above are on this chain too — `RECORDED` in
 * `apps/api/src/organisation/tax-country.service.ts` names them. The attack is identical in
 * shape and quieter in effect: widen the spread for one deal, then narrow it back. A spread
 * moves the price a customer pays without moving a single figure a VAT return would show, so
 * a change to it that nobody can see is a change nobody can question.
 */
export const taxCountryChanges = pgTable(
  'tax_country_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxCountryCode: char('tax_country_code', { length: 2 })
      .notNull()
      .references(() => taxCountries.code, { onDelete: 'restrict' }),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * ⚠️ `clock_timestamp()`, not `defaultNow()` — migration 0039, and the reason is the whole
     * point of this table. `now()` is `transaction_timestamp()`, fixed at BEGIN, so under
     * concurrency the transaction that blocks on a row lock can hold the *earlier* stamp while
     * committing *second*, and the chain reads in an order that never happened. Every writer
     * passes the value explicitly; this is the net under the one that forgets, and it used to
     * be woven from the exact failure it was meant to catch.
     */
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
  },
  (t) => [index('tax_country_changes_code_idx').on(t.taxCountryCode, t.changedAt)],
);
