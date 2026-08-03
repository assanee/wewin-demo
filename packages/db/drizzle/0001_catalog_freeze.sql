-- Freezing, and the one thing about publishing that no constraint can express.
--
-- Drizzle generates tables, constraints and indexes from src/schema. It does not
-- generate triggers, so this file is written by hand and applied by the same
-- `drizzle-kit migrate` in the same order — it is a migration, not a runbook step
-- somebody has to remember.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PUBLISH ORDER — archive the old version BEFORE publishing the new one.
--
--   product_versions_one_published_per_product is a PARTIAL unique index. Postgres
--   evaluates it at the end of each statement, and a partial index cannot be made
--   DEFERRABLE: only unique *constraints* can be deferred, and a unique constraint
--   cannot carry a WHERE clause. So there is no window in which two rows of a product
--   may both be 'published', not even one that closes before COMMIT.
--
--   The order that works, inside one transaction:
--     1. SELECT id FROM products WHERE id = $1 FOR UPDATE    -- serialise per product
--     2. UPDATE product_versions SET status='archived' ... WHERE status='published'
--     3. UPDATE product_versions SET status='published' WHERE id = $2
--
--   Swapping 2 and 3 raises 23505 on a transaction that would have committed a legal
--   state. src/publish.ts is this sequence as code and tests/publish.test.ts runs the
--   inversion to prove the failure is real.
-- ─────────────────────────────────────────────────────────────────────────────

-- A published or archived version is the document an order was quoted from. Editing it
-- would change the past. The trigger is scoped to the columns that make up that
-- document, on purpose: `status`, `archived_at` and `updated_at` still have to move,
-- because archiving is exactly what happens to a frozen row when it is superseded.
CREATE FUNCTION product_versions_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.document IS DISTINCT FROM OLD.document
    OR NEW.document_hash IS DISTINCT FROM OLD.document_hash
    OR NEW.document_schema_version IS DISTINCT FROM OLD.document_schema_version
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  ) THEN
    RAISE EXCEPTION 'product version % is %, its document is frozen', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Un-publishing by editing a row would leave orders pointing at a draft. A superseded
  -- version becomes 'archived'; there is no way back to 'draft' and no way out of
  -- 'archived' at all.
  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'product version % cannot go from published back to draft', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION 'product version % is archived and cannot be revived', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER product_versions_freeze
  BEFORE UPDATE ON product_versions
  FOR EACH ROW EXECUTE FUNCTION product_versions_freeze();
--> statement-breakpoint

-- Deleting a published version deletes the only record of what a customer was shown.
-- Blocking it here also blocks `DELETE FROM products`, which cascades — which is the
-- right answer: a product that has been sold is hidden, never removed.
CREATE FUNCTION product_versions_block_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'product version % is % and cannot be deleted', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER product_versions_block_delete
  BEFORE DELETE ON product_versions
  FOR EACH ROW EXECUTE FUNCTION product_versions_block_delete();
--> statement-breakpoint

-- The rows a document was compiled from are part of the same record. If they could be
-- edited after publication, the document and its own provenance would disagree and
-- there would be no way to tell which one was rewritten. A new draft version gets new
-- rows; it does not borrow the published one's.
CREATE FUNCTION product_version_children_freeze() RETURNS trigger AS $$
DECLARE
  parent_id uuid;
  parent_status product_version_status;
BEGIN
  -- Branch on TG_OP rather than COALESCE(NEW, OLD): in a DELETE trigger NEW is not
  -- assigned, and reading a field off it raises before any check here can run.
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.product_version_id;
  ELSE
    parent_id := NEW.product_version_id;
  END IF;

  SELECT status INTO parent_status FROM product_versions WHERE id = parent_id;

  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION '% belongs to product version %, which is %',
      TG_TABLE_NAME, parent_id, parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER product_version_options_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON product_version_options
  FOR EACH ROW EXECUTE FUNCTION product_version_children_freeze();
--> statement-breakpoint

CREATE TRIGGER product_version_rules_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON product_version_rules
  FOR EACH ROW EXECUTE FUNCTION product_version_children_freeze();
--> statement-breakpoint

-- Same rule, one join further out: this table names its version only through
-- product_version_options.
CREATE FUNCTION product_version_option_values_freeze() RETURNS trigger AS $$
DECLARE
  option_id uuid;
  parent_status product_version_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    option_id := OLD.product_version_option_id;
  ELSE
    option_id := NEW.product_version_option_id;
  END IF;

  SELECT pv.status INTO parent_status
    FROM product_version_options pvo
    JOIN product_versions pv ON pv.id = pvo.product_version_id
   WHERE pvo.id = option_id;

  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'product_version_option_values belongs to a % version', parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER product_version_option_values_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON product_version_option_values
  FOR EACH ROW EXECUTE FUNCTION product_version_option_values_freeze();
--> statement-breakpoint

-- Stock is the exception plan 5 point 2 calls out: `available` moves without a publish,
-- so it must never be inside a frozen document. This makes the omission checkable
-- rather than a habit — the seed and the api both compile through src/compile.ts, and
-- if either ever wrote the field, this fails on the write that did it.
ALTER TABLE product_versions
  ADD CONSTRAINT product_versions_document_has_no_availability
  CHECK (NOT jsonb_path_exists(document, '$.groups[*].values[*].available'));
--> statement-breakpoint

-- The blob and the column that says how to read it, kept in step. Plan 4.5 is a list of
-- payloads whose version field and whose content drifted apart in silence.
ALTER TABLE product_versions
  ADD CONSTRAINT product_versions_document_schema_version_matches
  CHECK ((document ->> 'schemaVersion')::int = document_schema_version);
