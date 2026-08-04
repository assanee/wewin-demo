-- The order rules that are not tables: two foreign keys, one sequence, eleven triggers and
-- the reference data three of them read.
--
-- Same arrangement as drizzle/0001_catalog_freeze.sql and drizzle/0003_auth_guards.sql.
-- Drizzle generates tables, constraints and indexes from src/schema; it does not generate
-- triggers, functions, deferrable foreign keys or seed rows, so this file is written by
-- hand and applied by the same `drizzle-kit migrate` in the same order. It is a migration,
-- not a runbook step somebody has to remember.
--
-- Everything here exists because it is a rule two concurrent requests could otherwise both
-- step over, or one request could forget. Plan 7.4 names seven traps; six of them are
-- closed in this file (the seventh is money, and lands with the ledger in 5b — what is
-- closed here is that a superseded order cannot be left with nowhere to carry its money).


-- ─────────────────────────────────────────────────────────────────────────────
-- THE FREEZE POINT, AS SOMETHING POSTGRES CAN SEE
--
-- Plan 7.5(ข): the freeze point is entry to `production_confirmed`. Deposits changed the
-- *condition* that opens it, not its location.
--
-- This function is the single definition of "past the freeze". `src/schema/order.ts`
-- mirrors it as `POST_FREEZE_STATUSES` for callers, and tests/order.test.ts asks the
-- database about all nine statuses and fails if the two ever disagree — the same drift
-- test tests/enums.test.ts runs for the catalogue's unions.
--
-- IMMUTABLE so it can be used in a CHECK constraint at all. It reads no table by
-- construction: a freeze rule that could be edited by an UPDATE somewhere else would make
-- every row that passed the check yesterday questionable today.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_status_is_post_freeze(p_status text) RETURNS boolean AS $$
  SELECT p_status IN (
    'production_confirmed',
    'in_production',
    'awaiting_installation',
    'delivered',
    'redesign'
  );
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

-- A post-freeze status with no freeze stamp is an order whose own history denies where it
-- is. This is also what makes `redesign` structurally different from `draft` (plan 7.1):
-- one cannot exist without a freeze, the other cannot exist with one.
ALTER TABLE orders
  ADD CONSTRAINT orders_post_freeze_requires_frozen_at
  CHECK (NOT order_status_is_post_freeze(status) OR frozen_at IS NOT NULL);
--> statement-breakpoint

-- Trap 4, in the reference data itself: a cancellation *from* a frozen status is the one
-- that carries `fault`, and a row that claimed otherwise would hand the API the pre-freeze
-- payload schema for a post-freeze cancellation — which is the trap, exactly.
ALTER TABLE order_status_transitions
  ADD CONSTRAINT order_status_transitions_cancel_payload_matches_freeze
  CHECK (
    event_type <> 'cancelled'
    OR payload_kind = CASE
         WHEN order_status_is_post_freeze(from_status) THEN 'cancel_post_freeze'
         ELSE 'cancel_pre_freeze'
       END
  );
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⓵ TRAP 1 — THE CIRCULAR FOREIGN KEY, AND WHICH SIDE GIVES
--
--   orders.status_event_id  → order_events.id     NOT NULL
--   order_events.order_id   → orders.id           NOT NULL
--
-- Both immediate, and an order cannot be inserted at all: the event needs the order and
-- the order needs the event.
--
-- ⚠️ THE ORDER SIDE GIVES, AND IT GIVES DEFERRABILITY — NOT NULLABILITY. ⚠️
--
-- A nullable `status_event_id` would buy the insert and charge every reader forever: every
-- query that wants "which event put this order here" would carry a null case that never
-- happens but cannot be ruled out. Deferring costs one thing instead — the caller must
-- choose the event's id before inserting either row — and buys the invariant outright.
--
-- The sequence that works, inside one transaction:
--
--   1. INSERT INTO orders (…, status_event_id) VALUES (…, $eventId)
--   2. INSERT INTO order_events (id, order_id, …) VALUES ($eventId, $orderId, …)
--   3. COMMIT                                   -- this FK is checked here, and only here
--
-- Step 1 on its own — in autocommit, or without step 2 — fails at commit, which is the
-- proof that the cycle was real rather than avoided.
--
-- The constraint is also COMPOSITE, and that is not decoration. `(status_event_id, id,
-- status)` referencing `order_events (id, order_id, to_status)` makes three things true at
-- once and checkable by Postgres: the event exists, it belongs to *this* order, and the
-- status the order claims is the status that event moved it to. It is the same technique
-- catalog.ts uses to stop a denormalised `kind` drifting from its parent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders
  ADD CONSTRAINT orders_status_event_fk
  FOREIGN KEY (status_event_id, id, status)
  REFERENCES order_events (id, order_id, to_status)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- The other forward-pointing key, added here for a different reason: drizzle cannot order
