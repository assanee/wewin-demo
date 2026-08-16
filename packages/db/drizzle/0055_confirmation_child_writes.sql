-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ WHAT MAY BE WRITTEN AGAINST AN ORDER THAT IS WAITING TO BE CONFIRMED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0053 made the status legal, 0054 made it reachable, and this decides what may happen to an
-- order standing in it. Every rule below is one `order_child_require_status` trigger — the
-- mechanism 0007 built for exactly this and predicted would be reused "one line in a migration
-- rather than a second copy of the reasoning".
--
-- ── The three that gain the new status ───────────────────────────────────────
--
--   `order_instalments`    the submit itself writes the schedule, and after the flip the order
--                          is `awaiting_confirmation` at that moment. Without this the submit
--                          fails outright — this is the trigger that would have caught the flip
--                          if the flip had been written first.
--   `quote_lines`          staff editing a quotation is the entire point of the status. An
--   `quote_overrides`      order nobody may edit here is a waiting room with no purpose.
--
-- ── ⛔ THE ONE THAT DELIBERATELY DOES NOT ────────────────────────────────────
--
-- `payment_slips_live_orders_only` keeps `awaiting_payment` as its first member and does NOT
-- gain `awaiting_confirmation`. That refusal is the feature: an unconfirmed quotation is a price
-- nobody has agreed to, and a customer who found the payment page anyway — an old link, a stale
-- QR, a forwarded email — must not be able to transfer against it. The storefront will hide the
-- button, but a hidden button is a decoration; this is the rule.
--
-- `approvals` (0007) is untouched for the same reason it lists what it lists: an approval is
-- about a concession on a document, and a document in this status can still carry one.
-- ═════════════════════════════════════════════════════════════════════════════

SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint

DROP TRIGGER order_instalments_live_orders_only ON order_instalments;
--> statement-breakpoint

-- ⚠️ `awaiting_confirmation` first, because that is now where a schedule is born: the submit
-- plans the instalments in the same transaction that moves the order out of `draft`.
CREATE TRIGGER order_instalments_live_orders_only
  BEFORE INSERT ON order_instalments
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,redesign}'
  );
--> statement-breakpoint

DROP TRIGGER quote_lines_live_orders_only ON quote_lines;
--> statement-breakpoint

CREATE TRIGGER quote_lines_live_orders_only
  BEFORE INSERT ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,redesign}'
  );
--> statement-breakpoint

DROP TRIGGER quote_overrides_live_orders_only ON quote_overrides;
--> statement-breakpoint

CREATE TRIGGER quote_overrides_live_orders_only
  BEFORE INSERT ON quote_overrides
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,redesign}'
  );
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ NOTHING IS FROZEN BEFORE IT IS CONFIRMED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `orders_awaiting_payment_is_pre_freeze` says an order waiting to be paid cannot carry a
-- `frozen_at`. The same is true, and more obviously, one status earlier. There is no path from
-- a frozen status back to `awaiting_confirmation` today, so this cannot fire — which is the
-- point of writing it: the constraint is what makes that still true after somebody adds a
-- transition without thinking about the freeze.
ALTER TABLE "orders" DROP CONSTRAINT "orders_awaiting_payment_is_pre_freeze";
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_awaiting_payment_is_pre_freeze" CHECK (
  "orders"."status" not in ('awaiting_confirmation', 'awaiting_payment')
  or "orders"."frozen_at" is null
);
