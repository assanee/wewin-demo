-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE COMPANY, AND THE ACCOUNTS IT IS PAID INTO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Until this migration there was nowhere to record which account a transfer went to, which
-- is why apps/web has no payment screen: a page that cannot say where to send money is not
-- a page. `payment_slips` recorded who paid and never who was paid.

CREATE TABLE "bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bank_code" text NOT NULL,
  "account_number" text NOT NULL,
  "account_name" text NOT NULL,
  "promptpay_id" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bank_accounts_number_key" UNIQUE("bank_code","account_number"),
  CONSTRAINT "bank_accounts_bank_code_shape" CHECK ("bank_code" ~ '^[A-Z]{3,8}$'),
  CONSTRAINT "bank_accounts_number_shape" CHECK ("account_number" ~ '^[0-9]{10,15}$'),
  CONSTRAINT "bank_accounts_name_says_something" CHECK (length(btrim("account_name")) > 0),
  CONSTRAINT "bank_accounts_promptpay_shape" CHECK ("promptpay_id" IS NULL OR "promptpay_id" ~ '^([0-9]{10}|[0-9]{13})$')
);
--> statement-breakpoint

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "bank_accounts_active_idx" ON "bank_accounts" ("is_active","sort_order");
--> statement-breakpoint

-- An account is retired, not removed. `payment_slips.received_bank_account_id` points at it,
-- and a slip from last year has to keep saying where the money went.
CREATE FUNCTION bank_accounts_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank account % is referenced by payment records; deactivate it instead of deleting it', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_accounts_block_delete
  BEFORE DELETE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION bank_accounts_block_delete();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE HISTORY, WHICH IS THE POINT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Changing the receiving account number is the classic shape of this fraud: change it, wait
-- for one transfer, change it back. `updated_by_user_id` on the account answers "who last
-- touched this", which is precisely the question that attack is designed to survive.

CREATE TABLE "bank_account_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "changed_by_user_id" uuid,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "bank_account_changes" ADD CONSTRAINT "bank_account_changes_bank_account_id_bank_accounts_id_fk"
  FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "bank_account_changes" ADD CONSTRAINT "bank_account_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "bank_account_changes_account_idx" ON "bank_account_changes" ("bank_account_id","changed_at");
--> statement-breakpoint

-- No UPDATE, no DELETE, ever — the same rule `admin_events` and `order_events` follow. A
-- record that can be edited is not a record; it is a table somebody will eventually tidy,
-- usually the person with the most reason to.
CREATE FUNCTION bank_account_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bank_account_changes is append-only; a change to a receiving account cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_account_changes_append_only
  BEFORE UPDATE OR DELETE ON bank_account_changes
  FOR EACH ROW EXECUTE FUNCTION bank_account_changes_append_only();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE COMPANY, AS A DOCUMENT PRINTS IT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Read at render time, never pinned into a document: `order.repository.ts` safeParses stored
-- documents against a z.literal schema version with no union reader, so adding seller fields
-- to the pinned shape would stop every already-issued quotation from printing. It is also
-- what a company that moves office wants — a price is an offer and is frozen, a letterhead
-- is not.

CREATE TABLE "organisation_profile" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "legal_name_th" text NOT NULL,
  "legal_name_en" text,
  "address_th" text NOT NULL,
  "address_en" text,
  "tax_id" char(13),
  "phone" text NOT NULL,
  "email" text,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organisation_profile_one_row" CHECK ("id" = 1),
  CONSTRAINT "organisation_profile_tax_id_shape" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$'),
  CONSTRAINT "organisation_profile_legal_name_says_something" CHECK (length(btrim("legal_name_th")) > 0),
  CONSTRAINT "organisation_profile_address_says_something" CHECK (length(btrim("address_th")) > 0)
);
--> statement-breakpoint

ALTER TABLE "organisation_profile" ADD CONSTRAINT "organisation_profile_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- The row is the company. Deleting it would leave every document anonymous.
CREATE FUNCTION organisation_profile_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'organisation_profile holds the company identity every document prints; it cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organisation_profile_block_delete
  BEFORE DELETE ON organisation_profile
  FOR EACH ROW EXECUTE FUNCTION organisation_profile_block_delete();
--> statement-breakpoint

-- The one row, seeded from what apps/web/src/data/company.ts already hard-codes, so the
-- first render after this migration is not blank. Every value here is editable in the
-- dashboard; none of it is a decision this migration is making.
INSERT INTO "organisation_profile" ("id", "legal_name_th", "address_th", "phone")
VALUES (1, 'บริษัท วีวิน180 จำกัด', '291/4 หมู่ที่ 1 ต.บ้านกร่าง อ.เมืองพิษณุโลก จ.พิษณุโลก 65000', '+6655000000')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

ALTER TABLE "payment_slips" ADD COLUMN "received_bank_account_id" uuid;
--> statement-breakpoint

ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_received_bank_account_id_bank_accounts_id_fk"
  FOREIGN KEY ("received_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
