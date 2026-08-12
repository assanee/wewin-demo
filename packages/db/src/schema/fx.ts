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

/**
 * Every sync that did **not** land — the half of the record `fx_rates` cannot hold.
 *
 * `fx_rates` grows a row per success, so a run of failures is an absence, and an absence is
 * ambiguous: a table with no new rows since the 3rd looks identical whether the provider has
 * been refusing us for three weeks or nobody ever deployed the cron. Both end with a quotation
 * priced at a three-week-old rate and frozen there by `order_documents_freeze`, and until this
 * table existed the only trace of either was a `logger.warn` in a stream nobody reads.
 *
 * **Failures only, never successes.** A success already writes an `fx_rates` row carrying its
 * own `fetched_at`; recording it here as well would be a second copy of one fact with its own
 * way of being wrong. The consecutive-failure figure is therefore *derived* — the rows in here
 * newer than the newest `fx_rates.fetched_at` — which is a count that cannot disagree with the
 * rates it is describing, because it is measured against them.
 *
 * **Append-only** (`fx_sync_failures_append_only`, see the migration), on `fx_rates`' own
 * reasoning: a sync that failed at 01:00 failed at 01:00, and a later retry that succeeded does
 * not un-happen the four before it. A record that could be tidied is a record that could
 * summarise a three-week outage as fine.
 */
export const fxSyncFailures = pgTable(
  'fx_sync_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** When we tried. There is no provider clock on a failure — nothing was observed. */
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * How far the attempt got: `fetch` (never reached the provider, or it refused), `parse`
     * (a body arrived and was not `latest.json`), `store` (the rates were good and the
     * database would not take them). Three words because the three have different owners —
     * a network, a provider contract, and us.
     */
    stage: text('stage').notNull(),
    /**
     * A short, safe-to-log reason: a status code, a schema complaint, a SQLSTATE. ⚠️ Never a
     * URL and never a response body — `FxHttp` is built so this class never holds one, and
     * `app_id` travels in the URL. See `FxRatesService`'s header.
     */
    detail: text('detail').notNull(),
  },
  (t) => [
    check('fx_sync_failures_stage_known', sql`${t.stage} IN ('fetch', 'parse', 'store')`),
    /* Newest first, always bounded against the newest `fx_rates.fetched_at`. */
    index('fx_sync_failures_attempted_at_idx').on(t.attemptedAt.desc()),
  ],
);
