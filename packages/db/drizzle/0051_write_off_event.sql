-- ═════════════════════════════════════════════════════════════════════════════
-- 0051 — a forgiven debt appears on the order's timeline
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WW-1044 had ฿9,886.80 written off on 15 ส.ค. and its timeline still ended at
-- `installation_scheduled` from the day before. Every other movement of money on an order
-- leaves a row here — the slip, the confirmation, the reminder — and the one movement that
-- makes a balance vanish left nothing at all. Somebody reading that order six months later
-- would find a total that no longer matches what was collected and no row saying why.
--
-- ⓵ `balance_written_off` joins `ORDER_EVENT_TYPES`, so both CHECKs are dropped and re-added
--    with fifteen values. Text + CHECK rather than a PG enum, for 0050's reason: `ALTER TYPE …
--    ADD VALUE` cannot be rolled back, and this list has grown after being called final twice.
--
-- ⓶ It carries **no status change**. An approved write-off does not move an order out of
--    `awaiting_installation` — the work is still to be delivered, only the debt is gone — so it
--    joins the allow-list of types permitted a NULL status pair. `balance_reminded` opened that
--    door in 0050; this is the second through it, which is why the list is now worth reading as
--    a list rather than as an exception.
--
-- ⓷ Two guards, mirroring 0050's for `balance_reminded`:
--      · staff-only. A customer cannot forgive their own debt, and the two-person rule that
--        governs the approval lives in `approvals`, not here — but an event whose actor_kind is
--        `customer` would make the timeline say they did.
--      · `written_off_thb_minor` must be present. A row saying a debt was forgiven without
--        saying how much is worse than no row: it looks like a complete record.
--
-- ⚠️ The payload key is `written_off_thb_minor`, not `outstanding_thb_minor`. On
--    `balance_reminded` the latter means *what was still owed when we asked*; here the number
--    that matters is *what the company gave up*. They differ whenever a write-off is partial,
--    and one key carrying both meanings is how a reader ends up comparing two figures that were
--    never the same quantity.
--
-- ⓸ No `notification_rules` row. `rules-coverage.pg.test.ts` demands either a rule or a written
--    reason; the reason is in `apps/api/src/notifications/event-coverage.ts` and it names the
--    owner's open question rather than pretending the silence is settled.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_known";
--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_known" CHECK (
  "order_events"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded', 'balance_written_off'
  )
);
--> statement-breakpoint

ALTER TABLE "notification_rules" DROP CONSTRAINT "notification_rules_event_type_known";
--> statement-breakpoint

ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_event_type_known" CHECK (
  "notification_rules"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded', 'balance_written_off'
  )
);
--> statement-breakpoint

-- ⚠️ Replaced whole, because plpgsql has no ALTER. Everything here is character-identical to the
-- body 0050 left live except the two marked places: `balance_written_off` in the NULL-status
-- allow-list, and its own guard branch beside `balance_reminded`'s.
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
    IF NEW.event_type NOT IN ('quote_revised', 'change_requested', 'change_resolved', 'balance_reminded', 'balance_written_off') THEN
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
