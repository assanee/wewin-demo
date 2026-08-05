-- The rules of the sales-editable quote that are not tables: three functions, six triggers,
-- one deferrable foreign key, and two guards this file deliberately does NOT write.
--
-- Same arrangement and the same reason as 0007_order_guards.sql and 0011_payment_guards.sql:
-- drizzle-kit generates tables, constraints and indexes from src/schema and generates no
-- triggers, no functions, no deferred assertions and no deferrable foreign keys. This is a
-- migration applied by the same `drizzle-kit migrate` in the same order, not a runbook step.
--
-- ── What is in here, and why none of it could be a CHECK ─────────────────────────
--
--   * "a quote may only be edited while the order is still editable" reads `orders`;
--   * "this line carries a promise, so its price inputs are frozen" reads `quote_overrides`;
--   * "append-only, except for supersession, once" compares OLD to NEW;
--   * "the row that replaced this one replaced the same thing" reads a second row of the
--     same table, at COMMIT, because it does not exist yet when the stamp is written.
--
-- A CHECK constraint sees one row of one table and none of the four is that.
--
-- ── And two things that are NOT here, said out loud ──────────────────────────────
--
--   ⚠️ NO TRUNCATE GUARD ON `quote_lines`. `order_document_product_versions` has one
--      (`order_document_versions_block_truncate`) because `pnpm db:seed` runs
--      `TRUNCATE categories, products, option_groups … CASCADE`, which walks foreign keys
--      and ignores ON DELETE RESTRICT. The same cascade reaches `quote_lines` through
--      `product_versions`, and from there `quote_overrides`. The contract's own provenance
--      survives — it is the frozen `order_documents.document` plus the guarded citation
--      table — but the *working* quote and its override history do not.
--      This is a real residual and it is a trade: a second truncate guard would make
--      `pnpm db:seed` fail on any developer database that has ever held a cart, which is
--      the state every developer database reaches on day one. Revisit when there is a seed
--      path that does not truncate.
--
--   ⚠️ NOTHING HERE REQUIRES AN APPROVAL. Plan 13's authority table ships empty and
--      fail-closed, and plan 7.13's second warning is that a policy table with no defined
--      day-one behaviour is a feature that dies quietly. The rule "a concession above the
--      ceiling needs an approval" is enforced by the API at submit, at the *document*
--      level (plan 7.13: per-row evaluation loses to splitting one concession across ten
--      lines). A trigger demanding it would make plan 13's smoke path — ฿8,791, 30%
--      deposit, one slip, confirm, produce, deliver — impossible, and would add a fifth
--      two-person rule to a workflow plan 7.13 says is already at its limit at four.


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — A QUOTE IS EDITABLE IN THREE STATUSES, AND THE LIST LIVES IN ONE PLACE
-- ═════════════════════════════════════════════════════════════════════════════

-- Reusing `order_child_require_status()` from 0007_order_guards.sql rather than writing a
-- third copy of the same idea. That function is trap 6's answer — it takes `FOR SHARE` on
-- the order rather than merely ordering the race, so a write racing a transition *blocks*,
-- re-reads under READ COMMITTED and refuses, instead of passing on a snapshot taken before
-- the transition committed.
--
-- The three statuses are plan 7.5(ง)'s repriceable set: `draft` is the cart,
-- `awaiting_payment` is a quote that went out and has not been paid, `redesign` is a frozen
-- order the factory bounced — the one the plan says everybody forgets, and where the edit is
-- usually more expensive rather than less.
--
-- ⚠️ This TG_ARGV list is the DEFINITION. `QUOTE_EDITABLE_ORDER_STATUSES` in
-- src/schema/quote.ts is a mirror of it, exactly as `POST_FREEZE_STATUSES` mirrors
-- `order_status_is_post_freeze()`, and tests/quote.test.ts reads `pg_get_triggerdef` and
-- fails if the two drift.
CREATE TRIGGER quote_lines_live_orders_only
  BEFORE INSERT OR UPDATE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_payment,redesign}'
  );
--> statement-breakpoint

CREATE TRIGGER quote_overrides_live_orders_only
  BEFORE INSERT OR UPDATE ON quote_overrides
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_payment,redesign}'
  );
--> statement-breakpoint