-- two tables that reference each other, and this one closes the loop
-- orders → order_documents → orders. Composite for the same reason as above — a document
-- of a *different* order must not be attachable as this one's contract.
ALTER TABLE orders
  ADD CONSTRAINT orders_document_fk
  FOREIGN KEY (document_id, id)
  REFERENCES order_documents (id, order_id);
--> statement-breakpoint

-- The customer-facing number, minted at submit and never for a cart. See orders.order_no.
CREATE SEQUENCE order_no_seq AS bigint START WITH 1000 INCREMENT BY 1;
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- THE LEGAL MOVES — plan 7.1, 7.2, 7.3, 7.8
--
-- Sixteen rows. Six of them are cancellations, in two payload kinds split exactly at the
-- freeze (trap 4), and `redesign` is among the statuses one can be cancelled from, which
-- plan 7.8 marks as the one everybody forgets.
--
-- `superseded` is reachable only from `redesign`: a post-freeze change of mind is examined
-- before it becomes a new contract, and `redesign` is the state that says somebody is
-- examining it. If that turns out to be too strict, the fix is one INSERT in a migration —
-- which is the entire reason this is a table and the statuses are not a pg enum.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO order_status_transitions
  (from_status, to_status, event_type, payload_kind, required_payload_keys, allowed_actor_kinds, description_th)
