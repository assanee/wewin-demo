-- The auth rules that are not tables: triggers, and one function.
--
-- Same arrangement as drizzle/0001_catalog_freeze.sql. Drizzle generates tables,
-- constraints and indexes from src/schema; it does not generate triggers or functions,
-- so this file is written by hand and applied by the same `drizzle-kit migrate` in the
-- same order. It is a migration, not a runbook step somebody has to remember.
--
-- Everything here exists because it is a rule two concurrent requests could otherwise
-- both step over, or one request could forget. Plan section 6 names four of those and
-- three of them land in this file.

-- ─────────────────────────────────────────────────────────────────────────────
-- Consume-once.
--
-- An OAuth state, an email link and a refresh token are all single-use, and "single
-- use" has to be a property of the row rather than a promise made by the last service
-- that touched it. With `consumed_at` write-once, claiming one is a single UPDATE whose
-- WHERE clause *is* the mutual exclusion:
--
--     UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL
--
-- One caller gets a row, every other caller gets zero, and there is no read-then-write
-- for a second connection to interleave with. Rewriting `consumed_at` would turn that
-- into a lost update, so this refuses it.
--
-- Writing the same value again is allowed, because that is what
-- `rotate_refresh_token()`'s `coalesce(consumed_at, now())` does for a caller that
-- arrives inside the grace window — it re-asserts the fact rather than changing it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION auth_consume_once() RETURNS trigger AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION '% row % was consumed at % and cannot be consumed again',
      TG_TABLE_NAME, OLD.id, OLD.consumed_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER auth_tokens_consume_once
  BEFORE UPDATE ON auth_tokens
  FOR EACH ROW EXECUTE FUNCTION auth_consume_once();
--> statement-breakpoint

CREATE TRIGGER oauth_states_consume_once
  BEFORE UPDATE ON oauth_states
  FOR EACH ROW EXECUTE FUNCTION auth_consume_once();
--> statement-breakpoint

CREATE TRIGGER refresh_tokens_consume_once
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION auth_consume_once();
--> statement-breakpoint

-- The rest of a refresh token is history, not state. Moving a token to another session,
-- re-pointing its parent or re-dating its issue would each rewrite the answer to "which
-- device was this, and when did it last really authenticate" — the only questions the
-- chain exists to answer. Un-revoking is refused for the obvious reason.
CREATE FUNCTION refresh_tokens_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'refresh token % is a record of an issue, not a mutable row', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'refresh token % was revoked at % and cannot be un-revoked',
      OLD.id, OLD.revoked_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER refresh_tokens_immutable
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION refresh_tokens_immutable();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- A refresh token may never outlive its session.
--
-- This is what lets `rotate_refresh_token()` be one statement against one table. If a
-- token could expire after its session, the rotation would have to join `sessions` to
-- find out whether it may proceed, and a join is a second row to lock and a second
-- thing to get wrong under concurrency. With the invariant enforced on write:
--
--   session expired  ⇒ every token of it has already expired ⇒ `expires_at > now()`
--                      in the rotation's WHERE clause is enough
--   session revoked  ⇒ the cascade below has already stamped `revoked_at` on every
--                      token of it ⇒ `revoked_at IS NULL` is enough
--
-- Together those two are exactly the session state the hot path needs, read from the
-- token row it was already locking.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION refresh_tokens_within_session() RETURNS trigger AS $$
DECLARE
  session_expires_at timestamptz;
BEGIN
  SELECT s.expires_at INTO session_expires_at FROM sessions s WHERE s.id = NEW.session_id;

  IF NEW.expires_at > session_expires_at THEN
    RAISE EXCEPTION 'refresh token would expire at %, after its session at %',
      NEW.expires_at, session_expires_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER refresh_tokens_within_session
  BEFORE INSERT OR UPDATE OF expires_at, session_id ON refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION refresh_tokens_within_session();
--> statement-breakpoint

-- Revoking a session revokes its tokens, in the same transaction, without the caller
-- having to know that. "Sign out everywhere" and the reuse detection below both act on
-- the session; this is what makes that act reach the rows the refresh path actually
-- reads. AFTER, so the session row is already in its new state, and scoped to the
-- `revoked_at` column so a routine `last_seen_at` touch does not re-run it.
CREATE FUNCTION sessions_revoke_cascade() RETURNS trigger AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE refresh_tokens
       SET revoked_at = NEW.revoked_at
     WHERE session_id = NEW.id
       AND revoked_at IS NULL;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER sessions_revoke_cascade
  AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_revoke_cascade();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓒ REFRESH ROTATION — plan 6(c).
--
-- The failure this is built against is not an attack. A dashboard opens six panels, all
-- six requests find the access token expired within the same millisecond, all six
-- refresh with the same token, and reuse-detection that cannot tell a race from a theft
-- signs the user out in the middle of their work.
--
-- The fix has to be one atomic statement, and this is it. `SELECT rotate_refresh_token(…)`
-- is a single statement from the caller's side; inside, the claim is a single UPDATE
-- whose WHERE clause decides the winner. Under READ COMMITTED the losers block on the
-- winner's row lock and then re-evaluate that WHERE against the row as the winner left
-- it — which is why the grace branch is written into the WHERE and not checked after.
--
-- `RETURNING old.consumed_at` (PostgreSQL 18) is what makes one statement enough: it
-- reports the value the row held *before* this statement touched it, so the winner
-- (`NULL`) and a graced racer (a timestamp) are told apart without a second read that
-- another transaction could slip between.
--
-- The grace window defaults to 15 seconds, per the plan. A caller may pass a shorter one;
-- the tests pass zero to close the window on demand instead of sleeping.
--
-- Parameters are prefixed `p_` so nothing in the body can silently resolve to a column of
-- the same name — plpgsql prefers the variable, and `WHERE token_hash = token_hash` is a
-- tautology that would consume every token in the table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION rotate_refresh_token(
  p_presented_hash char(64),
  p_successor_hash char(64),
  p_successor_ttl  interval,
  p_grace          interval DEFAULT interval '15 seconds'
) RETURNS TABLE (
  outcome      refresh_rotation_outcome,
  in_session   uuid,
  successor_id uuid
) AS $$
DECLARE
  claimed record;
  stale   record;
