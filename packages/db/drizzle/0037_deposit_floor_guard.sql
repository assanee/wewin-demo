-- ═════════════════════════════════════════════════════════════════════════════
-- THE DEPOSIT FLOOR IS A TERM OF THE CONTRACT TOO — write-once, like the forfeit policy beside it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `0034_order_deposit_floor.sql` adds `orders.deposit_floor_bp` and two CHECKs — the range,
-- and "no floor before a contract exists" — and no trigger. `update orders set
-- deposit_floor_bp = null where id = <submitted>` therefore succeeds today and silently
-- reverts that order to live-policy measurement forever. That is this migration's gap to
-- close, and it is the same defect 0034 shipped to fix, reopened through the one door 0034
-- left unlocked.
--
-- `orders_guard_forfeit_policy` (0013_payment_closure_guards.sql) already makes the identical
-- argument for the column beside this one, in its own words: "A pin that can be repointed
-- after the cancellation is a pin that decides the refund after the argument has started."
-- `deposit_floor_bp` exists for the same reason `forfeit_policy_id` does — 0034's own header
-- says so directly: "an audit trail that re-interprets a historical order against today's
-- policy answers a different question each time it is asked" — and a column whose entire
-- justification is "an audit answers the same question twice" is the last one that should be
-- rewritable. Nothing about `deposit_floor_bp` makes it a weaker pin than `forfeit_policy_id`;
-- it was simply added without this half.
--
-- Same shape as `orders_guard_forfeit_policy`, on purpose — what it permits, what it refuses,
-- and when:
--
--   OLD null (no pin yet — a draft, or an order that predates the column)
--       → any write is permitted. This is how `applySubmission` sets it the first time, and
--         how an order that already predates the column (0034 backfills nothing, deliberately)
--         stays exactly as free to be measured live as 0034's own fallback intends.
--   OLD not null and NEW distinct from OLD (repointing or clearing an existing pin)
--       → refused, unconditionally, the same restrict_violation `orders_guard_forfeit_policy`
--         raises for its column. There is no legitimate reason for a submitted order's floor to
--         change: the schedule it was planned from may still be edited after submit (0034's
--         header, citing `approvals.decided_ceiling_thb_minor` as the precedent for pinning the
--         *input* to a comparison and not the verdict), but the input itself does not move once
--         it exists — moving it is what this guard exists to refuse.
--
-- Attached as its own trigger rather than folded into `orders_guard_update()`, matching
-- `orders_guard_forfeit_policy`'s own reasoning for doing the same: that function is 0007's and
-- belongs to the order lifecycle; the deposit floor is money, like the forfeit policy beside it.
--
-- Hand-written with no snapshot, like every migration since 0028.
CREATE FUNCTION orders_guard_deposit_floor() RETURNS trigger AS $$
BEGIN
  IF OLD.deposit_floor_bp IS NOT NULL
     AND NEW.deposit_floor_bp IS DISTINCT FROM OLD.deposit_floor_bp THEN
    RAISE EXCEPTION 'order % was judged against deposit floor % and that does not change',
      OLD.id, OLD.deposit_floor_bp
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_guard_deposit_floor
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_deposit_floor();