VALUES
  -- Pre-freeze. A draft is a cart: the customer, or the guest they still are, may act on it.
  ('draft', 'awaiting_payment', 'submitted_for_payment', 'submit', '{}',
   '{customer,guest,staff}', 'ลูกค้ายืนยันใบเสนอราคาและส่งเข้ารอชำระเงิน — จุดที่ตรึงเอกสาร'),
  ('draft', 'cancelled', 'cancelled', 'cancel_pre_freeze', '{reason}',
   '{customer,guest,staff,system}', 'ทิ้งตะกร้าที่ยังไม่ได้ส่ง — ไม่มีสัญญา ไม่มีเงิน'),

  ('awaiting_payment', 'production_confirmed', 'payment_confirmed', 'confirm_payment', '{}',
   '{staff,system}', 'ยืนยันสลิปของงวดที่ถือประตู — จุด freeze'),
  ('awaiting_payment', 'cancelled', 'cancelled', 'cancel_pre_freeze', '{reason}',
   '{customer,guest,staff}', 'ยกเลิกก่อนเข้าผลิต — ยังไม่มีอะไรถูกตัด'),

  -- Post-freeze. Every cancellation from here carries `fault`, which decides the refund.
  ('production_confirmed', 'in_production', 'production_started', 'none', '{}',
   '{staff}', 'โรงงานเริ่มตัดอะลูมิเนียม'),
  ('production_confirmed', 'redesign', 'bounced_to_redesign', 'bounce', '{reason}',
   '{staff}', 'ฝ่ายผลิตตีกลับก่อนเริ่มตัด'),
  ('production_confirmed', 'cancelled', 'cancelled', 'cancel_post_freeze', '{reason,fault}',
   '{customer,guest,staff}', 'ยกเลิกหลัง freeze แต่ยังไม่ได้ตัด — ตารางการริบให้ 0'),

  ('in_production', 'awaiting_installation', 'installation_scheduled', 'none', '{}',
   '{staff}', 'ผลิตเสร็จ รอเข้าติดตั้ง'),
  ('in_production', 'redesign', 'bounced_to_redesign', 'bounce', '{reason}',
   '{staff}', 'ผลิตแล้วพบว่าแบบทำไม่ได้ — ตีกลับไปแก้แบบ'),
  ('in_production', 'cancelled', 'cancelled', 'cancel_post_freeze', '{reason,fault}',
   '{customer,guest,staff}', 'ยกเลิกระหว่างผลิต'),

  ('awaiting_installation', 'delivered', 'delivered', 'none', '{}',
   '{staff}', 'ติดตั้งและส่งมอบแล้ว'),
  ('awaiting_installation', 'redesign', 'bounced_to_redesign', 'bounce', '{reason}',
   '{staff}', 'หน้างานพบว่าติดตั้งไม่ได้ — ตีกลับไปแก้แบบ'),
  ('awaiting_installation', 'cancelled', 'cancelled', 'cancel_post_freeze', '{reason,fault}',
   '{customer,guest,staff}', 'ยกเลิกก่อนติดตั้ง'),

  -- `absorbed_delta_thb_minor` is required, not optional: plan 7.2 puts the guard at the
  -- scope and has the company absorb the price difference, and a cost of quality that is
  -- not written down is a cost of quality nobody ever sees.
  ('redesign', 'production_confirmed', 'redesign_approved', 'approve_redesign',
   '{absorbed_delta_thb_minor}', '{staff}',
   'แบบที่แก้แล้วผ่าน ขอบเขตเท่าเดิม บริษัทรับส่วนต่างไว้เอง'),
  ('redesign', 'superseded', 'superseded', 'supersede', '{reason}',
   '{staff}', 'ส่วนต่างใหญ่เกินรับไหว — ออกใบใหม่ให้ลูกค้าอนุมัติ ใบเดิมถูกแทนที่'),
  ('redesign', 'cancelled', 'cancelled', 'cancel_post_freeze', '{reason,fault}',
   '{customer,guest,staff}', 'ยกเลิกระหว่างแก้แบบ — plan 7.8 ย้ำว่าสถานะนี้ยกเลิกได้');
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- THE SPINE IS APPEND-ONLY
--
-- Same rule as a published catalogue document, for the same reason: `orders.status` is
-- derived from a row in here, notifications are produced from rows in here, and 5b's money
-- will be reconciled against rows in here. A spine that can be rewritten is not a spine.
--
-- UPDATE is refused outright — there is no column on an event that is state rather than
-- history. DELETE is refused unless the parent order is a never-submitted draft being
-- deleted, which is the one case where nothing of record is lost: an abandoned anonymous
-- cart is not an accounting document, and the funnel would otherwise accumulate forever.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_events_append_only() RETURNS trigger AS $$
DECLARE
  parent orders%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_events is append-only; event % of order % cannot be edited',
      OLD.id, OLD.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- DELETE. `NOT FOUND` means the order row is already gone in this transaction, i.e. this
  -- is the cascade from a delete that orders_block_delete() already allowed.
  SELECT * INTO parent FROM orders WHERE id = OLD.order_id;

  IF FOUND AND (parent.status <> 'draft' OR parent.submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'order % is %; its history cannot be deleted', parent.id, parent.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_append_only();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT AN EVENT HAS TO BE TRUE OF BEFORE IT IS WRITTEN
--
-- Four separate rules, in one BEFORE INSERT so they all see the same row:
--
--   `seq`         assigned here, never accepted. A caller that picked its own would
--                 eventually pick one twice, and `created_at` cannot break the tie —
--                 two events in one transaction share a `now()`. Under concurrency the
--                 UNIQUE (order_id, seq) is the arbiter: two appends to one order collide
--                 and one retries, which is why the transition path takes
--                 `SELECT … FOR UPDATE` on the order first.
--
--   legality      the (from, to) pair must be a row in order_status_transitions, and the
--                 event type must be the one that row names. Without the second half,
--                 routing drifts: the outbox picks its message by event type (plan 10.3),
--                 so a mislabelled event sends the wrong message about the right change.
--
--   payload       `required_payload_keys` must all be present. This is the backstop for
--                 trap 4 — a `fault` that zod stripped from a post-freeze cancellation
--                 fails here, on the write that did it, rather than defaulting quietly to
--                 somebody's benefit.
--
--   🔒 the actor  plan 7.4 trap 2. `actors: ['customer']` does not mean *this* customer.
--                 Ownership belongs in the query that loads the order — and this is the
--                 backstop for the day somebody writes that query without the WHERE
--                 clause: an event whose actor is not the order's own customer, or not the
--                 order's own guest, is refused by the database.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_events_guard_insert() RETURNS trigger AS $$
DECLARE
  parent     orders%ROWTYPE;
  transition order_status_transitions%ROWTYPE;
  missing    text[];
BEGIN
  SELECT * INTO parent FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.seq := coalesce((SELECT max(e.seq) FROM order_events e WHERE e.order_id = NEW.order_id), 0) + 1;

  -- 🔒 The actor is this order's actor, or there is no event.
  IF NEW.actor_kind = 'customer' AND NEW.actor_user_id IS DISTINCT FROM parent.customer_user_id THEN
    RAISE EXCEPTION 'user % does not own order %', NEW.actor_user_id, NEW.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.actor_kind = 'guest' AND NEW.actor_guest_id IS DISTINCT FROM parent.guest_id THEN
    RAISE EXCEPTION 'guest % does not own order %', NEW.actor_guest_id, NEW.order_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.to_status IS NULL THEN
    -- Not a status change. On the spine because plan 10.1 makes notifications a consumer
    -- of this table and of nothing else, so anything worth telling somebody about is here.
    IF NEW.event_type NOT IN ('quote_revised', 'change_requested', 'change_resolved') THEN
      RAISE EXCEPTION '% is a status change and must name a to_status', NEW.event_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.from_status IS NULL THEN
    -- Genesis. Every order's history starts in `draft`, so the spine is complete from the
    -- first row and "has this order ever been in X" is answerable without a caveat.
    IF NEW.event_type <> 'created' OR NEW.to_status <> 'draft' OR NEW.seq <> 1 THEN
      RAISE EXCEPTION 'the first event of an order must be created → draft, not % → %',
        NEW.event_type, NEW.to_status
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  SELECT * INTO transition
    FROM order_status_transitions t
   WHERE t.from_status = NEW.from_status AND t.to_status = NEW.to_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION '% → % is not a legal transition', NEW.from_status, NEW.to_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.event_type <> transition.event_type THEN
    RAISE EXCEPTION '% → % is recorded as %, not as %',
      NEW.from_status, NEW.to_status, transition.event_type, NEW.event_type
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (NEW.actor_kind = ANY (transition.allowed_actor_kinds)) THEN
    RAISE EXCEPTION 'a % may not move an order from % to %',
      NEW.actor_kind, NEW.from_status, NEW.to_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT array_agg(required_key) INTO missing
    FROM unnest(transition.required_payload_keys) AS required_key
   WHERE NOT (NEW.payload ? required_key);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '% → % requires % in its payload',
      NEW.from_status, NEW.to_status, missing
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The event must be about the order as it is now or as it is about to be. Both writing
  -- the order first and writing the event first are legal (the status FK is deferred), so
  -- this accepts either and refuses an event fabricated for a transition nobody made.
  IF parent.status NOT IN (NEW.from_status, NEW.to_status) THEN
    RAISE EXCEPTION 'order % is %, so an event from % to % is not about its current state',
      parent.id, parent.status, NEW.from_status, NEW.to_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_events_guard_insert
  BEFORE INSERT ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_guard_insert();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- THE ORDER ROW ITSELF
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION orders_guard_insert() RETURNS trigger AS $$
DECLARE
  predecessor orders%ROWTYPE;
BEGIN
  -- Every order starts as a cart. A row inserted straight into `awaiting_payment` would
  -- have no `created` event, and every "has this order ever been in X" answer would then
  -- have to say "as far as the spine goes".
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'an order is created as a draft, not as %', NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.supersedes_order_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM orders WHERE id = NEW.supersedes_order_id FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order % does not exist', NEW.supersedes_order_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Superseding is the post-freeze revision mechanism (plan 7.2). Before the freeze the
    -- quote is edited in place, and a "revision" of a draft would just be a second cart.
    IF predecessor.frozen_at IS NULL THEN
      RAISE EXCEPTION 'order % was never frozen; a revision of it is an edit, not a new order',
        predecessor.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_guard_insert
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_insert();
--> statement-breakpoint

-- Everything an order is contracted on is written once. The columns guarded here are not
-- state, they are facts about the past: when it was submitted, when it froze, what number
-- it was given, which order it replaces, whose it is. A system that lets any of them be
-- rewritten cannot answer a dispute, because the answer would be whatever was written last.
CREATE FUNCTION orders_guard_update() RETURNS trigger AS $$
BEGIN
  -- ── write-once and immutable ────────────────────────────────────────────────
  IF NEW.supersedes_order_id IS DISTINCT FROM OLD.supersedes_order_id THEN
    -- Immutable rather than write-once, and the difference is a cycle: `A supersedes B`
    -- set later on a row that B already supersedes is the only way to build one, and a
    -- cycle would hang the ancestor walk 5b's money fold depends on (plan 7.8).
    RAISE EXCEPTION 'the order a revision replaces is fixed when the revision is created'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.guest_id IS DISTINCT FROM OLD.guest_id THEN
    RAISE EXCEPTION 'an order belongs to the visitor that created it'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Signing in claims the cart you already were (plan 6). Claiming it a second time, for
  -- somebody else, is how an order changes hands without anybody selling anything.
  IF OLD.customer_user_id IS NOT NULL AND NEW.customer_user_id IS DISTINCT FROM OLD.customer_user_id THEN
    RAISE EXCEPTION 'order % already belongs to user %', OLD.id, OLD.customer_user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'order % was submitted at % and cannot be re-submitted', OLD.id, OLD.submitted_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.order_no IS NOT NULL AND NEW.order_no IS DISTINCT FROM OLD.order_no THEN
    RAISE EXCEPTION 'order % is already numbered %', OLD.id, OLD.order_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── the freeze point, stamped by the database ──────────────────────────────
  -- Never by the caller: this is the fact the cancellation report reads long after the
  -- status has become `cancelled` and can no longer answer "had aluminium been committed?".
  IF NEW.status = 'production_confirmed' AND OLD.frozen_at IS NULL THEN
    NEW.frozen_at := now();
  END IF;

  -- A second entry into production_confirmed after a redesign does not re-stamp it. The
  -- order froze the first time, and that is the date the money rules are about.
  IF OLD.frozen_at IS NOT NULL AND NEW.frozen_at IS DISTINCT FROM OLD.frozen_at THEN
    RAISE EXCEPTION 'order % froze at % and cannot be re-frozen or thawed', OLD.id, OLD.frozen_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── the move itself ────────────────────────────────────────────────────────
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM order_status_transitions t
       WHERE t.from_status = OLD.status AND t.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'order % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- The spine is not optional. A status that moved without an event is a status change
    -- nobody can date, attribute, or notify anybody about — and the deferred composite FK
    -- would only catch it at COMMIT, several statements away from the cause.
    IF NEW.status_event_id IS NOT DISTINCT FROM OLD.status_event_id THEN
      RAISE EXCEPTION 'moving order % from % to % must be recorded by a new event',
        OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Plan 10.4: today a customer's only way to withhold consent is to not transfer money,
    -- which strands the order forever because there is no timeout. So an unanswered
    -- objection blocks the freeze. It cannot strand anything either — `rejected` is a
    -- resolution, and taking it is a decision with a name on it.
    IF NEW.status = 'production_confirmed' AND EXISTS (
      SELECT 1 FROM order_change_requests c
       WHERE c.order_id = OLD.id AND c.resolved_event_id IS NULL
    ) THEN
      RAISE EXCEPTION 'order % has an unanswered change request and cannot enter production', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- `superseded` exists so a post-freeze revision is not reported as lost business
    -- (plan 7.1). Without a successor it is a cancellation wearing a better word, and the
    -- money already received would have nowhere to be carried to (plan 7.8, trap 7).
    IF NEW.status = 'superseded' AND NOT EXISTS (
      SELECT 1 FROM orders o WHERE o.supersedes_order_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'order % cannot be superseded by nothing; create the revision first', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status_event_id IS DISTINCT FROM OLD.status_event_id THEN
    RAISE EXCEPTION 'the event that set the status of order % moves only when the status does', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_guard_update
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_update();
--> statement-breakpoint

-- One number, two places to read it — and therefore two answers, unless something forbids
-- it. `orders.grand_total_thb_minor` is the single base every instalment, forfeit and
-- refund references (plan 7.13); `order_documents` is what the customer was shown. They may
-- differ only in that a new revision produces both together.
CREATE FUNCTION orders_totals_match_document() RETURNS trigger AS $$
DECLARE
  pinned order_documents%ROWTYPE;
BEGIN
  IF NEW.document_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO pinned FROM order_documents WHERE id = NEW.document_id;

  -- Not found means the foreign key is about to say so, in better words than these.
  IF FOUND AND (
       NEW.net_thb_minor         IS DISTINCT FROM pinned.net_thb_minor
    OR NEW.vat_thb_minor         IS DISTINCT FROM pinned.vat_thb_minor
    OR NEW.grand_total_thb_minor IS DISTINCT FROM pinned.grand_total_thb_minor
  ) THEN
    RAISE EXCEPTION 'order % says % but its pinned document says %',
      NEW.id, NEW.grand_total_thb_minor, pinned.grand_total_thb_minor
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_totals_match_document
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_totals_match_document();
--> statement-breakpoint

-- An abandoned anonymous cart is not an accounting document and must be sweepable; a
-- submitted order is, and must not be. This is also what makes the erasure story tractable
-- while `orders.customer_user_id` is ON DELETE RESTRICT: an erasure routine can clear a
-- person's carts without anybody having answered plan 13's retention question first.
CREATE FUNCTION orders_block_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' OR OLD.submitted_at IS NOT NULL OR OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'order % is % and is a record, not a row', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_block_delete
  BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_block_delete();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⓶ TRAP 3 — THE PINNED DOCUMENT IS FROZEN
--
-- Plan 7.4 trap 3: nothing was pinned between submit and accept, so sales opening a slip
-- the next morning could build the contract from a catalogue document the customer never
-- saw. The pin is only worth having if it cannot be edited afterwards — an editable pin is
-- the same unprovable document with more columns.
--
-- Same rule and same shape as product_versions_freeze() in 0001_catalog_freeze.sql.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_documents_freeze() RETURNS trigger AS $$
DECLARE
  parent orders%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order document % is what the customer saw; a change is a new revision', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT * INTO parent FROM orders WHERE id = OLD.order_id;

  IF FOUND AND (parent.status <> 'draft' OR parent.submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'order % is %; the document it was contracted on cannot be deleted',
      parent.id, parent.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_documents_freeze
  BEFORE UPDATE OR DELETE ON order_documents
  FOR EACH ROW EXECUTE FUNCTION order_documents_freeze();
--> statement-breakpoint

-- A contract cites the catalogue as published, never as it was being edited. A draft
-- version is a document somebody is still changing, and pinning one would pin a moving
-- target — which is trap 3 again, one table further in.
CREATE FUNCTION order_document_versions_must_be_published() RETURNS trigger AS $$
DECLARE
  version_status product_version_status;
BEGIN
  SELECT status INTO version_status FROM product_versions WHERE id = NEW.product_version_id;

  IF version_status = 'draft' THEN
    RAISE EXCEPTION 'product version % is a draft and cannot be quoted from', NEW.product_version_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_document_versions_must_be_published
  BEFORE INSERT OR UPDATE ON order_document_product_versions
  FOR EACH ROW EXECUTE FUNCTION order_document_versions_must_be_published();
--> statement-breakpoint

-- ⚠️ `pnpm db:seed` runs `TRUNCATE categories, products, option_groups RESTART IDENTITY
-- CASCADE` (src/seed.ts). CASCADE walks foreign keys and does **not** respect ON DELETE
-- RESTRICT, so on a database with real contracts on it that command would empty this table
-- — every pinned document would keep its money and lose the record of which catalogue
-- version it was priced from, silently, with no anomaly for a referential check to find.
--
-- So the seed now stops instead, on a database that has contracts. Re-seeding the
-- catalogue underneath existing orders is not a thing to make convenient.
CREATE FUNCTION order_document_versions_block_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM order_document_product_versions) THEN
    RAISE EXCEPTION 'orders cite catalogue versions; truncating the catalogue would erase what they were priced from'
      USING ERRCODE = 'restrict_violation',
            HINT = 'seed a fresh database, or delete the orders first';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_document_versions_block_truncate
  BEFORE TRUNCATE ON order_document_product_versions
  FOR EACH STATEMENT EXECUTE FUNCTION order_document_versions_block_truncate();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⓷ TRAP 6 — A STATUS GUARD THAT FORBIDS THE WRITE, NOT ONE THAT ORDERS THE RACE
--
-- Plan 7.4 trap 6 is about slip upload, which belongs to 5b — but the mechanism is
-- general, and getting it wrong is not: `SELECT … FOR UPDATE` in the *transition* only
-- decides who goes first. It does not stop the loser writing a child row against an order
-- that has meanwhile moved on, because the child INSERT never looked at the order at all.
--
-- The guard has to be on the child, and it has to take a lock on the parent:
--
--   * the transition holds `FOR UPDATE` on the order until it commits;
--   * this trigger asks for `FOR SHARE` on the same row and therefore *blocks*;
--   * under READ COMMITTED it then re-reads the row as the winner left it, and refuses.
--
-- Without the lock it would read its own snapshot, taken before the transition committed,
-- pass, and insert. Ordering the race is not forbidding it.
--
-- The allowed statuses come from TG_ARGV so the same function serves every child table.
-- SEAM 5b: `slips` attaches here with `'{awaiting_payment}'` and gets this behaviour for
-- one line in a migration rather than a second copy of the reasoning.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_child_require_status() RETURNS trigger AS $$
DECLARE
  parent_id     uuid;
  parent_status text;
BEGIN
  EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO parent_id USING NEW;

  SELECT status INTO parent_status FROM orders WHERE id = parent_id FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT (parent_status = ANY (TG_ARGV[1]::text[])) THEN
    RAISE EXCEPTION '% cannot be written against order %, which is %',
      TG_TABLE_NAME, parent_id, parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ⓸ TRAP 5 — a change request with something that clears it.
--
-- The partial unique index `order_change_requests_one_open` is only half of the fix; on its
-- own it *is* the trap, because the first request would then block every later one for the
-- lifetime of the order. The resolution columns are the other half. Neither works alone,
-- and tests/order.test.ts asserts both halves in one test for exactly that reason.
--
-- A request may not be opened against an order nobody can act on any more. `delivered` is
-- excluded beside the two terminal statuses: after handover the conversation is a warranty
-- claim, which is a different process with a different queue.
CREATE TRIGGER order_change_requests_live_orders_only
  BEFORE INSERT ON order_change_requests
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_payment,production_confirmed,in_production,awaiting_installation,redesign}'
  );
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⓹ THE OUTBOX — plan 10.1
--
-- `order_events` is the append-only spine, so notifications are a CONSUMER of it: a row
-- written in the same transaction as the event, delivered later by a worker. Not
-- `sendEmail()` inside a transition handler, for the four reasons the plan lists — SMTP
-- being down must not roll back a state change or, worse, commit one with nobody told;
-- retries must exist; "what did we actually send them" must be answerable during a
-- dispute; and adding LINE must be one adapter rather than twenty call sites.
--
-- ⚠️ WHAT MAKES "SAME TRANSACTION" STRUCTURAL RATHER THAN A CONVENTION ⚠️
--
-- The fan-out below is a trigger on the spine, so appending the event is what queues the
-- messages: there is no call for a service to forget, and no rollback that can leave one
-- behind. `notifications_guard_insert()` closes the other direction — a row inserted by
-- anything other than a trigger, or against an event that committed in an earlier
-- transaction, is refused. Retrying is an UPDATE and an append to notification_attempts,
-- so the guard costs the worker nothing.
--
-- ⚠️ AND IT IS A *DEFERRED* CONSTRAINT TRIGGER, WHICH IS THE INTERESTING PART.
--
-- Firing at COMMIT rather than at INSERT does not weaken "same transaction" — it is still
-- the same transaction, and a rollback still takes the outbox rows with it. What it buys
-- is that the fan-out reads the order as the transaction *finally left it*. A submit
-- writes the event before it can write the order (the document references the event and
-- the order references the document, so the statements can only go in that order), and an
-- immediate trigger would therefore resolve the recipient from the pre-submit row — which
-- is how "who did we tell?" ends up depending on the order of statements inside a service.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_events_fan_out_notifications() RETURNS trigger AS $$
DECLARE
  parent   orders%ROWTYPE;
  rule     notification_rules%ROWTYPE;
  address  text;
  key      text;
  reason   text;
