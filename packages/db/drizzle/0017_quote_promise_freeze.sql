-- Two schema defects 5c found by running against real Postgres, plus the column that turns an
-- approval from a standing line of credit into a decision about one document.
--
-- ── ⚠️ THIS MIGRATION DESTROYS DATA, AND SAYS SO ────────────────────────────────
--
-- Both destructive statements below touch only rows that phase 5c itself wrote, in a phase that
-- has never been released. Neither is reachable on a database that predates 5c: `approvals` and
-- `quote_lines` are both created by 0010/0015 and were unwritable in the assembled application
-- until this round, because neither `QuotesModule` nor `AuthorityModule` was in `AppModule`.
-- On the developer databases that DO hold such rows, what is thrown away is stated per statement
-- rather than left to be discovered.

-- ── ① `approvals` is re-keyed from a document to a quote revision ────────────────
--
-- The full reasoning is on `approvals` in src/schema/payment.ts. In one sentence: an approval
-- keyed to an order and carrying an absolute figure is permanent headroom that any later, smaller
-- concession can spend — the red team approved ฿9,630 against a ฿138,240 line, rewrote the quote,
-- and gave away a different ฿7,395.84 line for nothing.
--
-- There is nothing to backfill `quote_revision` from. It is a digest of the live quote at the
-- moment the request was raised, and no such digest was ever recorded, so a value invented here
-- would be an approval attached to a quote it was never measured against — exactly the defect
-- being closed. The rows are deleted; the requests can be raised again, and they will be measured
-- against the quote as it stands.
DELETE FROM approvals;
--> statement-breakpoint

ALTER TABLE "approvals" DROP CONSTRAINT "approvals_document_dimension_key";--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "order_document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "quote_revision" char(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_ceiling_thb_minor" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_open_per_order_dimension" ON "approvals" USING btree ("order_id","dimension") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_quote_revision_is_hex" CHECK ("approvals"."quote_revision" ~ '^[0-9a-f]{16}$');--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_ceiling_shape" CHECK (("approvals"."status" = 'approved') = ("approvals"."decided_ceiling_thb_minor" is not null));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_ceiling_covers_concession" CHECK ("approvals"."decided_ceiling_thb_minor" is null
          or "approvals"."decided_ceiling_thb_minor" >= "approvals"."concession_thb_minor");--> statement-breakpoint

-- ── ② `quote_lines.config_hash` is 16 hex, not 64 ────────────────────────────────
--
-- It shipped as `char(64)` with a `{64}` CHECK — the shape of `order_documents.document_hash`,
-- two tables away, which is where it was copied from. The value it is *named after* is
-- `@wewin/core/hash`'s `configHash`: a 64-**bit** FNV-1a rendered as sixteen hex characters. The
-- column could not hold the value it was named for, and the first write of a real quote line was
-- SQLSTATE 23514. packages/db's own test never met it, because it used a made-up 64-hex literal.
--
-- `USING left(config_hash, 16)` rather than a plain cast, which would raise "value too long".
-- What it costs on a developer database: rows written by 5c's `widenedConfigHash` workaround hold
-- `sha256(configHash(...))`, and the first sixteen characters of that are not `configHash`. The
-- column is a *config identity within one quote* and is read by nothing — no join, no comparison,
-- no unique index (`quote_lines` deliberately has none on it; see the schema note about two
-- identical windows at two different prices). So a truncated value is a value nothing consults,
-- and the next `reviseLine` on that line writes the real one.
ALTER TABLE "quote_lines" DROP CONSTRAINT "quote_lines_config_hash_is_hex";--> statement-breakpoint
ALTER TABLE "quote_lines" ALTER COLUMN "config_hash" SET DATA TYPE char(16) USING left("config_hash", 16);--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_config_hash_is_hex" CHECK ("quote_lines"."config_hash" is null or "quote_lines"."config_hash" ~ '^[0-9a-f]{16}$');
