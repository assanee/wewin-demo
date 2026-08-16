-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ THE FLIP: a quotation request stops being a demand for money
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0053 made `awaiting_confirmation` legal, 0054 gave it its five edges, 0055 said what may be
-- written against an order standing in it. This removes the old road, which is the statement
-- that makes the new one the road.
--
-- `draft → awaiting_payment` is deleted rather than repointed: `(from_status, to_status)` is the
-- primary key, so the destination is not a column that can be updated. `draft →
-- awaiting_confirmation` (0054) already carries the same `event_type`, the same `payload_kind`
-- and the same actors, so nothing about the submit changes except where it arrives.
--
-- ⚠️ WHAT ABOUT A BROWSER TAB THAT WAS ALREADY OPEN? `apps/web/src/lib/quote/submit.ts` posts
-- the destination by name, so a page loaded before the deploy posts `awaiting_payment` from a
-- draft and would get a 409 — on the customer's primary action, with a message about statuses
-- that means nothing to them. `OrdersService.transition` therefore treats that one pair as a
-- request for the submit and lands it in `awaiting_confirmation`, with a test on it. That shim
-- is deliberately in the service and not a second row here: a row would be a second way for an
-- order to reach `awaiting_payment` unconfirmed, which is the thing this whole round removes.
--
-- ── The wording of the row that remains ──────────────────────────────────────
--
-- Rewritten, not renamed — the 0043/0044 precedent for a description that has stopped fitting.
-- The guard makes the no-op loud: a WHERE that matches nothing would leave the old sentence on
-- the screen where staff read it, and nothing else would ever say so.
-- ═════════════════════════════════════════════════════════════════════════════

DELETE FROM order_status_transitions
 WHERE from_status = 'draft' AND to_status = 'awaiting_payment';
--> statement-breakpoint

DO $$
DECLARE
  moved integer;
BEGIN
  UPDATE order_status_transitions
     SET description_th = 'ลูกค้าขอใบเสนอราคา — รอเจ้าหน้าที่ตรวจและยืนยัน จุดที่ตรึงเอกสาร'
   WHERE from_status = 'draft' AND to_status = 'awaiting_confirmation';

  GET DIAGNOSTICS moved = ROW_COUNT;

  IF moved <> 1 THEN
    RAISE EXCEPTION 'expected exactly one draft → awaiting_confirmation row to reword, found %', moved
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;
