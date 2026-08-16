-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ A TENTH ORDER STATUS: `awaiting_confirmation` — รอยืนยัน
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The owner's flow, in their words:
--
--   "หลังจากที่ลูกค้าขอใบเสนอราคา ให้ยังอยู่ในสถานะที่ยังไม่ยืนยันได้ไหม จนกว่าเจ้าหน้าที่จะเข้ามา
--    ปรับปรุงข้อมูล และยืนยันอีกที เช่น การระบุยอดมัดจำ, การระบุส่วนลด หรือติดต่อคุยกับลูกค้าให้
--    เสร็จก่อน แล้วยืนยันข้อมูล ลูกค้าจึงจะสามารถชำระได้"
--
-- Today a customer's quotation request lands directly in `awaiting_payment`, which means the
-- first thing that happens after somebody asks for a price is that they are asked to transfer
-- money against a figure no member of staff has looked at. This status is the gap between
-- those two acts.
--
-- ── What this migration does and does not do ─────────────────────────────────
--
-- It makes the status *legal* and nothing else. No transition leads into it, so no order can
-- reach it, and every existing path is untouched. The transitions arrive in 0054 and the
-- submit is repointed after that. Three migrations rather than one because each of the three
-- leaves the tree green on its own, and a migration that cannot be landed alone is a migration
-- that cannot be reverted alone either.
--
-- ── Every CHECK that had to be restated, and why it is a restatement ─────────
--
-- Postgres has no ALTER on a CHECK: the four constraints below are dropped and re-added whole,
-- with the full ten-member list, following `0051_write_off_event.sql`'s treatment of the event
-- type list. Each of the four is a different table's opinion about what a status is:
--
--   `orders_status_known`                     where an order may stand.
--   `order_events_status_known`               what a spine row may say it moved between —
--                                             BOTH halves, or an event into the new status is
--                                             refused by the half nobody remembered.
--   `order_instalments_gate_known`            which status an instalment may hold the door to.
--                                             ⚠️ Nothing will ever gate entry to this one — an
--                                             unconfirmed order owes nothing — but the column's
--                                             domain is "a status", and a domain with a hole in
--                                             it is a trap for the next writer, not a rule.
--   `forfeit_policy_rules_from_status_known`  which status a cancellation may be priced from.
--
-- ── ⛔ The forfeit rows, which are the part that would have failed at midnight ─
--
-- `assert_forfeit_policy_complete()` requires a rule row for **every** cancellable status ×
-- fault, and 0054 adds `awaiting_confirmation → cancelled`. The rows are therefore written here,
-- for EVERY policy in the table and not only the effective one: a policy with a NULL
-- `effective_from` is skipped by that assertion today, so an incomplete one commits quietly and
-- raises `restrict_violation` months later, on the unrelated UPDATE that activates it. The live
-- database holds exactly such a policy (`agent_browser_probe`).
--
-- The rate is copied from each policy's own `awaiting_payment` cells rather than defaulted to
-- zero, because the two statuses mean the same thing to a cancelling customer: nothing has been
-- committed to the factory. Copying keeps a policy that has been thought about consistent, and
-- the shipped default (`plan13_default`, 0 bp everywhere) is unaffected either way.
-- ═════════════════════════════════════════════════════════════════════════════

-- ⛔ FIRST STATEMENT, and it is not decoration.
--
-- `drizzle-kit migrate` runs every pending migration in ONE transaction, and on a fresh database
-- that includes 0010's seeding of `forfeit_policies` — whose completeness check is a DEFERRED
-- constraint trigger. Postgres refuses `ALTER TABLE` on a table with pending trigger events
-- (55006 `cannot ALTER TABLE … because it has pending trigger events`), so the four ALTERs below
-- fail on a new database while passing on this developer's, where 0053 is the only migration in
-- its transaction. Flushing the deferred checks here makes both paths the same path — and if the
-- data were inconsistent, this is the statement that should say so.
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint

ALTER TABLE "orders" DROP CONSTRAINT "orders_status_known";
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_status_known" CHECK ("orders"."status" in (
  'draft', 'awaiting_confirmation', 'awaiting_payment', 'production_confirmed', 'in_production',
  'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'
));
--> statement-breakpoint

ALTER TABLE "order_events" DROP CONSTRAINT "order_events_status_known";
--> statement-breakpoint

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_status_known" CHECK (
  ("order_events"."from_status" is null or "order_events"."from_status" in (
    'draft', 'awaiting_confirmation', 'awaiting_payment', 'production_confirmed', 'in_production',
    'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'
  ))
  and
  ("order_events"."to_status" is null or "order_events"."to_status" in (
    'draft', 'awaiting_confirmation', 'awaiting_payment', 'production_confirmed', 'in_production',
    'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'
  ))
);
--> statement-breakpoint

ALTER TABLE "order_instalments" DROP CONSTRAINT "order_instalments_gate_known";
--> statement-breakpoint

ALTER TABLE "order_instalments" ADD CONSTRAINT "order_instalments_gate_known" CHECK (
  "order_instalments"."gates_entry_to" is null or "order_instalments"."gates_entry_to" in (
    'draft', 'awaiting_confirmation', 'awaiting_payment', 'production_confirmed', 'in_production',
    'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'
  )
);
--> statement-breakpoint

