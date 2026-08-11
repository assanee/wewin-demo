-- The staff-verification write path for user_phones (apps/api/src/users). Two unrelated-
-- looking changes that belong in one migration because both exist to serve the same feature —
-- 0025_user_phones.sql bundled its whole feature the same way, for the same reason.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ PART 1 — a contradiction this feature's own brief asked to be found, not hidden.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `user_phones_verification_is_final` (0025_user_phones.sql) refuses to null `verified_at`
-- on ANY verified row, full stop. Its own comment says why: "Un-verifying would let a number
-- that once carried proof be quietly downgraded and re-claimed... Giving up a number means
-- deleting the row, which is visible." That is correct for what the table meant on the day
-- it was written — proof of possession, the OTP this schema was built to anticipate.
--
-- It is wrong for what a staff assertion is. The schema comment on `userPhones` already
-- promised this feature before it existed ("verified_at is set by a member of staff, in the
-- dashboard, while they are on the telephone with the customer") and the brief that
-- implements it is explicit: "a number verified by mistake is a mistake somebody has to be
-- able to undo." The original trigger left no room for that — attempting it raises
-- `restrict_violation`, found by running the new un-verify route against a real database, not
-- by reading the trigger.
--
-- The fix narrows the refusal rather than removing it, so the guarantee that motivated the
-- trigger stays exactly as strong as it was for the case it actually protects:
--
--   `verified_by_user_id` was already null going in (a proved claim — the future OTP)
--       → un-verifying is still refused, unchanged.
--   `verified_by_user_id` was set going in (a staff assertion, by construction — see the
--   schema comment on that column)
--       → un-verifying is now allowed, and only to null both columns together —
--         `user_phones_voucher_needs_a_verification` already makes a half-cleared pair
--         unrepresentable, so this trigger does not need to re-check that shape.
--
-- Re-numbering and moving a verified row to a different user stay refused unconditionally —
-- neither is what "undo a mistaken verification" means, and the brief does not ask for either.
CREATE OR REPLACE FUNCTION user_phones_verification_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.verified_at IS NOT NULL THEN
    IF NEW.verified_at IS NULL THEN
      IF OLD.verified_by_user_id IS NULL THEN
        RAISE EXCEPTION 'phone % was proved at % and cannot be un-verified',
          OLD.number, OLD.verified_at
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- Else: a staff assertion, being undone by the route this migration exists for.
    ELSIF NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'phone % is verified; its number cannot be changed to %',
        OLD.number, NEW.number
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'phone % belongs to user %; moving it is a new claim, not an update',
      OLD.number, OLD.user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — two more admin_events actions.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `user_phones.verified_at` / `.verified_by_user_id` already record who and when a member of
-- staff vouched for a number — that pair *is* the distinguishing mark between a staff
-- assertion and a future OTP verification (see the schema comment on `userPhones`). A row
-- here is not needed to know that.
--
-- It is needed for what Part 1 now allows: un-verifying NULLs both columns, so without a row
-- here the fact that a mistaken assertion — and its correction — ever happened would not
-- survive the undo. The same shape `suspended_at` already has: reinstating NULLs it, and
-- `user.reinstated` is the only remaining answer to "who suspended them, and when".
--
-- Hand-written, matching 0009_user_erasure.sql's DROP/ADD shape for widening a text + CHECK
-- "enum" — drizzle-kit has no migration of its own for a member added to ADMIN_EVENT_ACTIONS,
-- because the column was never a real Postgres enum.
ALTER TABLE "admin_events" DROP CONSTRAINT "admin_events_action_known";--> statement-breakpoint
ALTER TABLE "admin_events" ADD CONSTRAINT "admin_events_action_known"
  CHECK ("admin_events"."action" in ('user.created', 'user.suspended', 'user.reinstated', 'user.groups_changed', 'user.sessions_revoked', 'user.password_link_sent', 'user.mfa_disabled', 'user.phone_verified', 'user.phone_unverified', 'group.created', 'group.renamed', 'group.deleted', 'group.permissions_changed'));
