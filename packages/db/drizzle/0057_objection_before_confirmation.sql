-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ A CUSTOMER MAY STILL OBJECT BEFORE THE QUOTATION IS CONFIRMED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `order_change_requests_live_orders_only` (0007) lists the statuses in which a customer may
-- raise plan 10.4's objection. It was written when a submit landed in `awaiting_payment`, so
-- the new status is missing from it — and the effect is a right quietly removed: an order in
-- `awaiting_confirmation` is precisely one somebody is still negotiating, and it was the one
-- status where the customer could not say "this is not what we agreed".
--
-- Found by a red-team fixture failing with a 409 rather than by anybody noticing the button was
-- gone, which is the argument for keeping that suite pointed at the real database.
--
-- ⚠️ This does not weaken the block it exists for. An open request still bars entry to
-- `production_confirmed` (`orders_guard_update`), and the new unpaid-authorisation edge leaves
-- from this status — so an unanswered objection now blocks *that* door too, which is exactly
-- what plan 10.4 asks for.
-- ═════════════════════════════════════════════════════════════════════════════

SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint

DROP TRIGGER order_change_requests_live_orders_only ON order_change_requests;
--> statement-breakpoint

CREATE TRIGGER order_change_requests_live_orders_only
  BEFORE INSERT ON order_change_requests
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,production_confirmed,in_production,awaiting_installation,redesign}'
  );