BEGIN
  SELECT * INTO parent FROM orders WHERE id = NEW.order_id;

  FOR rule IN
    SELECT * FROM notification_rules r
     WHERE r.event_type = NEW.event_type AND r.is_enabled
  LOOP
    key := NULL;
    reason := NULL;

    IF rule.recipient_kind = 'customer' THEN
      IF rule.channel = 'email' THEN
        -- A signed-in customer is reached at the address they proved (auth's
        -- `user_emails_primary_is_verified` guarantees a primary one is verified); a guest
        -- at the address they gave when they asked for the quote (plan 10.2).
        SELECT e.address INTO address
          FROM user_emails e
         WHERE e.user_id = parent.customer_user_id AND e.is_primary;

        address := coalesce(address, parent.contact_email);

        IF address IS NULL THEN
          reason := 'no_contact_channel';
        ELSE
          key := 'email:' || address;
        END IF;
      ELSE
        -- LINE is a legal channel with no address book yet (plan 13: email only until the
        -- owner answers). Suppressed *visibly* rather than skipped, because a message that
        -- was never queued is a message nobody can discover was never sent.
        reason := 'channel_disabled';
      END IF;
    ELSE
      key := 'group:' || rule.recipient_kind;
    END IF;

    INSERT INTO notifications (
      order_id, event_id, latest_event_id,
      recipient_kind, recipient_key, channel, template_key,
      status, suppressed_reason, coalesce_key, send_after
    )
    VALUES (
      NEW.order_id, NEW.id, NEW.id,
      rule.recipient_kind, key, rule.channel, rule.template_key,
      CASE WHEN reason IS NULL THEN 'pending' ELSE 'suppressed' END,
      reason,
      CASE WHEN reason IS NULL THEN rule.coalesce_group ELSE NULL END,
      now() + make_interval(secs => rule.coalesce_seconds)
    )
    -- Plan 10.5(2). `send_after` is deliberately NOT pushed back: the window starts at the
    -- first event of the storm, so five edits in ten minutes are one message ten minutes
    -- after the first — not a message that recedes for as long as somebody keeps typing.
    ON CONFLICT (order_id, coalesce_key, recipient_key, channel)
      WHERE status = 'pending' AND coalesce_key IS NOT NULL
    DO UPDATE SET
      latest_event_id = EXCLUDED.latest_event_id,
      coalesced_count = notifications.coalesced_count + 1,
      updated_at      = now();
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER order_events_fan_out_notifications
  AFTER INSERT ON order_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_events_fan_out_notifications();
