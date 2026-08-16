-- ═════════════════════════════════════════════════════════════════════════════
-- ⛔ A REGRESSION 0055 INTRODUCED, AND THE TEST THAT CAUGHT IT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0055 widened the two quote guards to admit `awaiting_confirmation` by dropping and recreating
-- them — and recreated them as `BEFORE INSERT` where 0016 had written `BEFORE INSERT OR UPDATE`.
-- The list of statuses was the thing being changed and the list was right; what quietly went
-- missing was half of when the rule runs.
--
-- The hole: a quote line on a **cancelled** order could still be edited. Adding one was refused
-- and changing one was not, which is the worse of the two to lose — an order somebody cancelled
-- is exactly where a stray edit is least likely to be noticed.
--
-- `packages/db/tests/quote.test.ts` — "refuses a discount typed onto an order nobody can act on
-- any more" — failed on the UPDATE arm, which is why this file exists rather than the hole
-- shipping. Both triggers are restated whole below; `pg_get_triggerdef` is what the drift test
-- reads, so the fix has to be in the trigger and not in a comment about it.
-- ═════════════════════════════════════════════════════════════════════════════

DROP TRIGGER quote_lines_live_orders_only ON quote_lines;
--> statement-breakpoint

CREATE TRIGGER quote_lines_live_orders_only
  BEFORE INSERT OR UPDATE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,redesign}'
  );
--> statement-breakpoint

DROP TRIGGER quote_overrides_live_orders_only ON quote_overrides;
--> statement-breakpoint

CREATE TRIGGER quote_overrides_live_orders_only
  BEFORE INSERT OR UPDATE ON quote_overrides
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_confirmation,awaiting_payment,redesign}'
  );
