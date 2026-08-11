import { char, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Every exchange-rate observation this system has fetched from a provider — ingestion
 * only. Nothing reads this table yet and nothing in this package converts money with it;
 * see `apps/api/src/fx/fx-rates.service.ts` for what fills it and why that stops here.
 *
 * **Append-only, on the same reasoning `tax_country_changes` (0029_tax_countries.sql) is
 * built on.** A rate is what the provider said at a moment, not a current value to
 * overwrite: if a quotation ever pins one, this table has to be able to prove where it
 * came from and when, which needs every past fetch kept rather than the latest one alone.
 * `fx_rates_append_only` (see the migration) is the trigger that makes that true rather
 * than merely conventional.
 *
 * **`rates` holds the whole response object, verbatim — not a computed pair.** The free
 * Open Exchange Rates plan is USD-base only, so a rate like THB→SGD only ever exists as a
 * derivation through USD. Storing that derived figure instead of the inputs would produce
 * a number nobody downstream could re-check; storing the object this table actually
 * received is what makes it auditable.
 *
 * **`rates` is `jsonb`, not `numeric` columns per currency, and neither is `bigint`.**
 * `bigint` minor units are how this system stores *money* elsewhere (an amount that will
 * be added, allocated, and settled); a rate is a decimal ratio between two currencies, not
 * an amount, and forcing THB 36.5000 per USD into satang-style integer minor units would
 * invent a currency for a number that is not one. `jsonb` is what lets the whole
 * provider response — every currency pair, at whatever precision it arrived in — be
 * stored as received, keyed the same way the provider keys it.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** When we asked. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the provider says it last updated `rates` — UNIX UTC seconds on the wire,
     * converted here. Not the same instant as `fetchedAt`: the free plan updates hourly,
     * so most fetches land strictly after the rate they receive was struck.
     */
    rateTimestamp: timestamp('rate_timestamp', { withTimezone: true }).notNull(),
    base: char('base', { length: 3 }).notNull(),
    rates: jsonb('rates').$type<Record<string, number>>().notNull(),
    source: text('source').notNull(),
  },
  (t) => [
    check('fx_rates_base_shape', sql`${t.base} ~ '^[A-Z]{3}$'`),
    /* The only order this table is ever read in once something reads it: newest first. */
    index('fx_rates_fetched_at_idx').on(t.fetchedAt.desc()),
  ],
);
