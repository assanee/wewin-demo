-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE SYNCS THAT DID NOT LAND — BECAUSE A MISSING ROW SAYS NOTHING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `fx_rates` records every fetch that succeeded. Nothing recorded the ones that did not,
-- and that asymmetry is the whole reason this table exists: a table with no new rows for
-- three weeks is indistinguishable from a table nobody asked to fill. "The provider has
-- been refusing us since the 3rd" and "nobody deployed the cron" produce byte-identical
-- databases, and staff find out about neither.
--
-- `FxRatesService` logged a warning and returned. A warning is a line in a stream nobody
-- reads on a Tuesday; this is a row, and `count(*) since the newest fx_rates.fetched_at`
-- is the consecutive-failure figure the organisation screen prints.
--
-- Append-only for the reason `fx_rates` is: a failure is what happened at a moment. A
-- retry that succeeded does not un-happen the four that did not, and a table that let the
-- record be tidied would let a three-week outage be summarised as fine.
--
-- ⚠️ Deliberately NOT a success log. A success already writes an `fx_rates` row with its
-- own `fetched_at`, so recording one here too would be a second copy of the same fact with
-- its own way of being wrong. The consecutive count is derived by comparing the two
-- tables, which means it cannot disagree with the rates themselves.

CREATE TABLE "fx_sync_failures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stage" text NOT NULL,
  "detail" text NOT NULL,
  CONSTRAINT "fx_sync_failures_stage_known" CHECK ("stage" IN ('fetch', 'parse', 'store'))
);
--> statement-breakpoint

-- The only order this table is read in: newest first, and always bounded against the
-- newest `fx_rates.fetched_at`.
CREATE INDEX "fx_sync_failures_attempted_at_idx" ON "fx_sync_failures" USING btree ("attempted_at" DESC NULLS LAST);
--> statement-breakpoint

-- Append-only: a sync that failed at 01:00 failed at 01:00. Editing the row afterwards
-- would let a run of failures quietly become a shorter one, which is the exact fact this
-- table was added to stop being invisible.
CREATE FUNCTION fx_sync_failures_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fx_sync_failures is append-only; a failed sync cannot be edited or un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fx_sync_failures_append_only
  BEFORE UPDATE OR DELETE ON fx_sync_failures
  FOR EACH ROW EXECUTE FUNCTION fx_sync_failures_append_only();
