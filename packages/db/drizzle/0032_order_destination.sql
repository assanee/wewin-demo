-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHERE THIS ORDER IS GOING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Nullable and mutable, both deliberately. Nullable because all 25 existing orders — the 21
-- carrying an issued document and the 4 drafts — predate the question, and migration 0017
-- established the house answer to inventing a value for a new NOT NULL column: it deleted the
-- rows rather than guess. Mutable because a customer who picks the wrong country should be
-- correctable; the tax that country produced stays pinned on the issued quotation.
--
-- No foreign key to tax_countries. Resolution (`resolveDestination`) does the checking, so it
-- can tell *withdrawn* from *unknown* — a constraint cannot, and would treat both alike.

ALTER TABLE "orders" ADD COLUMN "destination_country" char(2);
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_destination_country_shape"
  CHECK ("destination_country" IS NULL OR "destination_country" ~ '^[A-Z]{2}$');