--> statement-breakpoint

CREATE FUNCTION notifications_guard_insert() RETURNS trigger AS $$
DECLARE
  event_txid text;
BEGIN
  -- The transaction check runs FIRST, and the order is deliberate: it is the rule that
  -- makes the plan's sentence true ("written in the same transaction as the event"), and
  -- putting it first is what makes it separately observable — a hand-written row against
  -- an event that committed earlier fails *here*, not on the depth check below. Two rules,
  -- two messages, two tests that can each be made to fail on their own.
  SELECT write_txid INTO event_txid FROM order_events WHERE id = NEW.event_id;

  IF event_txid IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'event % was written by another transaction; an outbox row belongs to the transaction that caused it',
      NEW.event_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Depth 1 is a direct INSERT reaching its own trigger; the fan-out itself runs at depth
  -- 1, so the row it writes reaches this trigger at depth 2. Anything shallower is a
  -- service writing outbox rows by hand — which is `sendEmail()` in a transition handler
  -- wearing a table, and the thing plan 10.1 exists to prevent.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'notifications are produced by order_events, not written by hand'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER notifications_guard_insert
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_guard_insert();
--> statement-breakpoint

-- The attempt log is evidence, like the spine. `notifications.last_error` remembers only
-- the most recent failure; a dispute asks about all five.
CREATE FUNCTION notification_attempts_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'notification_attempts is append-only; attempt % is what happened', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER notification_attempts_append_only
  BEFORE UPDATE OR DELETE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION notification_attempts_append_only();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- WHO HEARS ABOUT WHAT — plan 10.3
