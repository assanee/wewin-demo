ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_address_nfc" CHECK ("user_emails"."address" = normalize("user_emails"."address", nfc));--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓐ THE STRIP HAS TO WIN A RACE IT WAS LOSING — plan 6(a), second pass.
--
-- 0003_auth_guards.sql claimed that putting the strip in a trigger "removes the window in
-- which a concurrent signup can insert one more unverified claim behind it". A red-team
-- pass proved that sentence false and the claim is worth restating precisely, because the
-- half that *was* true is the half worth keeping:
--
--   true      a trigger cannot be forgotten by a new caller, which a service method can.
--   false     it does not serialise anything. `user_emails_strip_unverified` is an AFTER
--             trigger whose DELETE only reaches rows its snapshot can see, and nothing in
--             the schema locks an address — there is no unique index over *unverified*
--             rows, by design, because several accounts may claim one address. So a
--             transaction that inserted an unverified claim first and commits second
--             survives the proof entirely, and plan 6(a) is back.
--
-- Two statements fix it, and they are two because they close two different holes:
--
--   the advisory lock   serialises every writer of one address for the rest of its
--                       transaction. The loser blocks, and when it wakes its next
--                       statement takes a fresh snapshot (READ COMMITTED, and each
--                       statement inside a plpgsql function takes its own) — so the
--                       strip below sees the row that raced it, and a claim arriving
--                       after a proof sees the proof. `hashtext` collisions cost two
--                       unrelated addresses a moment of serialisation and nothing else.
--
--   the EXISTS check    refuses an unverified claim on an address somebody has already
--                       proven. That is the *other* red-team finding: the strip is a
--                       point-in-time sweep on the proving statement, so an attacker who
--                       re-plants the claim one second later is never swept again, and
--                       every future proof by the owner returns early without stripping.
--                       Prevention rather than repeated cleaning — there is no moment at
--                       which the row is allowed to exist.
--
-- Deliberately `unique_violation`: this *is* a uniqueness conflict ("that mailbox has an
-- owner"), it is the SQLSTATE a caller already retries on, and the message names no
-- account — an address that is taken must not become an oracle for which accounts exist.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION user_emails_claim_guard() RETURNS trigger AS $$
BEGIN
  -- A `last used` touch is not a claim and must not queue behind one.
  IF TG_OP = 'UPDATE'
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
     AND NEW.address = OLD.address THEN
    RETURN NEW;
  END IF;

  -- 4919 namespaces this lock so it cannot collide with an advisory lock taken for some
  -- unrelated purpose that happened to hash an address to the same integer.
  PERFORM pg_advisory_xact_lock(4919, hashtext(NEW.address));

  IF NEW.verified_at IS NULL
     AND EXISTS (
           SELECT 1 FROM user_emails e
            WHERE e.address = NEW.address
              AND e.verified_at IS NOT NULL
              AND e.id <> NEW.id
         ) THEN
    RAISE EXCEPTION 'email address is already proven by another account'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_emails_claim_guard
  BEFORE INSERT OR UPDATE OF verified_at, address ON user_emails
  FOR EACH ROW EXECUTE FUNCTION user_emails_claim_guard();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓒ ROTATION, WITH THE LOCK ORDER FIXED — plan 6(c), second pass.
--
-- The body below differs from 0003's in two places and nowhere else. Both were found by
-- running the thing rather than reading it.
--
-- **The lock order was inverted, and it defeated logout.** 0003's rotation claimed a row in
-- `refresh_tokens` and *then* touched `sessions.last_seen_at`; `sessions_revoke_cascade`
-- goes the other way — a revoke updates `sessions` and the trigger then updates that
-- session's `refresh_tokens`. Two orders over two tables is a cycle, and Postgres resolves
-- a cycle by aborting somebody with 40P01. Measured on this laptop: 300 concurrent
-- (refresh, logout) pairs aborted 82 logouts, and *the session was never revoked* in every
-- one of them — the user pressed sign out, saw success, and stayed signed in. "Sign out
-- everywhere" is worse, because it is one statement over every session a user has: one
-- racing tab aborted the whole thing, 6 of 60 calls revoking nothing at all.
--
-- The fix is to take the session lock first and let both paths agree: `sessions` then
-- `refresh_tokens`, always. It costs one extra round trip through the index on
-- `refresh_tokens.token_hash` and makes concurrent refreshes of one session queue on the
-- session row rather than the token row — which is where they were queueing anyway, one
-- statement later.
--
-- **A suspended account could refresh forever.** `users.status` is written by the schema
-- and was read by nothing: suspending someone revoked no session, and their 30-day refresh
-- chain kept rotating. The join below ends that at the next rotation, which is at most one
-- access-token lifetime away. It answers `rejected` and not `reused`: suspension is not
-- theft, and revoking the session here would overwrite the reason an administrator set.
--
-- Everything else — the single claim UPDATE, `RETURNING old.consumed_at`, the grace branch
-- inside the WHERE clause — is unchanged, because that part was right.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rotate_refresh_token(
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
  target  record;
BEGIN
  -- Unlocked, and only to learn *which* session row to lock. Every decision below is still
  -- made by the claim UPDATE against the row as it stands at that moment; this read cannot
  -- authorise anything on its own.
  SELECT t.session_id INTO target
    FROM refresh_tokens t
   WHERE t.token_hash = p_presented_hash;

  IF FOUND THEN
    PERFORM 1
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = target.session_id
        AND u.status = 'active'
        FOR NO KEY UPDATE OF s;

    IF NOT FOUND THEN
      -- The account is suspended (or the session is gone). Nothing is revoked and nothing
      -- is issued; the caller signs in again and discovers there is no signing in.
      outcome := 'rejected';
      in_session := NULL;
      successor_id := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  UPDATE refresh_tokens t
     SET consumed_at = coalesce(t.consumed_at, now())
   WHERE t.token_hash = p_presented_hash
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND (t.consumed_at IS NULL OR t.consumed_at > now() - p_grace)
  RETURNING t.id, t.session_id, old.consumed_at AS previously_consumed_at
       INTO claimed;

  IF NOT FOUND THEN
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
