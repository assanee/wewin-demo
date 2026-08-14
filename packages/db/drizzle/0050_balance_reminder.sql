-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ แจ้งเตือนยอดค้างชำระ — THE FIRST EVENT ON THE SPINE THAT MOVES NO STATUS AND
--    IS NOT A CONVERSATION ABOUT THE QUOTE.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Five rounds made the balance payable, visible, recordable and forgivable. Nothing asked the
-- customer for it. `balance_reminded` is that ask, recorded where every other thing worth
-- telling somebody about is recorded, because plan 10.1 makes the outbox a consumer of
-- `order_events` **and of nothing else**: a message sent from anywhere but a spine row is a
-- message with no audit trail, no coalescing and no dead queue.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓵ A NULL STATUS PAIR IS A DESIGNED-FOR CASE, NOT AN INVARIANT BEING BENT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified against the live database rather than taken on trust (`pg_get_constraintdef`, and
-- `pg_get_functiondef` for the guard):
--
--   `order_events.from_status` and `to_status` are both **nullable**, and
--   `order_events_status_pair_shape` reads
--
--       CASE WHEN to_status IS NULL THEN from_status IS NULL
--            WHEN from_status IS NULL THEN seq = 1
--            ELSE true END
--
--   — so a (NULL, NULL) pair is legal *by construction*, and has been since 0007.
--
-- Two things about that are worth stating exactly, because a brief written from the outside got
-- one of them slightly wrong and the difference decides how much of this migration is new:
--
--   ⚠️ **This is not the first event type designed for the null pair.** `order_events_guard_insert()`
--     already carries an allow-list of three — `quote_revised`, `change_requested`,
--     `change_resolved` — and `ORDER_EVENT_TYPES`' own comment in the schema says of them "three
--     of these are not status changes at all". So the *shape* is used, argued and guarded.
--
--   ⚠️ **No row in this database has ever used it.** All 8 (event_type, from, to) combinations
--     present carry a real transition. So this is the first null-pair row anybody will actually
--     read on a timeline, which is why the dashboard's spine renderer is part of this round.
--
-- The consequence for `order_status_transitions`: **nothing.** That table is keyed on
-- `(from_status, to_status)` and is consulted by the guard only in the branch below where both
-- are non-null. An event with no pair cannot find a row there and must not have one — a row with
-- a null key is not representable, and inventing a self-loop to hang one off would break
-- `order_status_transitions_no_self_loop`. That is the honest reading, and it leaves two rules
-- that table would otherwise have carried — **who may write this event** and **what its payload
-- must contain** — with nowhere to live. They live in the guard, below, which is exactly where
-- the same two rules live for a transition (`allowed_actor_kinds`, `required_payload_keys`);
-- what changes is where they are written down, not whether they are enforced.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ WHY THE EVENT TYPE IS NAMED FOR THE ASK AND NOT FOR THE SEND
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `balance_reminded`, not `balance_reminder_sent`. This row records that a member of staff
-- **asked** for the customer to be reminded, in the transaction that recorded it. Whether an
-- email left the building is a different fact, owned by a different table and knowable minutes
-- later: `notifications` (queued or suppressed, with a reason) and `notification_attempts` (the
-- evidence, per attempt, with the locale it was rendered in). An event type that claimed "sent"
-- would be a claim the spine is in no position to make — the fan-out runs in this transaction,
-- the SMTP conversation does not — and it would be a *false* claim for every order with no
-- contact channel, where the fan-out writes a suppressed row on purpose.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓷ WHAT THIS MIGRATION DOES NOT DO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ⛔ No due-date column, and no scheduled job. There is no due date anywhere in this schema, so
--    nothing can be "overdue"; asked when the business collects the balance the owner answered
--    *"แล้วแต่งาน ไม่ตายตัว"*. A trigger that fired on a rule nobody agreed to is how a customer
--    learns to ignore the messages that matter. The event is written by a person pressing a
--    button on the order — `POST /orders/:orderId/balance-reminders`.
--
-- ⛔ No money is computed, stored or compared here. The amount in the payload is
--    `order_outstanding_thb_minor()`'s answer, computed by Postgres in the same transaction and
--    carried as a bare digit string exactly as `slip_amount_thb_minor` is; the amount in the
--    *message* is computed by Postgres again at send time, in the claim query, because the
--    balance can move between the ask and the delivery.
--
-- ⛔ Nothing existing is weakened. `order_events_guard_insert()` is replaced with a body that
--    differs from the live one by the two additions described at ⓸ and in no other character;
--    every branch it had, it still has.

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓸ THE FOURTEENTH EVENT TYPE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two CHECKs name the closed set — `order_events` and `notification_rules` — and both are `text`
-- + CHECK rather than an enum for the reason `order.ts` gives: `ALTER TYPE … ADD VALUE` cannot be
-- rolled back, and this project has grown the list after being told it was final. Dropping and
-- re-adding a CHECK is a reversible migration.
--
-- ⚠️ `order_status_transitions` has no such constraint (verified: no CHECK on that table mentions
-- an event type; the column is constrained by the rows that exist and by the FK-less join the
-- guard performs), so there is no third one to widen.
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_known";
--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_known" CHECK (
  "order_events"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded'
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
    'balance_reminded'
  )
);
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓹ THE GUARD — THE TWO RULES `order_status_transitions` CANNOT HOLD FOR THIS EVENT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replaced whole, because a plpgsql function has no ALTER. The diff against the live body is:
--
--   ⓵ `balance_reminded` joins the null-pair allow-list. Without this the existing branch raises
--     *"balance_reminded is a status change and must name a to_status"*, which is the guard doing
--     its job — an event type added by migration and not thought about would otherwise arrive on
--     the spine with a null pair and no rules at all.
--
--   ⓶ a branch of its own, carrying the two things a transition row carries for every other event
--     and cannot carry for this one:
--
--       **the actor.** `allowed_actor_kinds` on a transition; here, `staff` and nothing else. The
--       ask for money is the company's, taken by a person the company employs. A `customer` or
--       `guest` actor would be an order asking itself for money — the owner's own account
--       triggering a chase to the owner's own address — and `system` is the actor kind for
--       something a scheduler did, which is precisely the automation ⓷ refuses to build. Refusing
--       it here is what stops that automation being added later by a caller instead of by a
--       decision.
--
--       **the payload.** `required_payload_keys` on a transition; here, `outstanding_thb_minor`.
--       The whole content of this event is *how much was owed when we asked*, and a row without
--       it is a reminder nobody can audit: the balance moves, so next month's reader cannot
--       reconstruct the figure from the order. A caller that forgot it, or a zod schema that
--       stripped it, fails the INSERT rather than writing a fact with its content missing.
--       ⚠️ The value is not validated here beyond presence — same as `?&` does for a transition.
--
-- ⚠️ Everything else in this function is character-identical to the body that was live before this
-- migration, including the two ownership checks, the `seq` assignment, the genesis branch and the
-- five refusals in the transition branch.
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
    IF NEW.event_type NOT IN ('quote_revised', 'change_requested', 'change_resolved', 'balance_reminded') THEN
      RAISE EXCEPTION '% is a status change and must name a to_status', NEW.event_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- ⭐ The two rules `order_status_transitions` holds for every other event and cannot hold
    -- for one with no status pair. See ⓹ in this migration's header.
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

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓺ WHO HEARS ABOUT IT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One row. `event-coverage.ts` and `rules-coverage.pg.test.ts` are what make adding an event type
-- without answering this question **fail a test rather than ship a silence**, and this is the
-- answer: the customer, by email, in the language they read now.
--
-- ⚠️ **Not `sales_queue` as well.** The internal queue exists so that nobody has to notice
-- something on their own — an objection arriving, a bounce from the factory. A reminder was sent
-- by a member of staff who was looking at the order at the time; telling the sales queue about it
-- is telling somebody a thing they just did. The spine row is the record, and it is on the screen
-- they pressed the button on.
--
-- ⚠️ **Not coalesced** — `coalesce_group` NULL, `coalesce_seconds` 0 — and that is a decision, not
-- an omission. Plan 10.5(2) folds by *meaning*: five quote edits in ten minutes are one
-- conversation, five deliveries are five deliveries. Every reminder is a separate deliberate act
-- by a person, so folding two of them would silently discard one somebody chose to send. The
-- protection against a button pressed twice is a **refusal at the ask** with a sentence
-- (`BalanceReminderService`, and the cooldown it enforces), which tells the person what happened
-- — where coalescing would have accepted the press and quietly sent nothing.
--
-- ⚠️ `email` only, like every other rule. LINE is a legal channel with no address book yet; the
-- coverage test asserts the whole table is email, so enabling it stays a deliberate change.
INSERT INTO notification_rules
  (event_type, recipient_kind, channel, template_key, coalesce_group, coalesce_seconds)
VALUES
  ('balance_reminded', 'customer', 'email', 'order.balance_reminded.customer', NULL, 0);
