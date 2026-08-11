-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHAT THE PROVIDER SAID, AND WHEN — KEPT, NOT OVERWRITTEN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Ingestion only. Nothing converts money with what lands in this table — see
-- apps/api/src/fx/fx-rates.service.ts for what fetches into it and why conversion stops
-- here. A rate is an observation at a moment, not a current value: if a quotation ever
-- pins one, this table has to be able to prove where it came from and when, which is the
-- same reasoning `tax_country_changes` (0029_tax_countries.sql) is built on.
--
-- `rates` holds the whole provider response, verbatim, keyed by currency against `base` —
-- not a single computed pair. The free Open Exchange Rates plan is USD-base only, so a
-- pair like THB→SGD only ever exists as a derivation through USD; storing the inputs
-- rather than a computed figure is what keeps that derivation auditable.

CREATE TABLE "fx_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rate_timestamp" timestamp with time zone NOT NULL,
  "base" char(3) NOT NULL,
  "rates" jsonb NOT NULL,
  "source" text NOT NULL,
  CONSTRAINT "fx_rates_base_shape" CHECK ("base" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint

-- The only order this table is ever read in once something reads it: newest first.
CREATE INDEX "fx_rates_fetched_at_idx" ON "fx_rates" USING btree ("fetched_at" DESC NULLS LAST);
--> statement-breakpoint

-- Append-only: a fetched rate is what the provider said at that moment, and editing or
-- deleting the row afterwards would let a past observation quietly become a different one.
CREATE FUNCTION fx_rates_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fx_rates is append-only; a fetched rate cannot be edited or un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fx_rates_append_only
  BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION fx_rates_append_only();