ALTER TABLE "forfeit_policy_rules" DROP CONSTRAINT "forfeit_policy_rules_from_status_known";
--> statement-breakpoint

ALTER TABLE "forfeit_policy_rules" ADD CONSTRAINT "forfeit_policy_rules_from_status_known" CHECK (
  "forfeit_policy_rules"."from_status" in (
    'draft', 'awaiting_confirmation', 'awaiting_payment', 'production_confirmed', 'in_production',
    'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'
  )
);
--> statement-breakpoint

-- Every policy, effective or not — see the header. `on conflict do nothing` so the migration is
-- re-runnable against a database somebody has already hand-patched.
INSERT INTO forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp)
SELECT source.policy_id, 'awaiting_confirmation', source.fault, source.forfeit_bp
  FROM forfeit_policy_rules source
 WHERE source.from_status = 'awaiting_payment'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ⛔ A policy with no `awaiting_payment` row to copy would leave the new status uncovered and
-- fail `assert_forfeit_policy_complete()` at its next activation — far from here, on a statement
-- that looks unrelated. Fail now instead, where the cause is on screen.
DO $$
DECLARE
  gap record;
BEGIN
  SELECT p.code, f.fault INTO gap
    FROM forfeit_policies p
    CROSS JOIN (VALUES ('customer'), ('company')) AS f(fault)
   WHERE NOT EXISTS (
     SELECT 1 FROM forfeit_policy_rules r
      WHERE r.policy_id = p.id AND r.from_status = 'awaiting_confirmation' AND r.fault = f.fault
   )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'forfeit policy % has no awaiting_confirmation/% rule to copy', gap.code, gap.fault
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ AN UNCONFIRMED QUOTATION IS NOT A DEBT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `order_status_is_live()` (0049) is the one definition of "this order is a live obligation",
-- mirrored in TypeScript by `NON_LIVE_ORDER_STATUSES` and pinned against Postgres by
-- `tests/orders/contract-drift.pg.test.ts` for every status.
--
-- The new status joins `draft` on the dead side, and that is a statement about money rather
-- than about screens: nobody has been asked to pay this, so it does not belong in the company's
-- ค้างชำระ total, it must not appear under `?payment=outstanding`, and a write-off cannot be
-- requested against it. It is also what keeps "live" and "payable" the same set of statuses,
-- which `payments/slips/attachable.ts` relies on to refuse a slip against an order nobody has
-- been invited to pay.
--
-- ⚠️ ONE CONSEQUENCE WORTH WRITING DOWN, because it is the thing this decision hides. A
-- revision order carries its ancestor's money at submit (`LifecycleService.carryForward`), so
-- once 0054 repoints the submit, a superseding order can stand in `awaiting_confirmation`
-- **already holding money** — and a non-live order's folds are nulled by `encodeOrderSummary`.
-- The money is not lost (it is on the ledger, and `order_held_thb_minor()` reports it), but no
-- staff list surfaces it. The queue bucket below is where that is made visible again.
CREATE OR REPLACE FUNCTION order_status_is_live(p_status text) RETURNS boolean AS $$
  SELECT p_status NOT IN ('draft', 'awaiting_confirmation', 'cancelled', 'superseded');
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- ⓸ THE PAYMENT QUEUE HAS TO SAY SOMETHING TRUE ABOUT A STATUS IT CANNOT ACT ON
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Without this branch an unconfirmed order falls through to `awaiting_customer_transfer` —
-- "waiting for the customer to transfer" — about an order the customer has never been asked to
-- pay. That is the same class of untruth as the payment email this round is fixing, and it
-- would appear on the finance queue rather than in a mailbox.
--
-- Two answers, not one, and the second is the carried-money case the note above names: an
-- unconfirmed revision holding its ancestor's deposit is money the company has, and a bucket
-- saying merely "unconfirmed" would be the only screen able to see it saying nothing about it.
--
-- ⚠️ Everything else here is character-identical to 0048's definition. plpgsql has no ALTER.
CREATE OR REPLACE FUNCTION order_payment_queue_bucket(p_order_id uuid) RETURNS text AS $$
DECLARE
  order_status text;
  held         bigint;
  outstanding  bigint;
BEGIN
  SELECT o.status INTO order_status FROM orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- FIRST. Not after the balance check, not folded into it.
  IF order_status IN ('cancelled', 'superseded') THEN
    held := order_held_thb_minor(p_order_id);
    RETURN CASE WHEN held > 0 THEN 'terminal_holding_money' ELSE 'closed' END;
  END IF;

  -- Before the balance check, for the same reason: what an unconfirmed order "owes" is not a
  -- question the queue may ask, because nobody has been asked for it.
  IF order_status = 'awaiting_confirmation' THEN
    held := order_held_thb_minor(p_order_id);
    RETURN CASE WHEN held > 0 THEN 'unconfirmed_holding_money' ELSE 'awaiting_confirmation' END;
  END IF;

  outstanding := order_outstanding_thb_minor(p_order_id);

  IF outstanding <= 0 THEN
    RETURN 'settled';
  ELSIF EXISTS (SELECT 1 FROM payment_slips s
                 WHERE s.order_id = p_order_id AND s.status = 'submitted') THEN
    RETURN 'awaiting_review';
  END IF;

  RETURN 'awaiting_customer_transfer';
END;
$$ LANGUAGE plpgsql STABLE;
