-- The three transition descriptions that still name the cut.
--
-- 0043 took `โรงงานเริ่มตัดอะลูมิเนียม` off the one row that named the *material*. It left the
-- three rows that name the *act*, because the material was the visible half of the problem
-- and the verb looked harmless. It is not: the reasoning 0043 gave applies to `ตัด` on its
-- own, and applies to it three more times.
--
--   `awaiting_payment → cancelled`        `ยกเลิกก่อนเข้าผลิต — ยังไม่มีอะไรถูกตัด`
--   `production_confirmed → redesign`     `ฝ่ายผลิตตีกลับก่อนเริ่มตัด`
--   `production_confirmed → cancelled`    `ยกเลิกหลัง freeze แต่ยังไม่ได้ตัด — ตารางการริบให้ 0`
--
-- What each of these three actually means is *the commitment has not been acted on yet* —
-- and that is the whole of what the row is for. The first and third are read beside a
-- refund: `production_confirmed` is the one post-freeze cell the forfeit table pins to 0,
-- and the reason it can be pinned is that nothing has been committed to the customer's
-- specification yet, not that a saw has not run. The second is the button a production
-- lead presses to bounce a design back, and what makes the bounce cheap is the same fact.
-- Naming the cut states a consequence of the commitment and mistakes it for the cause.
--
-- Cutting is also the wrong act to name for a good part of the catalogue, in the way 0043
-- described: 81 products in ten categories, of which four are insect screens and 24 are
-- louvres. Aluminium profile is cut for all of them — `KIT_SUMMARY.screen` is
-- `มุ้งกันแมลงกรอบอะลูมิเนียม`, an aluminium frame — so the sentence is not false. It is
-- narrow. `ตัด` is one station on a line that also bends, punches, glazes, fits mesh and
-- assembles, and a staff member reading a cancellation dialog does not need to be told
-- which station. `เริ่มผลิต` is the word this product already uses for the whole of it —
-- 0043 settled on it, and `apps/web`'s Thai catalogue has used it since `home.step.survey`.
--
-- `เริ่มทำ` on the first row rather than `เริ่มผลิต`: that row is pre-freeze, where the point
-- is that no work exists at all, and repeating ผลิต straight after `ก่อนเข้าผลิต` makes the
-- second clause read as a restatement of the first instead of the reassurance it is there to
-- give. `ขึ้นงาน` was tried and dropped: it is trade jargon, and the customer-facing twin
-- `orderActions.cancel.preFreezeNote` — which this dialog sits opposite — must not introduce a
-- word the site uses nowhere else. One word for one idea, on both sides of the counter.
--
-- Each `WHERE` pins the exact current value as well as the status pair, so this is safe to
-- re-run and leaves alone any row an operator has already reworded by hand. A count of 0
-- from any one of the three means the value moved underneath this file and the new wording
-- needs deciding against whatever it moved to, not forcing.
UPDATE "order_status_transitions"
SET "description_th" = 'ยกเลิกก่อนเข้าผลิต — ยังไม่ได้เริ่มทำ'
WHERE "from_status" = 'awaiting_payment'
  AND "to_status" = 'cancelled'
  AND "description_th" = 'ยกเลิกก่อนเข้าผลิต — ยังไม่มีอะไรถูกตัด';
--> statement-breakpoint
UPDATE "order_status_transitions"
SET "description_th" = 'ฝ่ายผลิตตีกลับก่อนเริ่มผลิต'
WHERE "from_status" = 'production_confirmed'
  AND "to_status" = 'redesign'
  AND "description_th" = 'ฝ่ายผลิตตีกลับก่อนเริ่มตัด';
--> statement-breakpoint
UPDATE "order_status_transitions"
SET "description_th" = 'ยกเลิกหลัง freeze แต่ยังไม่เริ่มผลิต — ตารางการริบให้ 0'
WHERE "from_status" = 'production_confirmed'
  AND "to_status" = 'cancelled'
  AND "description_th" = 'ยกเลิกหลัง freeze แต่ยังไม่ได้ตัด — ตารางการริบให้ 0';
