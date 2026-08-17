-- ═════════════════════════════════════════════════════════════════════════════
-- A DOCUMENT IS ISSUED AND THE ORDER'S TIMELINE SAYS SO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `tax_documents.created_by_event_id` is NOT NULL: every document names the fact that caused it.
-- Which fact? Two answers were available.
--
--   ⓐ Cite the business event — a document made at payment cites `payment_confirmed`, one made
--      at delivery cites `delivered`. Strong provenance, no new event types, and nothing on the
--      timeline. An on-demand invoice, caused by a customer telephoning to ask for one, has no
--      business event to cite at all.
--
--   ⓑ Every issue writes its own event. Uniform, and the timeline shows it.
--
-- ⓑ, because of 0051's lesson, which cost a commit to learn: a debt was forgiven and the order's
-- history said nothing about it. A numbered document filed with the Revenue Department is not a
-- smaller fact than that. If somebody asks in eighteen months why TAX-2569-00042 exists, the
-- answer should be on the order, next to everything else that happened to it, and not require
-- joining a table they do not know about.
--
-- ⚠️ These are the sixth and seventh members of the no-status-change list in
-- `order_events_guard_insert()`, and that list is hand-maintained — the dominant bug class in
-- this schema. It is spelled out here rather than derived because a derived list would need a
-- table, and a table of event types that only this function reads is a table nobody maintains
-- either. The tests in `tax-documents.pg.test.ts` are what actually hold it.

-- ⓵ ────────────────────────────────────────────────────────────────────────────
-- The guard, restated whole: `CREATE OR REPLACE` on a plpgsql function has no way to add one
-- line, so the body is the unit of change. Everything except the two marked blocks is 0051's
-- text, copied from the installed function rather than retyped — retyping it once already
-- tightened `parent.status NOT IN (from, to)` into an equality by accident, which would have
-- refused every write that updates the order row before inserting its event.
CREATE OR REPLACE FUNCTION order_events_guard_insert() RETURNS trigger AS $$
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
    -- ⓶ `balance_written_off` added by 0051.
    -- ⓒ `tax_document_issued` and `tax_document_voided` added by 0062.
    IF NEW.event_type NOT IN (
      'quote_revised', 'change_requested', 'change_resolved', 'balance_reminded',
      'balance_written_off', 'tax_document_issued', 'tax_document_voided'
    ) THEN
      RAISE EXCEPTION '% is a status change and must name a to_status', NEW.event_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- ⭐ The two rules `order_status_transitions` holds for every other event and cannot hold
    -- for one with no status pair. See ⓹ in 0050's header.
    IF NEW.event_type = 'balance_reminded' THEN
      IF NEW.actor_kind <> 'staff' THEN
        RAISE EXCEPTION 'a % may not ask a customer for the balance: balance_reminded is staff-initiated', NEW.actor_kind
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF NOT (NEW.payload ? 'outstanding_thb_minor') THEN
        RAISE EXCEPTION 'balance_reminded requires outstanding_thb_minor in its payload'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;

    -- ⓷ 0051. The same two rules, for the same reason, on the row that forgives a debt.
    IF NEW.event_type = 'balance_written_off' THEN
      IF NEW.actor_kind <> 'staff' THEN
        RAISE EXCEPTION 'a % may not forgive a balance: balance_written_off is decided by staff', NEW.actor_kind
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF NOT (NEW.payload ? 'written_off_thb_minor') THEN
        RAISE EXCEPTION 'balance_written_off requires written_off_thb_minor in its payload'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;

    -- ⓓ 0062. A numbered document is issued, or struck out.
    --
    -- ⚠️ `system` stands beside `staff` here, unlike the two rules above, and the difference is
    -- real: forgiving a debt is somebody's decision, whereas issuing at the moment money arrives
    -- is the company's standing policy executing itself. The customer and the guest are absent
    -- from both lists — a buyer cannot mint a tax document by asking for one.
    IF NEW.event_type IN ('tax_document_issued', 'tax_document_voided') THEN
      IF NEW.actor_kind NOT IN ('staff', 'system') THEN
        RAISE EXCEPTION 'a % may not issue or void a tax document', NEW.actor_kind
          USING ERRCODE = 'restrict_violation';
      END IF;

      -- The number, so the timeline reads without joining `tax_documents`, and the kind, so it
      -- reads without knowing what the prefix means.
      SELECT array_agg(required_key) INTO missing
        FROM unnest(ARRAY['document_no', 'document_kind']) AS required_key
       WHERE NOT (NEW.payload ? required_key);

      IF missing IS NOT NULL THEN
        RAISE EXCEPTION '% requires % in its payload', NEW.event_type, missing
          USING ERRCODE = 'restrict_violation';
      END IF;

      -- ⛔ A void says why. An unexplained strike-through on a numbered series is precisely
      -- what an auditor asks about, and "nobody wrote it down" is not an answer to have to give.
      IF NEW.event_type = 'tax_document_voided' AND NOT (NEW.payload ? 'reason_th') THEN
        RAISE EXCEPTION 'tax_document_voided requires reason_th in its payload'
          USING ERRCODE = 'restrict_violation';
      END IF;
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

-- ⓶ ────────────────────────────────────────────────────────────────────────────
-- THE SECOND LIST.
--
-- ⚠️ `order_events_type_known` is a CHECK on the table and holds the same enumeration a second
-- time. Adding the two types to the guard alone left every write refused by the CHECK — found
-- by the tests, which is the only reason this section exists and the clearest evidence yet for
-- what 0050 already said about hand-maintained lists.
--
-- They are not merged, and deliberately: the CHECK is what still holds when somebody disables
-- triggers (`seed` and two test files do exactly that), and the guard is what knows about
-- actors and payloads, which no CHECK can see. Two lists, two jobs — and a test that walks both.
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_known";
--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_known" CHECK (
  "order_events"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'quotation_confirmed',
    'quotation_reopened', 'production_authorised_unpaid', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded', 'balance_written_off',
    -- 0062.
    'tax_document_issued', 'tax_document_voided'
  )
);