-- A quote line cites the catalogue as published, never as somebody was editing it — trap 3,
-- one table further in again. `order_document_versions_must_be_published()` already says
-- exactly this about exactly this column name, so it is reused rather than copied; the
-- WHEN clause is because a free-form line has no version to check.
CREATE TRIGGER quote_lines_versions_must_be_published
  BEFORE INSERT OR UPDATE ON quote_lines
  FOR EACH ROW WHEN (NEW.product_version_id IS NOT NULL)
  EXECUTE FUNCTION order_document_versions_must_be_published();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — WHAT A LINE MAY NOT BECOME
-- ═════════════════════════════════════════════════════════════════════════════

-- Three separate rules in one BEFORE trigger so they all see the same row.
--
-- ⓵ `product_version_id` and `kind` never move (plan 7.9(ค)). A different product is a
--    different line, and a catalog line that became a free-form line would be a line whose
--    computed figure quietly became a typed one.
--
-- ⓶ `sku_code` never moves ALONE. It is derived from `selections` by @wewin/core/skuCode,
--    so the two travel together or the sku is a number somebody typed — and the sku is what
--    the factory cuts from. Plan 7.9(ค)'s ⚠️ is that sales can write "กระจกเทมเปอร์ 8 มม."
--    on a line whose sku says 6 mm; the answer is not to police the prose, it is to make the
--    prose the only freely editable field and the sku a derived one.
--
-- ⓷ ⭐ THE ONE THAT CLOSES PLAN 7.9(ง)(2), which is the finding with a line number on it.
--
--    `quoteReducer.ts:68` recomputes `total = round(unitPrice × qty)` on every press of the
--    + button, and tests/quoteReducer.test.ts pins that behaviour. Sales negotiates ฿17,000
--    for two, the customer asks for a third, and **the promise disappears silently** — no
--    error, no record, an order that goes out at list price after somebody agreed otherwise.
--
--    An absolute override (plan 7.9(ก)) cannot survive a change to the quantity or the
--    configuration it was quoted against, because ฿17,000 for two is not ฿17,000 for three.
--    So the repricing inputs are frozen while a promise is live, and the way to reprice is
--    to supersede the override *first* — one extra deliberate act, with a person's name and
--    a reason on it, instead of one silent loss.
--
--    `removed_at` is in the list for the same reason: removing a line that carries a live
--    promise is the same disappearance with a different spelling.
CREATE FUNCTION quote_lines_guard_write() RETURNS trigger AS $$
DECLARE
  parent   orders%ROWTYPE;
  promised uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- `NOT FOUND` means the order row is already gone in this transaction, i.e. this is the
    -- cascade from a draft-cart delete that `orders_block_delete()` already allowed. Same
    -- idiom, and the same reasoning, as `order_events_append_only()`.
    SELECT * INTO parent FROM orders WHERE id = OLD.order_id;

    IF FOUND AND parent.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'order % has been submitted; quote line % is removed, never deleted',
        parent.id, OLD.id
        USING ERRCODE = 'restrict_violation',
              HINT = 'set removed_at and removed_by_user_id — the overrides on this line are evidence';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.product_version_id IS DISTINCT FROM OLD.product_version_id THEN
    RAISE EXCEPTION 'product_version_id is not editable on quote line %', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'a different product is a different line — plan 7.9(ค)';
  END IF;

  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'kind is not editable on quote line %', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'a computed figure and a typed one are different layers — plan 7.9(ก)';
  END IF;

  IF NEW.sku_code IS DISTINCT FROM OLD.sku_code
     AND NEW.selections IS NOT DISTINCT FROM OLD.selections THEN
    RAISE EXCEPTION 'sku_code is derived from selections and cannot be set on its own (quote line %)',
      OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'the works order renders from the sku — plan 7.9(ค)';
  END IF;

  IF NEW.qty                         IS DISTINCT FROM OLD.qty
     OR NEW.selections               IS DISTINCT FROM OLD.selections
     OR NEW.measures                 IS DISTINCT FROM OLD.measures
     OR NEW.sku_code                 IS DISTINCT FROM OLD.sku_code
     OR NEW.config_hash              IS DISTINCT FROM OLD.config_hash
     OR NEW.computed_total_thb_minor IS DISTINCT FROM OLD.computed_total_thb_minor
     OR NEW.charge_total_thb_minor   IS DISTINCT FROM OLD.charge_total_thb_minor
     OR NEW.removed_at               IS DISTINCT FROM OLD.removed_at
  THEN
    SELECT o.id INTO promised
      FROM quote_overrides o
     WHERE o.quote_line_id = OLD.id
       AND o.anchor = 'line_total'
       AND o.superseded_at IS NULL
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'quote line % carries live override %; repricing it would drop a promise silently',
        OLD.id, promised
        USING ERRCODE = 'restrict_violation',
              HINT = 'supersede the override first — replaced, or revoked — plan 7.9(ง)(2)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quote_lines_guard_write
  BEFORE UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION quote_lines_guard_write();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — AN OVERRIDE IS APPEND-ONLY, AND SUPERSESSION IS THE ONE EXCEPTION