--
-- ⚠️ THESE ARE PLAN 13 DEFAULTS, NOT DECISIONS. Email only — LINE is the channel Thai
-- customers actually read (plan 10.2), and it costs money per push and needs the customer
-- to add the account as a friend, neither of which anybody has agreed to. Coalescing is
-- ten minutes and the worker gives up after five attempts, both straight out of plan 13's
-- default column. Each of them changes with an UPDATE, not a migration.
--
-- An empty table would mean silence, which plan 13 warns about in its own right: a policy
-- table with no defined behaviour on day one is a feature that dies quietly.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO notification_rules
  (event_type, recipient_kind, channel, template_key, coalesce_group, coalesce_seconds)
VALUES
  ('submitted_for_payment', 'customer',    'email', 'order.submitted_for_payment.customer', NULL, 0),
  ('submitted_for_payment', 'sales_queue', 'email', 'order.submitted_for_payment.sales',    NULL, 0),

  -- 🔴 Plan 10.3's red line, and plan 10.4: the customer must be told when a quote they
  -- already agreed to changes, with a diff and a way to object. Coalesced, because sales
  -- editing five times in ten minutes is one conversation.
  ('quote_revised',         'customer',    'email', 'order.quote_revised.customer', 'quote_revised', 600),

  ('payment_confirmed',     'customer',    'email', 'order.payment_confirmed.customer',      NULL, 0),
  ('production_started',    'customer',    'email', 'order.production_started.customer',     NULL, 0),
  ('installation_scheduled','customer',    'email', 'order.installation_scheduled.customer', NULL, 0),
  ('delivered',             'customer',    'email', 'order.delivered.customer',              NULL, 0),

  ('bounced_to_redesign',   'customer',    'email', 'order.bounced_to_redesign.customer', NULL, 0),
  ('bounced_to_redesign',   'sales_queue', 'email', 'order.bounced_to_redesign.sales',    NULL, 0),
  ('redesign_approved',     'customer',    'email', 'order.redesign_approved.customer',   NULL, 0),

  ('cancelled',             'customer',    'email', 'order.cancelled.customer', NULL, 0),
  ('cancelled',             'sales_queue', 'email', 'order.cancelled.sales',    NULL, 0),
  ('superseded',            'customer',    'email', 'order.superseded.customer', NULL, 0),

  -- The objection has to land somewhere a person looks, or it is a button that does nothing.
  ('change_requested',      'sales_queue', 'email', 'order.change_requested.sales',   NULL, 0),
  ('change_resolved',       'customer',    'email', 'order.change_resolved.customer', NULL, 0);
