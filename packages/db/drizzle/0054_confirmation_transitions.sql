-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ THE FIVE MOVES AROUND `awaiting_confirmation`, AND AN HONEST NAME FOR ONE ACT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0053 made the status legal. This makes it reachable, and nothing yet sends an order there:
-- the submit is repointed in the next commit. Landing them apart is what lets either be reverted
-- without the other.
--
-- ── ⛔ THE BUG THIS MIGRATION EXISTS TO MAKE FIXABLE ──────────────────────────
--
-- Staff can already start production on an order nobody has paid for — the owner asks for
-- exactly that ("ยังไม่ต้องชำระก็ได้ ... ข้ามไปที่ขั้นตอนเริ่มผลิตเลยแล้วค่อยชำระทีเดียว"). What
-- was wrong is what the system then *said*: `awaiting_payment → production_confirmed` carries
-- `payment_confirmed`, so the spine recorded a payment that never happened and the customer was
-- emailed "เราตรวจสอบและยืนยันการชำระเงินของท่านแล้ว" having transferred ฿0.
--
-- It could not be fixed in place. `order_events_guard_insert()` refuses any event whose type
-- differs from the one its (from, to) pair names (`0051_write_off_event.sql:153-157`), and the
-- pair is the primary key — so **one pair can mean exactly one thing**. Two different acts
-- needed two different pairs, which is why the honest edge starts from the new status:
--
--   awaiting_confirmation → production_confirmed   `production_authorised_unpaid`
--
-- and why `awaiting_payment → awaiting_confirmation` exists at all: without a way back, an order
-- that had already been confirmed could never reach the honest edge, and every order already
-- sitting in `awaiting_payment` when this ships would have lost the ability for good.
--
-- ── The names ────────────────────────────────────────────────────────────────
--
--   `quotation_confirmed`           staff have agreed the figures; the customer may now pay.
--   `production_authorised_unpaid`  ugly on purpose, in the spirit of `balance_written_off`
--                                   (0051): the row is read by somebody six months later who
--                                   needs to know that no money was received, and a polite name
--                                   is how that fact gets lost.
--   `quotation_reopened`            staff pulled it back to renegotiate. Not `un-confirmed`,
--                                   which describes an undo rather than an act.
--
-- `submitted_for_payment` keeps its name on the new `draft → awaiting_confirmation` pair. It is
-- a key: two `notification_rules` rows, two template keys, `GATE_EVENTS` in the dashboard, and
-- every historical `order_events` row already carry it. The repository's own precedent for a
-- name that has stopped fitting is 0043/0044, which reworded `description_th` and left the key
-- alone.
-- ═════════════════════════════════════════════════════════════════════════════

SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint

-- ⚠️ BOTH constraints, in one migration, or the rules INSERT below fails on a type the events
-- table has just learned. This is exactly the pairing `0051_write_off_event.sql:39-62` documents.
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_known";
--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_known" CHECK (
  "order_events"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'quotation_confirmed',
    'quotation_reopened', 'production_authorised_unpaid', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded', 'balance_written_off'
  )
);
--> statement-breakpoint

ALTER TABLE "notification_rules" DROP CONSTRAINT "notification_rules_event_type_known";
--> statement-breakpoint

ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_event_type_known" CHECK (
  "notification_rules"."event_type" in (
    'created', 'quote_revised', 'submitted_for_payment', 'quotation_confirmed',
    'quotation_reopened', 'production_authorised_unpaid', 'payment_confirmed',
    'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign',
    'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved',
    'balance_reminded', 'balance_written_off'
  )
);
--> statement-breakpoint

-- ⚠️ Two-space-indented tuples, one statement, no breakpoint until after the semicolon —
-- `apps/web/tests/order-actions.test.ts` reads the customer's cancellation rights by slicing
-- these files apart on that exact shape. It is a string-surgery parser and this formatting is
-- load-bearing to it.
INSERT INTO order_status_transitions
  (from_status, to_status, event_type, payload_kind, required_payload_keys, allowed_actor_kinds, description_th)
VALUES
  ('draft', 'awaiting_confirmation', 'submitted_for_payment', 'submit', '{}',
   '{customer,guest,staff}',
   'ลูกค้าขอใบเสนอราคา — รอเจ้าหน้าที่ตรวจและยืนยัน จุดที่ตรึงเอกสาร'),
  ('awaiting_confirmation', 'awaiting_payment', 'quotation_confirmed', 'none', '{}',
   '{staff}',
   'เจ้าหน้าที่ยืนยันใบเสนอราคาแล้ว — ลูกค้าชำระเงินได้'),
  ('awaiting_confirmation', 'production_confirmed', 'production_authorised_unpaid', 'authorise_unpaid', '{reason}',
   '{staff}',
   'อนุมัติให้เริ่มผลิตโดยยังไม่รับชำระ — เก็บเงินทีหลัง'),
  ('awaiting_confirmation', 'cancelled', 'cancelled', 'cancel_pre_freeze', '{}',
   '{customer,guest,staff}',
   'ยกเลิกก่อนยืนยันใบเสนอราคา — ยังไม่มีข้อผูกพัน'),
  ('awaiting_payment', 'awaiting_confirmation', 'quotation_reopened', 'none', '{}',
   '{staff}',
   'ดึงกลับมาแก้ไข — ลูกค้ายังไม่ได้ชำระ')
ON CONFLICT (from_status, to_status) DO NOTHING;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ WHO IS TOLD, AND WHO DELIBERATELY IS NOT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `quotation_confirmed` — the customer, always. It is the mail that turns a price they were
-- shown into a price they may act on, and without it the new status is a room with no door: the
-- customer would be waiting for a confirmation nobody told them had happened.
--
-- `production_authorised_unpaid` — the customer, always, and this rule *is* the bug fix. They
-- are told production has started and that payment follows; the sentence that used to reach them
-- claimed their money had been received.
--
-- `quotation_reopened` — nobody. Staff pulling an order back to adjust it is not news until
-- there is something to say, and the something is the confirmation that follows. Recorded as a
-- deliberate silence in `apps/api/src/notifications/event-coverage.ts`, which is where
-- `rules-coverage.pg.test.ts` insists such a decision be written down rather than left as an
-- absence somebody later reads as an oversight.
--
-- ⚠️ `coalesce_seconds = 0` on both, unlike `quote_revised`'s 600. A ten-minute window is right
-- for an editor somebody is still typing in; it is wrong for a decision, and a customer who is
-- told ten minutes late that they may now pay is a customer wondering whether anything happened.
INSERT INTO notification_rules
  (event_type, recipient_kind, channel, template_key, coalesce_seconds, is_enabled)
VALUES
  ('quotation_confirmed', 'customer', 'email', 'order.quotation_confirmed.customer', 0, true),
  ('production_authorised_unpaid', 'customer', 'email',
   'order.production_authorised_unpaid.customer', 0, true)
ON CONFLICT DO NOTHING;
