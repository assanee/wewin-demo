-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHERE THE GOODS ARE GOING, AND WHAT TAX THAT ATTRACTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Until this migration `DEFAULT_VAT_RULE` was the only rate the system had, and
-- `apps/api/src/orders/defaults.ts` said so: "the question it is standing in for" was
-- whether an overseas customer is zero-rated. This table is where that question gets an
-- answer per destination — and, deliberately, only for destinations somebody entered on
-- purpose. Nothing here seeds a foreign rate.

CREATE TABLE "tax_countries" (
  "code" char(2) PRIMARY KEY NOT NULL,
  "name_th" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "treatment" text NOT NULL,
  "prices_include_tax" boolean NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tax_countries_code_shape" CHECK ("code" ~ '^[A-Z]{2}$'),
  -- packages/core/src/vat.ts assertRate has no upper bound; 15000 bp would compute.
  CONSTRAINT "tax_countries_rate_in_range" CHECK ("rate_bp" BETWEEN 0 AND 10000),
  CONSTRAINT "tax_countries_treatment_allowed"
    CHECK ("treatment" IN ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  CONSTRAINT "tax_countries_name_says_something" CHECK (length(btrim("name_th")) > 0)
);
--> statement-breakpoint

ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "tax_countries_active_idx" ON "tax_countries" ("is_active","sort_order");
--> statement-breakpoint

-- A country is withdrawn, not removed. Orders and documents record its code, and
-- `tax_country_changes` points at it; a row that can vanish takes their meaning with it.
CREATE FUNCTION tax_countries_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax country % is recorded on orders and quotations; deactivate it instead of deleting it', OLD.code
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER tax_countries_block_delete
  BEFORE DELETE ON tax_countries
  FOR EACH ROW EXECUTE FUNCTION tax_countries_block_delete();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHO MOVED THE RATE, AND FROM WHAT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Set a country to zero-rated for one deal and set it back: the pinned documents prove
-- which rate ran, and nothing else would show that the policy was flipped around them.

CREATE TABLE "tax_country_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tax_country_code" char(2) NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "tax_country_changes" ADD CONSTRAINT "tax_country_changes_tax_country_code_tax_countries_code_fk"
  FOREIGN KEY ("tax_country_code") REFERENCES "public"."tax_countries"("code") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "tax_country_changes" ADD CONSTRAINT "tax_country_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "tax_country_changes_code_idx" ON "tax_country_changes" ("tax_country_code","changed_at");
--> statement-breakpoint

CREATE FUNCTION tax_country_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_country_changes is append-only; a change to a tax rate cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER tax_country_changes_append_only
  BEFORE UPDATE OR DELETE ON tax_country_changes
  FOR EACH ROW EXECUTE FUNCTION tax_country_changes_append_only();
--> statement-breakpoint

-- Thailand, and only Thailand. Its numbers come from DEFAULT_VAT_RULE so the two cannot
-- disagree on day one. A foreign rate is a tax registration somebody has to actually hold —
-- seeding one would put an unverified number where it looks verified.
INSERT INTO "tax_countries" ("code", "name_th", "rate_bp", "treatment", "prices_include_tax", "sort_order")
VALUES ('TH', 'ไทย', 700, 'standard', false, 0);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE DEPOSIT, AS ONE COMPANY-WIDE NUMBER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three statements, not one, and deliberately: no DEFAULT. `apps/api/src/orders/defaults.ts`
-- forbids a column default for a placeholder business number in so many words. Adding the
-- column nullable, writing the value, then tightening to NOT NULL leaves 10000 visible as a
-- decision in this file rather than invisible in a catalogue.

ALTER TABLE "organisation_profile" ADD COLUMN "deposit_bp" smallint;
--> statement-breakpoint

UPDATE "organisation_profile" SET "deposit_bp" = 10000 WHERE "deposit_bp" IS NULL;
--> statement-breakpoint

ALTER TABLE "organisation_profile" ALTER COLUMN "deposit_bp" SET NOT NULL;
--> statement-breakpoint

-- 1, not 0: depositPercentTerms already refuses 0 bp.
ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_deposit_in_range"
  CHECK ("deposit_bp" BETWEEN 1 AND 10000);
--> statement-breakpoint

CREATE TABLE "organisation_profile_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "organisation_profile_changes" ADD CONSTRAINT "organisation_profile_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "organisation_profile_changes_at_idx" ON "organisation_profile_changes" ("changed_at");
--> statement-breakpoint

CREATE FUNCTION organisation_profile_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'organisation_profile_changes is append-only; a change to the company record cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organisation_profile_changes_append_only
  BEFORE UPDATE OR DELETE ON organisation_profile_changes
  FOR EACH ROW EXECUTE FUNCTION organisation_profile_changes_append_only();