-- ═════════════════════════════════════════════════════════════════════════════

-- Same rule as the spine, a published catalogue document and the ledger, for the same
-- reason: a quote disputed months later has to be reconstructable, and a row that can be
-- rewritten reconstructs whatever the last editor wanted it to say.
--
-- The exception is narrow on purpose. Exactly ONE update is legal per row — the four
-- supersession columns moving NULL → NOT NULL, once — and that is what makes plan 7.9(ค)'s
-- *"the computed baseline of an override already issued is not editable"* true without a
-- rule of its own: it is not a separate constraint, it is what append-only means.
--
-- ⚠️ Why `computed_thb_minor` still gets its own branch and its own message. It is the
-- column an attack would go for: leave the ฿8,500 the customer was promised, quietly raise
-- the baseline it was taken against from ฿8,791 to ฿12,000, and a ฿291 concession becomes a
-- ฿3,500 one that no ceiling was ever asked about — or the reverse, to slip under one. The
-- generic branch below catches it either way; a message that names the column is what makes
-- the attempt legible in a log instead of looking like a clumsy UPDATE.
CREATE FUNCTION quote_overrides_guard_write() RETURNS trigger AS $$
DECLARE
  parent orders%ROWTYPE;
  line   quote_lines%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'an override is inserted live; superseding it is a later and separate act'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.quote_line_id IS NOT NULL THEN
      SELECT * INTO line FROM quote_lines WHERE id = NEW.quote_line_id;

      IF FOUND AND line.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'quote line % was removed at % and cannot take a new override',
          NEW.quote_line_id, line.removed_at
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT * INTO parent FROM orders WHERE id = OLD.order_id;

    IF FOUND AND (parent.status <> 'draft' OR parent.submitted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'override % of order % is history and cannot be deleted', OLD.id, parent.id
        USING ERRCODE = 'restrict_violation',
              HINT = 'supersede it instead — replaced, or revoked';
    END IF;

    RETURN OLD;
  END IF;

  -- UPDATE.
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'override % was superseded at % and is frozen', OLD.id, OLD.superseded_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'quote_overrides is append-only; override % can only be superseded', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'write a new row and stamp this one — plan 7.9(ก)';
  END IF;

  IF NEW.computed_thb_minor IS DISTINCT FROM OLD.computed_thb_minor
     OR NEW.computed_days   IS DISTINCT FROM OLD.computed_days THEN
    RAISE EXCEPTION 'the computed baseline of override % is what it was taken against and cannot be edited',
      OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'a baseline that moves rewrites a concession nobody re-approved — plan 7.9(ค)';
  END IF;

  IF NEW.id                    <>               OLD.id
     OR NEW.order_id           <>               OLD.order_id
     OR NEW.quote_line_id      IS DISTINCT FROM OLD.quote_line_id
     OR NEW.anchor             <>               OLD.anchor
     OR NEW.override_thb_minor IS DISTINCT FROM OLD.override_thb_minor
     OR NEW.override_days      IS DISTINCT FROM OLD.override_days
     OR NEW.entered_as         <>               OLD.entered_as
     OR NEW.entered_value_text <>               OLD.entered_value_text
     OR NEW.reason_code        <>               OLD.reason_code
     OR NEW.note_th            IS DISTINCT FROM OLD.note_th
     OR NEW.set_by_user_id     <>               OLD.set_by_user_id
     OR NEW.created_at         <>               OLD.created_at
  THEN
    RAISE EXCEPTION 'quote_overrides is append-only; override % may only be stamped superseded', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'changing a promise is a new row plus a stamp on this one';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quote_overrides_guard_write
  BEFORE INSERT OR UPDATE OR DELETE ON quote_overrides
  FOR EACH ROW EXECUTE FUNCTION quote_overrides_guard_write();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — THE CHAIN, AND THE ORDER OF STATEMENTS THAT MAKES IT WRITABLE AT ALL
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️⚠️ ORDER OF STATEMENTS AT SUPERSESSION TIME ⚠️⚠️
--
-- This is `product_versions_one_published_per_product`'s "archive first, publish second"
-- arriving a second time, in a place nobody expected it, and it was found by a test that
-- did it the obvious way round and got a 23505.
--
-- `quote_overrides_one_active_per_line` is a PARTIAL unique index, so it is enforced per
-- statement and cannot be declared DEFERRABLE — only unique *constraints* can be, and a
-- constraint cannot carry a WHERE clause. So the obvious sequence
--
--     1. INSERT the replacement          ← 23505: two live overrides on one anchor
--     2. UPDATE the old row to point at it
--
-- is not merely inelegant, it is impossible. The sequence that works is the other one:
--
--     1. choose the replacement's id in the caller
--     2. UPDATE the old row: superseded_at, superseded_by_user_id, reason, and that id
--     3. INSERT the replacement with that id
--     4. COMMIT                          ← the FK below is checked here
--
-- which needs the foreign key to be DEFERRABLE INITIALLY DEFERRED, exactly as
-- `orders_status_event_fk` is for trap 1's circular pair. drizzle-kit emits no such clause,
-- so — like that one — the column carries no `.references()` in src/schema and the
-- constraint is written here.
--
-- The alternative was to drop the chain and record every replacement as a `revoked` plus an
-- unrelated new row. That is one statement simpler and it loses the only thing that makes
-- the history reconstructable: which promise replaced which.
ALTER TABLE quote_overrides
  ADD CONSTRAINT quote_overrides_successor_fk
  FOREIGN KEY (superseded_by_override_id, order_id)
  REFERENCES quote_overrides (id, order_id)
  ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- And the half of the chain a foreign key cannot state: the row that replaced this one
-- replaced *the same thing*.
--
-- A `grand_total` row named as the successor of a `line_total` row leaves the line with no
-- live override and the document with two — and neither partial unique index can see it,
-- because each looks at one (subject, anchor) pair at a time and both pairs are individually
-- legal. Only a comparison of the two rows catches it.
--
-- A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, for the same reason the FK above is:
-- at the moment the stamp is written the successor does not exist yet.
--
-- ⚠️ What this deliberately does NOT assert: that the successor is itself still live. In a
-- legitimate A → B → C written inside one transaction, B is already superseded by the time
-- the check runs at COMMIT, so the assertion would fire on correct history. And it would buy
-- little: at most one row per (subject, anchor) can be live, which the indexes already
-- enforce, so a successor that is itself superseded cannot fabricate a promise — it can only
-- leave the line with none, which is the customer paying list price.
CREATE FUNCTION quote_overrides_assert_successor() RETURNS trigger AS $$
DECLARE
  successor quote_overrides%ROWTYPE;
BEGIN
  SELECT * INTO successor FROM quote_overrides WHERE id = NEW.superseded_by_override_id;

  -- ⚠️ THIS BRANCH HAS NO INDEPENDENT EVIDENCE AND IS REPORTED RATHER THAN CLAIMED.
  --
  -- Mutation testing neutralised it and the suite stayed green: `quote_overrides_successor_fk`
  -- above catches the same case, is deferred to the same COMMIT, and raises the same SQLSTATE
  -- (23503). No test can tell the two apart, because separating them means dropping the
  -- foreign key — which is a mutation, not a test. It is kept for the message it produces,
  -- not for a rule it enforces alone. 5b's report ends with the same sentence about the
  -- refund freeze: a test that is green with two mechanisms behind it is evidence for
  -- neither.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override % names successor %, which does not exist',
      NEW.id, NEW.superseded_by_override_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF successor.anchor <> NEW.anchor
     OR successor.quote_line_id IS DISTINCT FROM NEW.quote_line_id THEN
    RAISE EXCEPTION 'override % (% on %) cannot be replaced by % (% on %)',
      NEW.id, NEW.anchor, coalesce(NEW.quote_line_id::text, 'the document'),
      successor.id, successor.anchor, coalesce(successor.quote_line_id::text, 'the document')
      USING ERRCODE = 'restrict_violation',
            HINT = 'a replacement replaces the same subject and the same anchor';
  END IF;

  -- Two rows naming each other is a history with no beginning, and the walk that
  -- reconstructs a disputed quote would not terminate.
  IF successor.superseded_by_override_id = NEW.id THEN
    RAISE EXCEPTION 'overrides % and % name each other as successors', NEW.id, successor.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER quote_overrides_successor_matches
  AFTER UPDATE ON quote_overrides
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.superseded_by_override_id IS NOT NULL)
  EXECUTE FUNCTION quote_overrides_assert_successor();
