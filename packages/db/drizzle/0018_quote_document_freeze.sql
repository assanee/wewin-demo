-- ⭐ THE GUARD 5c SHIPPED WITHOUT, AND THE FOUR ATTACKS THAT WALKED THROUGH THE GAP.
--
-- `0016_quote_guards.sql` freezes a *line's* repricing inputs while a live `line_total` override
-- hangs off it, and says why: an absolute promise cannot survive a change to the thing it was
-- quoted against, so ฿17,000 for two must not silently become ฿17,000 for three. That rule was
-- written for the line anchor and never written for the document anchor — and a `grand_total`
-- override is exactly the same promise about a bigger subject.
--
-- Two red teams found the hole independently, from opposite ends. Both reproductions are now
-- regression tests; here are the numbers they printed:
--
--   ① ADDING LINES UNDER A DOCUMENT PROMISE IS AN INVISIBLE DISCOUNT
--      add a ฿7,395.84 line → set grand_total to ฿7,495.84 (an *uplift* of ฿100, so nothing is
--      conceded and no ceiling is consulted) → add a second line worth ฿55,296.
--      untouched document ฿66,562.56 · what the customer is billed ฿7,495.84 · conceded 88.7% ·
--      measured by the submit gate ฿0.00 · approvals required: none.
--      The `grand_total` override is absolute, so the document simply stops moving; its stored
--      baseline is the total at the instant it was written and nothing maintained it afterwards.
--
--   ② A QUOTE WITH NO LINES AND A PRICE
--      the same override, then remove the only line. `lines: []`, grand ฿14,291.68, VAT ฿934.97
--      on ฿0.00 of goods, and the submit gate says it is fine. (`quote_lines_guard_write()`
--      looks for a live override *on the line being removed*; a `grand_total` override has
--      `quote_line_id = NULL` and hangs off none of them.)
--
--   ③ THE ORDERING INVARIANT IN concession.ts WAS A COMMENT, NOT A RULE
--      that file states — and depends on — `computed_thb_minor` on a `grand_total` row being the
--      total *after* the line overrides. Nothing constrained the order of the two writes. Write
--      the grand override first and the measurement over-counts by ฿1,070; write it first,
--      then revoke the line override underneath it, and it **under**-counts by ฿1,070, which is
--      the fail-open direction and is what the submit gate reads.
--
--   ④ FLIPPING `is_vat_applicable` MOVES ฿897.68 OF THE CUSTOMER'S MONEY WITH NO RECORD
--      the frozen-inputs list in 0016 names qty, selections, measures, sku_code, config_hash,
--      computed_total, charge_total and removed_at — and not `is_vat_applicable`. So the one
--      field on the line that changes the grand total by 7% was editable underneath a live
--      promise, through the route whose whole job is prose the customer reads.
--
-- ── THE RULE, IN ONE SENTENCE ────────────────────────────────────────────────────
--
--   **A live `grand_total` override freezes the document it was taken against**: no line may be
--   added, removed or repriced, no line's taxability may move, and no line-level promise may be
--   written or withdrawn, until the document promise is superseded or revoked.
--
-- It is the same sentence as 0016's, one subject up, and the recovery is the same one: withdraw
-- the promise — with a name, a timestamp and a reason on it — and then edit. That is one
-- deliberate act instead of one silent loss, and it is the direction that fails closed.
--
-- ── WHY NOT "RECOMPUTE THE BASELINE AND COMPARE" INSTEAD ─────────────────────────
--
-- Because a comparison is arithmetic, and the arithmetic is VAT-aware, per-line taxable/exempt,
-- and lives in `applyOverrides`. A trigger that reimplemented it would be a second definition of
-- the document total inside plpgsql — plan 7.13's opening finding, in the migration that exists
-- to close plan 7.13's opening finding. What a trigger *can* state without arithmetic is the
-- structural fact that makes the comparison unnecessary: while the promise is live, the inputs
-- do not move. The API re-verifies the figure as well (`verifyBaselines` now checks the document
-- anchor), so the arithmetic check exists — it is just not written twice, and not in SQL.


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — TWO ADDITIONS TO THE LINE GUARD
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ⓵ `is_vat_applicable` joins the frozen list. It is a repricing input: `applyOverrides` splits
--    the lines into a taxable and an exempt subtotal and takes the tax once over the first, so
--    moving this column moves the grand total by the whole of the line's VAT.
--
--    It is NOT frozen in general — plan 7.9(ค) puts per-line taxability in the "editable" box
--    and it stays there. What is refused is moving it on a line that carries a live promise,
--    which is the same rule the other seven columns already obey.
--
-- ⓶ ⭐ THE DELETE BRANCH LEARNS ABOUT PROMISES — and this is a real hole, not a tidy-up.
--    The branch asked only about `submitted_at`, so on a *draft* the line was DELETEd, and
--    `quote_overrides_line_fk` is `ON DELETE CASCADE`: the promise went with the line, silently.
--    Plan 7.9(ง)(2)'s exact failure arriving through DELETE instead of UPDATE. The 5c API
--    refused it in every status and said out loud that the database did not; now both do, and
--    the API's refusal is the sentence rather than the guard.
CREATE OR REPLACE FUNCTION quote_lines_guard_write() RETURNS trigger AS $$
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

    IF FOUND THEN
      SELECT o.id INTO promised
        FROM quote_overrides o
       WHERE o.quote_line_id = OLD.id
         AND o.anchor = 'line_total'
         AND o.superseded_at IS NULL
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'quote line % carries live override %; deleting it would drop a promise silently',
          OLD.id, promised
          USING ERRCODE = 'restrict_violation',
                HINT = 'supersede the override first — revoked — then remove the line (plan 7.9(ง)(2))';
      END IF;
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
     OR NEW.is_vat_applicable        IS DISTINCT FROM OLD.is_vat_applicable
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


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — A LIVE DOCUMENT PROMISE FREEZES THE DOCUMENT
-- ═════════════════════════════════════════════════════════════════════════════