BEGIN
  UPDATE refresh_tokens t
     SET consumed_at = coalesce(t.consumed_at, now())
   WHERE t.token_hash = p_presented_hash
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND (t.consumed_at IS NULL OR t.consumed_at > now() - p_grace)
  RETURNING t.id, t.session_id, old.consumed_at AS previously_consumed_at
       INTO claimed;

  IF NOT FOUND THEN
    -- Nothing was claimed. Either this token never existed, or it is expired or revoked,
    -- or it was consumed and the grace window has since closed. Only the last is theft: a
    -- token that was already spent, presented again by somebody who kept a copy.
    SELECT t.session_id, t.consumed_at INTO stale
      FROM refresh_tokens t
     WHERE t.token_hash = p_presented_hash;

    IF FOUND AND stale.consumed_at IS NOT NULL THEN
      UPDATE sessions s
         SET revoked_at = now(), revoked_reason = 'refresh_reuse'
       WHERE s.id = stale.session_id
         AND s.revoked_at IS NULL;

      outcome := 'reused';
    ELSE
      outcome := 'rejected';
    END IF;

    in_session := NULL;
    successor_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- `least(…)` and not `now() + ttl`: the successor must not outlive the session, which
  -- is the invariant `refresh_tokens_within_session` enforces. It cannot land in the past
  -- — the UPDATE above only succeeded because the presented token expires after `now()`,
  -- and that token could only have been issued with an expiry inside the session's.
  INSERT INTO refresh_tokens (session_id, token_hash, parent_id, expires_at)
  SELECT claimed.session_id, p_successor_hash, claimed.id,
         least(now() + p_successor_ttl, s.expires_at)
    FROM sessions s
   WHERE s.id = claimed.session_id
  RETURNING id INTO successor_id;

  UPDATE sessions s SET last_seen_at = now() WHERE s.id = claimed.session_id;

  outcome := CASE WHEN claimed.previously_consumed_at IS NULL THEN 'rotated' ELSE 'graced' END;
  in_session := claimed.session_id;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓐ ACCOUNT PRE-HIJACKING — plan 6(a).
--
-- The attack: the attacker registers with the victim's address and leaves it unverified.
-- Months later the victim signs in with Google on that address. Any code that reaches for
-- "an existing account with this email" finds the attacker's, merges into it, and hands
-- the victim a session in an account somebody else still has the password to.
--
-- The plan's answer is that proving control of an address strips it from every unverified
-- account and creates a fresh one. That has to be a trigger and not a service method for
-- two reasons: a service method is one caller away from being forgotten — every new
-- provider is a new caller — and a service method doing DELETE-then-UPDATE leaves a
-- window in which a concurrent signup can insert one more unverified claim behind it.
-- Here the stripping happens inside the statement that did the proving.
--
-- The partial unique index `user_emails_one_verified_owner` is the other half, and the
-- two are not redundant: the index makes two *verifications* of one address mutually
-- exclusive, this makes an unverified claim stop existing the moment somebody proves the
-- address. Neither alone closes it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION user_emails_strip_unverified() RETURNS trigger AS $$
BEGIN
  IF NEW.verified_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.verified_at IS NULL) THEN
    -- Other rows only, and only unproven claims. The DELETE fires no INSERT or UPDATE
    -- trigger, so there is no recursion to guard against.
    DELETE FROM user_emails
     WHERE address = NEW.address
       AND verified_at IS NULL
       AND id <> NEW.id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_emails_strip_unverified
  AFTER INSERT OR UPDATE OF verified_at ON user_emails
  FOR EACH ROW EXECUTE FUNCTION user_emails_strip_unverified();
--> statement-breakpoint

-- Verification is a fact about the past. Un-verifying would let an address that once
-- carried proof be quietly downgraded and re-claimed; moving a verified address to a
-- different string, or to a different user, would carry the proof somewhere nobody
-- proved anything. Giving up an address means deleting the row, which is visible.
CREATE FUNCTION user_emails_verification_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.verified_at IS NOT NULL THEN
    IF NEW.verified_at IS NULL THEN
      RAISE EXCEPTION 'email % was verified at % and cannot be un-verified',
        OLD.address, OLD.verified_at
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.address IS DISTINCT FROM OLD.address THEN
      RAISE EXCEPTION 'email % is verified; its address cannot be changed to %',
        OLD.address, NEW.address
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'email % belongs to user %; moving it is a new claim, not an update',
      OLD.address, OLD.user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_emails_verification_is_final
  BEFORE UPDATE ON user_emails
  FOR EACH ROW EXECUTE FUNCTION user_emails_verification_is_final();
--> statement-breakpoint

-- ⓓ The rollback direction, applied to groups. Plan 6(d) is about a release N+1 that adds
-- something and a rollback to N that must still boot; a system group removed by a tidy-up
-- is the same failure with a different noun. Application groups are deletable; the ones
-- the binary boots with are not.
CREATE FUNCTION groups_block_system_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'group % is a system group and cannot be deleted', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER groups_block_system_delete
  BEFORE DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION groups_block_system_delete();
