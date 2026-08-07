-- ═════════════════════════════════════════════════════════════════════════════
-- 0024 — THE AUDIT TRAIL'S GUARDS
--
-- Two rules. The first is what makes the table evidence; the second is what makes keeping
-- it through an erasure defensible.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ RULE 1 — APPEND-ONLY, LIKE EVERY OTHER SPINE HERE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No UPDATE, no DELETE, ever. `order_events`, `ledger_entries` and `notification_attempts`
-- are all enforced this way and for the same reason: a record that can be edited is not a
-- record, it is a table somebody will eventually tidy — usually the person with the most
-- reason to.
--
-- ⚠️ There is deliberately no exception for erasure, and that is the difference from
-- `mfa_recovery_codes`. A spent recovery code is data *about a person* and erasure destroys
-- it; an audit row is the record that *the company acted*, which is the company's own
-- history and is what `user_erasure_requests` already argues for itself. See
-- `ERASURE_TREATMENTS`: both user columns are `keep`.
CREATE FUNCTION admin_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_events is append-only; an administrative act cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER admin_events_append_only
  BEFORE UPDATE OR DELETE ON admin_events
  FOR EACH ROW EXECUTE FUNCTION admin_events_append_only();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ RULE 2 — THE PAYLOAD HOLDS NO ADDRESS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- These rows survive erasure. That is only defensible while the row holds a uuid pointing at
-- a scrubbed tombstone, a group code, and a list of permission codes — nothing that is
-- *about* the person rather than about the act.
--
-- ⚠️ The obvious call site is the one that gets this wrong. `users.service.ts` logs
-- `created ${userId} (${email})`, and an audit row written to match would put an address in
-- the one table PDPA deliberately cannot reach. The address belongs in `user_emails`, which
-- erasure deletes.
--
-- A CHECK and not a convention, because a convention is a thing the fourteenth call site has
-- never read. It looks for an `@` inside any string value in the payload — crude, and it
-- catches the mistake that actually happens, which is somebody interpolating the identifier
-- they had to hand.
CREATE FUNCTION admin_events_payload_is_impersonal() RETURNS trigger AS $$
DECLARE
  offending text;
BEGIN
  SELECT value INTO offending
    FROM jsonb_each_text(NEW.payload)
   WHERE value LIKE '%@%'
   LIMIT 1;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'admin_events.payload looks like it contains an address (%); these rows outlive an erasure, so they carry ids and codes only',
      left(offending, 40)
      USING ERRCODE = 'check_violation';
  END IF;

  -- Nested arrays of strings — `permissions: [...]`, `groups: [...]` — are the other shape
  -- a call site reaches for, and `jsonb_each_text` renders them as one JSON string, so the
  -- scan above already covers them. Asserted by test rather than by a second query.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER admin_events_payload_is_impersonal
  BEFORE INSERT ON admin_events
  FOR EACH ROW EXECUTE FUNCTION admin_events_payload_is_impersonal();
--> statement-breakpoint