-- `true` when this order carries a live `grand_total` promise.
--
-- One function rather than the same three-line SELECT in two triggers, because the predicate
-- *is* the rule and a second spelling of it is a second rule. `quote_overrides_one_active_per_document`
-- makes it at most one row.
CREATE FUNCTION quote_document_promise(p_order_id uuid) RETURNS uuid AS $$
  SELECT o.id
    FROM quote_overrides o
   WHERE o.order_id = p_order_id
     AND o.anchor = 'grand_total'
     AND o.superseded_at IS NULL
   LIMIT 1;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- The line side.
--
-- INSERT and DELETE are refused outright: both change the set of things the document total was
-- promised over, and neither has a "did anything relevant move?" question to ask.
--
-- UPDATE is refused only when something the total depends on moved. Editing
-- `customer_description_th` under a document promise is fine and must stay fine — it is the one
-- field plan 7.9(ค) makes freely editable precisely because it reaches nothing but the customer's
-- eyes. `updated_at` moves on every write and is not in the list for the same reason
-- `quoteRevision` excludes it: a guard that fired on a timestamp would fire on nothing.
CREATE FUNCTION quote_lines_document_freeze() RETURNS trigger AS $$
DECLARE
  parent    orders%ROWTYPE;
  promised  uuid;
  order_id  uuid;
  line_id   uuid;
