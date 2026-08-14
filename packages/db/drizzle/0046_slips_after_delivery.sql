-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A DELIVERED ORDER MAY STILL BE PAID. CANCELLED AND SUPERSEDED STILL MAY NOT.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The owner's report, in their words: *"ถ้าส่งมอบไปก่อนเก็บครบ จะเก็บผ่านระบบไม่ได้อีก"* — hand the
-- job over before the balance has been collected and the money can never again be taken
-- through this software. `delivered` has no outgoing transition, so the status cannot be
-- walked back to reach a door that is open; the balance is simply stranded, and the
-- customer's own payment screen has been printing the figure while offering no way to pay it.
--
-- ── ⚠️ WHAT 0011 SAID, AND WHY HALF OF IT STILL STANDS ──────────────────────
--
-- `0011_payment_guards.sql` set this trigger's list with a comment that reads:
--
--     A slip against a `delivered`, `cancelled` or `superseded` order is the one that must
--     be refused — money arriving on a finished contract is a reconciliation exception, not
--     a payment.
--
-- That sentence is not being overruled. It is being **split**, because it names three
-- statuses under one word — "finished" — that they do not in fact share.
--
--   `cancelled` and `superseded` are **dead contracts**. Nothing was owed and nothing will
--     be: the residue on a cancellation is a *refund* question (`src/payments/refunds`) and
--     the residue on a superseded order was carried to the order that replaced it. Money
--     arriving on either is exactly what 0011 called it — a reconciliation exception, and on
--     the cancelled row possibly money owed the other way. **These two keep the refusal, and
--     `apps/api/tests/payments/slips/` asserts they keep it at both levels.**
--
--   `delivered` is a contract **fulfilled**. The customer received the goods; if the balance
--     was not collected on the day, they genuinely owe it, and the company genuinely has a
--     receivable. There is no reconciliation to perform, no direction to be uncertain about,
--     and nobody for the money to be returned to. It is an ordinary payment arriving late.
--
-- 0011 grouped them because the *shape* of the three is alike — all three are statuses with
-- no work left to do — and the shape is not the question. The question is whether the money
-- is owed, and by whom, and on `delivered` both halves of that answer are ordinary.
--
-- ── Why the gate the owner first asked for is not what was built ─────────────
--
-- The proposal was to block the close until the order is paid. Asked when the business
-- collects the balance, the owner answered *"แล้วแต่งาน ไม่ตายตัว"* — it varies by job. A
-- blanket gate would therefore refuse the close on every job of the kind they collect on the
-- day for, and staff would work around it. The per-order form of that gate already exists in
-- the model (`order_instalments.gates_entry_to`) and authoring a schedule per order is an
-- unbuilt seam; neither is this migration. What this does is remove the trap, so a decision
-- made on the day stays a decision and does not become a dead end.
--
-- ── The mechanism, unchanged ────────────────────────────────────────────────
--
-- `order_child_require_status()` (0007) is untouched — the allowed statuses live in `TG_ARGV`,
-- so widening the list is a trigger definition and not a function body. `DROP` then `CREATE`
-- rather than `CREATE OR REPLACE TRIGGER`: both are one transaction here, and the drop states
-- in the migration text that the old list is gone rather than leaving a reader to diff two
-- literals. The order of the statuses follows `SLIP_ATTACHABLE_STATUSES` in
-- `apps/api/src/payments/slips/attachable.ts`, whose service-side copy is compared against
-- this trigger's `action_statement` by `attachable-drift.pg.test.ts` — read out of the live
-- catalogue, so a later migration that moves this list is caught even though 0011's text and
-- this file's never move again.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER "payment_slips_live_orders_only" ON "payment_slips";
--> statement-breakpoint

CREATE TRIGGER payment_slips_live_orders_only
  BEFORE INSERT ON payment_slips
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{awaiting_payment,production_confirmed,in_production,awaiting_installation,delivered,redesign}'
  );
