-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ เอกสารภาษี — ใบแจ้งหนี้ · ใบกำกับภาษี · ใบเสร็จรับเงิน · ใบลดหนี้
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The company is VAT-registered, charges 7%, pins `vat_thb_minor` on every order — and issues
-- no tax document at all. It has issued exactly one kind of document since it was built: the
-- quotation. This migration is the foundation for the rest: the table, the numbering, and the
-- rule that an issued document never changes. Nothing issues anything yet.
--
-- The owner's answers, which are requirements:
--   2.1 ต้องมี, and switchable in settings.
--   2.2 per-instalment AND single-at-delivery, "เปิดอิสระทั้งสองสวิตช์" — both switches free.
--   2.3 the invoice is its own document, available on demand, also a setting.
--   full and abbreviated tax invoices both supported, "แล้วแต่ลูกค้า".
--
-- ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. The ledger still credits `revenue` with the
-- VAT-inclusive total and has no output-VAT account, so tax payable is recorded nowhere. That
-- was raised with the owner and their answer was "ยังก่อน ขอถามผู้ทำบัญชีก่อน". Nothing here
-- depends on it: every document pins its own net/vat/grand and foots on its own.
--
-- ── ⓵ WHY `order_documents` COULD NOT BE REUSED, checked rather than assumed ──
--
--   * `order_documents_order_revision_key` is one row per (order, revision).
--   * `orders.document_id` is a single composite FK — an order points at one document.
--   * `orders_totals_match_document()` forces a document's totals to equal the order's, so an
--     instalment invoice for 30% of the order raises on insert.
--
-- Three separate reasons, any one of them fatal. New table.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "document_series" (
  "series_code"   text PRIMARY KEY,
  "kind"          text NOT NULL,
  "prefix"        text NOT NULL,
  "pad_width"     smallint NOT NULL DEFAULT 5,
  "year_era"      text NOT NULL DEFAULT 'BE',
  "resets_yearly" boolean NOT NULL DEFAULT true,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "document_series_code_shape" CHECK ("document_series"."series_code" ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT "document_series_pad_sane" CHECK ("document_series"."pad_width" between 3 and 10),
  CONSTRAINT "document_series_year_era_known" CHECK ("document_series"."year_era" in ('BE', 'CE')),
  CONSTRAINT "document_series_kind_known" CHECK ("document_series"."kind" in (
    'invoice', 'tax_invoice', 'abbreviated_tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note'
  ))
);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ THE COUNTER, AND WHY IT IS NOT A POSTGRES SEQUENCE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ⛔ `nextval` is non-transactional: a rolled-back issue burns its number for ever. That is not
-- a hypothetical here — `order_no_seq.last_value` is 1049 in this developer's database against
-- eight rows in `orders`. An order number with holes is untidy; a tax series with holes is a
-- series an auditor walks and finds missing.
--
-- So the counter is a ROW, taken with `FOR UPDATE` inside the issuing transaction. Two people
-- pressing at once serialise on it, and a transaction that rolls back takes its number with it.
-- The cost is that concurrent issues wait for each other, which is the correct trade: a document
-- number is not a thing to be fast about.
CREATE TABLE "document_series_counters" (
  "series_code" text NOT NULL,
  "series_year" smallint NOT NULL,
  "next_seq"    integer NOT NULL DEFAULT 1,
  CONSTRAINT "document_series_counters_pkey" PRIMARY KEY ("series_code", "series_year"),
  CONSTRAINT "document_series_counters_series_fk" FOREIGN KEY ("series_code")
    REFERENCES "document_series"("series_code") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "document_series_counters_next_seq_positive" CHECK ("document_series_counters"."next_seq" >= 1)
);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓷ THE DOCUMENTS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One table, `kind` as text + CHECK — the same shape the order spine uses for its own closed
-- sets, and for the same reason: a member can be added by migration and taken back out.
--
-- ⚠️ Every money column is POSITIVE, including a credit note's. The direction is the `kind`.
-- A sign in a money column is a sign somebody eventually forgets to apply.
--
-- ⚠️ `document` holds the whole rendered record — seller block, buyer block, lines, totals — as
-- it stood at issue. The seller's letterhead is pinned here, deliberately departing from
-- `organisation_profile`'s note that "a letterhead is not frozen": that is right for a
-- quotation and wrong for a document filed with the Revenue Department, where the company's
-- name, address and tax id at the date of issue are part of the record.
CREATE TABLE "tax_documents" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind"                  text NOT NULL,
  "status"                text NOT NULL DEFAULT 'issued',
  "order_id"              uuid NOT NULL,
  "instalment_id"         uuid,
  "slip_id"               uuid,
  "replaces_document_id"  uuid,
  "voided_by_document_id" uuid,
  "voided_at"             timestamp with time zone,
  "void_reason_th"        text,
  "series_code"           text NOT NULL,
  "series_year"           smallint NOT NULL,
  "series_seq"            integer NOT NULL,
  "document_no"           text NOT NULL,
  "document"              jsonb NOT NULL,
  "document_hash"         char(64) NOT NULL,
  "pin_schema_version"    smallint NOT NULL DEFAULT 1,
  "pinned_locale"         text NOT NULL,
  "pinned_vat_rate_bp"    integer NOT NULL,
  "pinned_vat_treatment"  text NOT NULL,
  "net_thb_minor"         bigint NOT NULL,
  "vat_thb_minor"         bigint NOT NULL,
  "grand_total_thb_minor" bigint NOT NULL,
  "issued_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "issued_by_user_id"     uuid,
  "created_by_event_id"   uuid NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "tax_documents_kind_known" CHECK ("tax_documents"."kind" in (
    'invoice', 'tax_invoice', 'abbreviated_tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note'
  )),
  CONSTRAINT "tax_documents_status_known" CHECK ("tax_documents"."status" in ('issued', 'voided')),
  CONSTRAINT "tax_documents_no_unique" UNIQUE ("document_no"),
  CONSTRAINT "tax_documents_series_seq_unique" UNIQUE ("series_code", "series_year", "series_seq"),
  CONSTRAINT "tax_documents_id_order_key" UNIQUE ("id", "order_id"),

  CONSTRAINT "tax_documents_order_fk" FOREIGN KEY ("order_id")
    REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  /* ⚠️ Composite, so a document cannot be hung off another order's instalment or slip. */
  CONSTRAINT "tax_documents_instalment_fk" FOREIGN KEY ("instalment_id", "order_id")
    REFERENCES "order_instalments"("id", "order_id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "tax_documents_slip_fk" FOREIGN KEY ("slip_id", "order_id")
    REFERENCES "payment_slips"("id", "order_id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "tax_documents_event_fk" FOREIGN KEY ("created_by_event_id", "order_id")
    REFERENCES "order_events"("id", "order_id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "tax_documents_replaces_fk" FOREIGN KEY ("replaces_document_id")
    REFERENCES "tax_documents"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "tax_documents_voided_by_fk" FOREIGN KEY ("voided_by_document_id")
    REFERENCES "tax_documents"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "tax_documents_series_fk" FOREIGN KEY ("series_code")
    REFERENCES "document_series"("series_code") ON UPDATE CASCADE ON DELETE RESTRICT,

  /* Copied from `order_documents`, so there is no second definition of the same arithmetic. */
  CONSTRAINT "tax_documents_total_foots" CHECK (
    "tax_documents"."grand_total_thb_minor" = "tax_documents"."net_thb_minor" + "tax_documents"."vat_thb_minor"
  ),
  CONSTRAINT "tax_documents_money_nonnegative" CHECK (
    "tax_documents"."net_thb_minor" >= 0 and "tax_documents"."vat_thb_minor" >= 0
  ),
  CONSTRAINT "tax_documents_hash_is_hex" CHECK ("tax_documents"."document_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tax_documents_document_is_object" CHECK (jsonb_typeof("tax_documents"."document") = 'object'),
  CONSTRAINT "tax_documents_vat_rate_in_range" CHECK (
    "tax_documents"."pinned_vat_rate_bp" between 0 and 10000
  ),

  /* A void is a pair of facts or neither of them. */
  CONSTRAINT "tax_documents_void_shape" CHECK (
    ("tax_documents"."status" = 'voided') = ("tax_documents"."voided_at" is not null)
  ),
  /*
   * ⛔ A credit note is what *does* the reducing, so it is never itself the thing voided by a
   * later document, and it must name the document it reduces.
   */
  CONSTRAINT "tax_documents_credit_note_cites" CHECK (
    "tax_documents"."kind" <> 'credit_note' or "tax_documents"."replaces_document_id" is not null
  ),
  /* Only a document about one payment or one instalment may name one. */
  CONSTRAINT "tax_documents_instalment_scope" CHECK (
    "tax_documents"."instalment_id" is null
    or "tax_documents"."kind" in ('invoice', 'tax_invoice', 'abbreviated_tax_invoice', 'receipt', 'tax_invoice_receipt')
  )
);
--> statement-breakpoint

CREATE INDEX "tax_documents_order_idx" ON "tax_documents" ("order_id", "issued_at");
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓸ ⛔ THE SAME SUPPLY MAY NOT BE TAX-INVOICED TWICE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The owner asked for BOTH modes to be switchable independently — per instalment and once at
-- delivery. With both on, nothing in a service prevents the same money being tax-invoiced by
-- each path, and an issued document cannot be corrected except by credit note. So the rule is
-- in the database, where no writer can miss it.
--
-- Partial, on `status = 'issued'`: a voided document must not block the replacement that exists
-- precisely to take its place.
CREATE UNIQUE INDEX "tax_documents_one_per_instalment_kind"
  ON "tax_documents" ("instalment_id", "kind")
  WHERE "status" = 'issued' AND "instalment_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "tax_documents_one_per_slip_kind"
  ON "tax_documents" ("slip_id", "kind")
  WHERE "status" = 'issued' AND "slip_id" IS NOT NULL;
--> statement-breakpoint

/*
 * ⛔ And at most one whole-order tax document per order: the delivery-mode one. An instalment
 * document names its instalment and is excluded here by that.
 */
CREATE UNIQUE INDEX "tax_documents_one_whole_order_tax"
  ON "tax_documents" ("order_id")
  WHERE "status" = 'issued'
    AND "instalment_id" IS NULL
    AND "kind" IN ('tax_invoice', 'abbreviated_tax_invoice', 'tax_invoice_receipt');
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓹ AN ISSUED DOCUMENT NEVER CHANGES, AND IS NEVER DELETED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `order_documents_freeze()` refuses every UPDATE unconditionally. That is right for a
-- quotation and one notch too strict here: a voided document has to be *marked* voided.
--
-- So exactly one transition is permitted, and every other column is compared field by field.
-- The document body, its hash, its number and its three money figures can never move under any
-- path — including the void.
--
-- ⚠️ The owner's standing rule is that deletion is a status flag and never a real delete. Here
-- both rules hold at once, and in Postgres rather than in a service, because the service is not
-- the only writer: `db:seed`, a psql session and a future worker all reach this table.
CREATE FUNCTION tax_documents_freeze() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_documents is append-only; void the document instead of deleting it'
      USING ERRCODE = 'restrict_violation',
            HINT = 'an issued document is evidence — a mistake is corrected by a credit note';
  END IF;

  IF NOT (OLD.status = 'issued' AND NEW.status = 'voided') THEN
    RAISE EXCEPTION 'tax_document % is issued and cannot be edited', OLD.document_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.voided_at IS NULL OR NEW.voided_by_document_id IS NULL THEN
    RAISE EXCEPTION 'voiding % must record when, and which document replaced it', OLD.document_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.instalment_id IS DISTINCT FROM OLD.instalment_id
     OR NEW.slip_id IS DISTINCT FROM OLD.slip_id
     OR NEW.replaces_document_id IS DISTINCT FROM OLD.replaces_document_id
     OR NEW.series_code IS DISTINCT FROM OLD.series_code
     OR NEW.series_year IS DISTINCT FROM OLD.series_year
     OR NEW.series_seq IS DISTINCT FROM OLD.series_seq
     OR NEW.document_no IS DISTINCT FROM OLD.document_no
     OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.document_hash IS DISTINCT FROM OLD.document_hash
     OR NEW.pin_schema_version IS DISTINCT FROM OLD.pin_schema_version
     OR NEW.pinned_locale IS DISTINCT FROM OLD.pinned_locale
     OR NEW.pinned_vat_rate_bp IS DISTINCT FROM OLD.pinned_vat_rate_bp
     OR NEW.pinned_vat_treatment IS DISTINCT FROM OLD.pinned_vat_treatment
     OR NEW.net_thb_minor IS DISTINCT FROM OLD.net_thb_minor
     OR NEW.vat_thb_minor IS DISTINCT FROM OLD.vat_thb_minor
     OR NEW.grand_total_thb_minor IS DISTINCT FROM OLD.grand_total_thb_minor
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
     OR NEW.created_by_event_id IS DISTINCT FROM OLD.created_by_event_id
  THEN
    RAISE EXCEPTION 'voiding % may set only the void columns', OLD.document_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER tax_documents_freeze
  BEFORE UPDATE OR DELETE ON tax_documents
  FOR EACH ROW EXECUTE FUNCTION tax_documents_freeze();
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓺ THE NUMBER
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `next_document_no('TAX', now())` → `('TAX', 2569, 7, 'TAX-2569-00007')`.
--
-- The counter row is created on first use and locked with `FOR UPDATE`, so two transactions
-- issuing at the same instant serialise here rather than both taking 7. A rolled-back caller
-- releases the number with the lock.
--
-- ⚠️ The year is the *era's* year: `BE` adds 543, which is what a Thai document shows. It is a
-- column on the series so it can be changed without a migration — the numbering scheme is the
-- accountant's to state, and this is written before they have.
CREATE FUNCTION next_document_no(p_series_code text, p_at timestamptz)
RETURNS TABLE (series_code text, series_year smallint, series_seq integer, document_no text) AS $$
DECLARE
  series  document_series%ROWTYPE;
  year_be smallint;
  seq     integer;
BEGIN
  SELECT * INTO series FROM document_series s WHERE s.series_code = p_series_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document series % does not exist', p_series_code
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  year_be := extract(year from p_at at time zone 'Asia/Bangkok')::smallint
             + CASE WHEN series.year_era = 'BE' THEN 543 ELSE 0 END;

  IF NOT series.resets_yearly THEN
    year_be := 0;  -- One counter for all time; the year is still stored so a reader can see it.
  END IF;

  INSERT INTO document_series_counters (series_code, series_year, next_seq)
  VALUES (p_series_code, year_be, 1)
  ON CONFLICT (series_code, series_year) DO NOTHING;

  SELECT c.next_seq INTO seq
    FROM document_series_counters c
   WHERE c.series_code = p_series_code AND c.series_year = year_be
   FOR UPDATE;

  UPDATE document_series_counters c
     SET next_seq = seq + 1
   WHERE c.series_code = p_series_code AND c.series_year = year_be;

  RETURN QUERY SELECT
    p_series_code,
    year_be,
    seq,
    series.prefix || '-' || year_be::text || '-' || lpad(seq::text, series.pad_width, '0');
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

/*
 * The shipped series, one per kind. Prefixes and padding are data: the accountant may want
 * different ones and that is an UPDATE, not a migration.
 */
INSERT INTO document_series (series_code, kind, prefix) VALUES
  ('INV', 'invoice', 'INV'),
  ('TAX', 'tax_invoice', 'TAX'),
  ('ABB', 'abbreviated_tax_invoice', 'ABB'),
  ('RCP', 'receipt', 'RCP'),
  ('TRC', 'tax_invoice_receipt', 'TRC'),
  ('CN', 'credit_note', 'CN')
ON CONFLICT (series_code) DO NOTHING;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓻ WHO IS BILLED — the block a tax invoice must print and the system did not hold
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The system holds a contact name, an email and a telephone number, and **no address anywhere**.
-- A full ใบกำกับภาษี cannot be issued without the buyer's name, address and — for a company —
-- their 13-digit tax id.
--
-- ⚠️ Keyed on the ORDER, not on the user, for two independent reasons. A walk-in owns their
-- order through a `guests` row that holds nothing personal at all, so a user-keyed table could
-- not serve the customer standing at the counter. And in made-to-measure work the person who
-- orders and the party who is billed are often not the same — a landlord, a company, a spouse.
--
-- ⚠️ Copied INTO the document at issue and frozen there. This table is what the *next* document
-- starts from; it is not what an issued one reads.
CREATE TABLE "order_bill_to" (
  "order_id"     uuid PRIMARY KEY,
  "buyer_kind"   text NOT NULL,
  "legal_name"   text NOT NULL,
  "tax_id"       char(13),
  "branch_code"  text,
  "address_line" text NOT NULL,
  "postal_code"  text,
  "country"      char(2) NOT NULL DEFAULT 'TH',
  "updated_by_user_id" uuid,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "order_bill_to_order_fk" FOREIGN KEY ("order_id")
    REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "order_bill_to_kind_known" CHECK ("order_bill_to"."buyer_kind" in ('individual', 'juristic')),
  CONSTRAINT "order_bill_to_name_says_something" CHECK (length(btrim("order_bill_to"."legal_name")) > 0),
  CONSTRAINT "order_bill_to_address_says_something" CHECK (length(btrim("order_bill_to"."address_line")) > 0),
  CONSTRAINT "order_bill_to_tax_id_shape" CHECK (
    "order_bill_to"."tax_id" is null or "order_bill_to"."tax_id" ~ '^[0-9]{13}$'
  ),
  /* ⛔ A company buyer without a tax id cannot be issued a full tax invoice at all. */
  CONSTRAINT "order_bill_to_juristic_has_tax_id" CHECK (
    "order_bill_to"."buyer_kind" <> 'juristic' or "order_bill_to"."tax_id" is not null
  )
);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓼ THE SWITCHES — 2.1, 2.2 and 2.3, all off
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ `NOT NULL DEFAULT false`, following 0059. A `NOT NULL` with no default cannot be added to a
-- table that already has a row, which `organisation_profile` does by construction (it is a
-- singleton).
--
-- ⛔ THE OWNER'S OWN DECISION, RECORDED WHERE IT TAKES EFFECT. They were told that
-- `tax_doc_on_delivery` alone can under-declare output VAT when a deposit was taken before
-- delivery — the tax point on that money has already passed — and chose to keep both switches
-- independent: *"เปิดอิสระทั้งสองสวิตช์ ตามที่สั่งเดิม"*. The settings screen says so beside the
-- switch; this comment is the other half of that record.
ALTER TABLE "organisation_profile"
  ADD COLUMN "tax_doc_enabled"               boolean NOT NULL DEFAULT false,
  ADD COLUMN "tax_doc_on_instalment"         boolean NOT NULL DEFAULT false,
  ADD COLUMN "tax_doc_on_delivery"           boolean NOT NULL DEFAULT false,
  ADD COLUMN "tax_doc_combined_receipt"      boolean NOT NULL DEFAULT true,
  ADD COLUMN "tax_doc_invoice_on_demand"     boolean NOT NULL DEFAULT false,
  ADD COLUMN "tax_doc_abbreviated_allowed"   boolean NOT NULL DEFAULT false;