BEGIN
  -- OLD and NEW are picked apart with explicit branches rather than
  -- `CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END`, because plpgsql raises
  -- "record old is not assigned yet" the moment an INSERT trigger touches OLD at all —
  -- SQL's AND does not promise to short-circuit, so a single guarded expression is not safe.
  IF TG_OP = 'DELETE' THEN
    order_id := OLD.order_id;
    line_id  := OLD.id;
  ELSE
    order_id := NEW.order_id;
    line_id  := NEW.id;
  END IF;

  -- The order is already gone in this transaction: a draft cart being deleted whole, which
  -- `orders_block_delete()` has already decided is legal. Same idiom as the branch above.
  SELECT * INTO parent FROM orders WHERE id = order_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.qty                      IS NOT DISTINCT FROM OLD.qty
       AND NEW.selections           IS NOT DISTINCT FROM OLD.selections
       AND NEW.measures             IS NOT DISTINCT FROM OLD.measures
       AND NEW.computed_total_thb_minor IS NOT DISTINCT FROM OLD.computed_total_thb_minor
       AND NEW.charge_total_thb_minor   IS NOT DISTINCT FROM OLD.charge_total_thb_minor
       AND NEW.is_vat_applicable    IS NOT DISTINCT FROM OLD.is_vat_applicable
       AND NEW.removed_at           IS NOT DISTINCT FROM OLD.removed_at
    THEN
      RETURN NEW;
    END IF;
  END IF;

  promised := quote_document_promise(order_id);

  IF promised IS NOT NULL THEN
    RAISE EXCEPTION 'order % carries live document override %; % on quote line % would move the total it was promised against',
      order_id, promised, lower(TG_OP), line_id
      USING ERRCODE = 'restrict_violation',
            HINT = 'supersede the grand_total override first — replaced, or revoked — then edit the lines';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quote_lines_document_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION quote_lines_document_freeze();
--> statement-breakpoint

-- The override side — the half that closes ③, the ordering invariant.
--
-- A `line_total` promise written *underneath* a live document promise makes the document
-- promise's stored baseline a figure from before it, which is the double-count `concession.ts`
-- says cannot happen. Withdrawing one from underneath does the reverse and under-counts, which
-- is the fail-open direction. Both are refused, so the invariant that file depends on —
-- "`computed_thb_minor` on a `grand_total` row is the total *after* the line overrides" — becomes
-- true by construction rather than by comment.
--
-- ⚠️ What is deliberately NOT refused, in either direction:
--
--   * superseding or revoking the **document** promise itself. That is the recovery, and a guard
--     that blocked it would be a promise nobody could ever withdraw.
--   * a `lead_time_days` override. It is a number of days, it is in neither dimension of
--     `approvals`, and it moves no money.
--   * writing a document promise while line promises are live. That is the *correct* order and
--     it is the order the API writes in; the baseline it records is the post-line-override total.
CREATE FUNCTION quote_overrides_document_freeze() RETURNS trigger AS $$
DECLARE
  anchor   text;
  order_id uuid;
  promised uuid;
  parent   orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    anchor   := OLD.anchor;
    order_id := OLD.order_id;
  ELSE
    anchor   := NEW.anchor;
    order_id := NEW.order_id;
  END IF;

  -- The order is already gone in this transaction: an abandoned draft cart being thrown away
  -- whole, which `orders_block_delete()` deliberately permits and `quote_overrides_guard_write()`
  -- deliberately lets cascade. Without this branch, a cart that happened to carry both a line
  -- promise and a document promise could never be deleted — the freeze would refuse its own
  -- cascade — and the funnel would accumulate drafts for ever. Same idiom as the line trigger
  -- above and as `order_events_append_only()`.
  SELECT * INTO parent FROM orders WHERE id = order_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF anchor = 'line_total' THEN
    promised := quote_document_promise(order_id);

    IF promised IS NOT NULL THEN
      RAISE EXCEPTION 'order % carries live document override %; a line-level promise cannot be % underneath it',
        order_id, promised,
        CASE TG_OP WHEN 'INSERT' THEN 'written' WHEN 'DELETE' THEN 'deleted' ELSE 'withdrawn' END
        USING ERRCODE = 'restrict_violation',
              HINT = 'the document total was promised over these line prices — supersede it first';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quote_overrides_document_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON quote_overrides
  FOR EACH ROW EXECUTE FUNCTION quote_overrides_document_freeze();
