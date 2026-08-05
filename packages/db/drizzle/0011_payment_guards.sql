-- The money rules that are not tables: nine functions, thirteen triggers, and one seeded
-- forfeit policy that forfeits nothing.
--
-- Same arrangement as drizzle/0007_order_guards.sql, for the same reason: drizzle-kit
-- generates tables, constraints and indexes from src/schema and does not generate
-- triggers, functions, deferred assertions or seed rows. This file is a migration applied
-- by the same `drizzle-kit migrate` in the same order, not a runbook step.
--
-- Everything here is either (a) a rule two concurrent requests could both step over, or
-- (b) a formula that plan 7.13 found written three different ways with three different
-- answers. The second kind is why there are functions in here at all: `scheduledDeposit`
-- got ฿5,530 and ฿18,432 from the same 30/70 order, and the fix is not a better comment,
-- it is one implementation that both SQL and TypeScript call.


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE FOLDS. One implementation each, and never two.
-- ═════════════════════════════════════════════════════════════════════════════

-- Money the company actually holds against this order, by account.
--
-- Every balance in this phase is this function. A balance is a FOLD, never a column: the
-- moment a running total is stored, the stored number and the sum of the entries are two
-- answers to one question and the wrong one is the one on the screen.
--
-- STABLE, not IMMUTABLE — it reads a table, and lying about that would let the planner
-- cache a balance across a statement that changed it.
CREATE FUNCTION order_account_thb_minor(p_order_id uuid, p_account text) RETURNS bigint AS $$
  SELECT coalesce(sum(p.amount_thb_minor), 0)::bigint
    FROM ledger_postings p
   WHERE p.order_id = p_order_id AND p.account = p_account;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ⚠️ `paidMinor` — CASH RECEIVED. Plan 7.13 names this and `settled` as different numbers
-- and this repository is required to say which is which at every site.
--
-- Debits to `bank_thb` are money arriving, so this is positive as money comes in.
CREATE FUNCTION order_cash_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT order_account_thb_minor(p_order_id, 'bank_thb');
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ⚠️ MONEY IN HAND, WHICH IS NOT THE SAME AS CASH — plan 7.8's ⚠️, and the reason it is
-- its own function.
--
-- `deposit_held` is credited (negative) as customer money is received and debited as it is
-- earned, forfeited or refunded, so the amount held is the NEGATIVE of the fold. It is the
-- branch every "have we been paid?" decision must ask, because a revision order carrying
-- money from its ancestor has NO cash leg at all — the cash arrived on the ancestor — and
-- so `order_cash_thb_minor()` on the revision is zero forever. Branching on cash there
-- answers every question wrongly, and answers it consistently, which is worse.
CREATE FUNCTION order_held_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT -order_account_thb_minor(p_order_id, 'deposit_held');
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ⚠️ `settledMinor` — THE FOLD OF ALLOCATIONS, in the instalments' own currency.
--
-- Different from `paidMinor` the first time a bank fee is written off: ฿10,000 leaves the
-- customer, ฿9,970 arrives, and if the reviewer settles the instalment in full then cash
-- is ฿9,970 while settled is ฿10,000 and `settlement_variance` carries the ฿30. Both
-- numbers are right. Which one a screen means has to be said out loud, every time.
--
-- Only ACCEPTED slips count. A submitted slip is a photograph, not money.
CREATE FUNCTION order_settled_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT coalesce(sum(a.amount_thb_minor), 0)::bigint
    FROM order_instalments i
    JOIN slip_allocations a ON a.instalment_id = i.id
    JOIN payment_slips s ON s.id = a.slip_id
   WHERE i.order_id = p_order_id AND s.status = 'accepted';
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- Outstanding balance is DERIVED. Plan 7.5(ข) forbids an `awaiting_balance` status for
-- exactly this reason: a status parallel to `in_production` differing only by a sum is a
-- status that has to be kept in step with a sum, and one day it is not.
CREATE FUNCTION order_outstanding_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT coalesce(o.grand_total_thb_minor, 0) - order_settled_thb_minor(p_order_id)
    FROM orders o WHERE o.id = p_order_id;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE FRONTIER, AND THE GATE THAT CAN CLOSE AGAIN
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ THE FRONTIER IS A `seq`, NEVER A COUNT — plan 7.5(ค).
--
--   settledThrough = MAX(seq) over the settled PREFIX
--   (and MIN(seq) - 1 when nothing is settled)
--
-- The rival formula is `COUNT(*) of settled instalments`, and it is not merely a different
-- style: on a schedule where 1 and 3 are paid and 2 is not, a count says "two" and opens
-- the gate on instalment 2, which nobody paid. The two formulas agree only while `seq` is
-- dense and 1-based — which `order_instalments_dense_seq` below makes true by construction
-- rather than by hoping, precisely so that a future COUNT cannot disagree with this.
--
-- Returns NULL for an order with no schedule. That is honest: there is no frontier on a
-- schedule that does not exist, and 0 would read as "nothing settled yet".
CREATE FUNCTION order_settled_through(p_order_id uuid) RETURNS integer AS $$
  WITH per_instalment AS (
    SELECT i.seq,
           i.due_thb_minor <= coalesce(
             sum(a.amount_thb_minor) FILTER (WHERE s.status = 'accepted'), 0
           ) AS is_settled
      FROM order_instalments i
      LEFT JOIN slip_allocations a ON a.instalment_id = i.id
      LEFT JOIN payment_slips s ON s.id = a.slip_id
     WHERE i.order_id = p_order_id
     GROUP BY i.seq, i.due_thb_minor
  ),
  prefix AS (
    SELECT seq,
           bool_and(is_settled) OVER (
             ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS prefix_settled
      FROM per_instalment
  )
  SELECT coalesce(
           (SELECT max(seq) FROM prefix WHERE prefix_settled),
           (SELECT min(seq) - 1 FROM per_instalment)
         );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ⚠️ "A GATE, ONCE OPEN, NEVER CLOSES" IS FALSE — and this function is why it does not
-- matter.
--
-- A `remainder` instalment cannot be locked, because absorbing recomputation is what it is
-- for (plan 7.5(ง)). So a price rise on an order that was paid in full pushes the
-- remainder above what has been allocated to it, and `order_settled_through()` MOVES
-- BACKWARDS. An order already in production would then be sitting behind a closed gate,
-- and any code that re-checks entitlement would conclude it should never have got there.
--
-- The entitlement is therefore `has already entered this status (the spine) OR the money
-- gate is open right now`. The first half is why `order_events` is a spine and not a log —
-- it is the only thing that can answer "did this ever happen" after the money changed.
--
-- An instalment gating a status the order has already passed does not un-produce it; it
-- becomes an outstanding balance, which is a payment fact and not an order state.
CREATE FUNCTION order_gate_is_open(p_order_id uuid, p_status text) RETURNS boolean AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM order_events e
       WHERE e.order_id = p_order_id AND e.to_status = p_status
    )
    OR NOT EXISTS (
      SELECT 1 FROM order_instalments i
       WHERE i.order_id = p_order_id
         AND i.gates_entry_to = p_status
         AND i.seq > coalesce(order_settled_through(p_order_id), 0)
    );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — THE FORFEIT, BOUNDED BY THE OBLIGATION AND NOT BY THE CASH
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ `forfeitBase = min(received, scheduled_deposit)`, THEN the rate, THEN clamped.
--
-- Plan 7.8's worked example is the whole argument:
--
--   ฿18,432 order · 30% deposit = ฿5,530 · customer pays the whole thing up front,
--   then cancels at awaiting_installation
--     forfeit 100% of cash received  → ฿18,432   three times the agreed obligation
--     forfeit 100% of the obligation → ฿5,530    correct; ฿12,902 goes back
--
-- Bounding by cash alone is not a rounding difference, it is keeping ฿12,902 that was
-- never at risk. `orders.scheduled_deposit_thb_minor` is pinned at submit precisely so
-- this ceiling is a term of the contract and not a number computed at cancellation time,
-- when the schedule may have been edited.
--
-- The final clamp is to money in hand — `order_held_thb_minor()`, not cash — because a
-- revision order holds carried money with no cash leg (plan 7.8's ⚠️), and clamping that
-- to cash would forfeit nothing on every superseded contract in the system.
--
-- Rounding is half-up away from zero on a positive product, which is `(x + 5000) / 10000`.
-- `core`'s `divRoundHalfUp` is the definition; both operands are positive here, so the two
-- agree — and `packages/db/tests/payment.test.ts` pins that they do.
CREATE FUNCTION order_forfeit_thb_minor(
  p_order_id    uuid,
  p_from_status text,
  p_fault       text,
  p_policy_id   uuid
) RETURNS bigint AS $$
DECLARE
  obligation bigint;
  received   bigint;
  base       bigint;
  bp         integer;
BEGIN
  SELECT coalesce(o.scheduled_deposit_thb_minor, 0) INTO obligation
    FROM orders o WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT r.forfeit_bp INTO bp
    FROM forfeit_policy_rules r
   WHERE r.policy_id = p_policy_id AND r.from_status = p_from_status AND r.fault = p_fault;

  IF NOT FOUND THEN
    -- Fail closed and loudly. A missing cell must never mean "forfeit zero" silently:
    -- silence here is a policy nobody wrote being applied to somebody's money.
    RAISE EXCEPTION 'forfeit policy % has no rule for (%, %)', p_policy_id, p_from_status, p_fault
      USING ERRCODE = 'restrict_violation';
  END IF;

  received := order_held_thb_minor(p_order_id);
  base     := least(received, obligation);

  IF base <= 0 THEN
    RETURN 0;
  END IF;

  RETURN least((base * bp + 5000) / 10000, received);
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- Which bucket of the staff queue an order belongs in.
--
-- ⚠️ THE TERMINAL BRANCH IS THE FIRST LINE, AND THAT ORDERING IS THE POINT — plan 7.8.
-- With the outstanding-balance test first, a cancelled order that still holds a deposit
-- reports as "waiting for the customer to transfer" forever, and nobody ever refunds it.
-- Money sitting on a finished order is the bucket that MUST be visible; it is the one a
-- customer eventually telephones about.
CREATE FUNCTION order_payment_queue_bucket(p_order_id uuid) RETURNS text AS $$
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
--> statement-breakpoint

-- Does `p_ancestor` appear in `p_descendant`'s supersedes chain?
--
-- Used by the carry guard. The walk terminates because `orders_guard_update()` makes
-- `supersedes_order_id` immutable, which is what forbids building a cycle — the depth
-- limit below is belt-and-braces against a future migration that relaxes that.
CREATE FUNCTION order_is_ancestor_of(p_ancestor uuid, p_descendant uuid) RETURNS boolean AS $$
DECLARE
  cursor_id uuid := p_descendant;
  hops      integer := 0;
BEGIN
  LOOP
    SELECT o.supersedes_order_id INTO cursor_id FROM orders o WHERE o.id = cursor_id;
    EXIT WHEN cursor_id IS NULL OR hops > 64;
    IF cursor_id = p_ancestor THEN RETURN true; END IF;
    hops := hops + 1;
  END LOOP;

  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — THE SCHEDULE FOOTS, AND A TERMINAL ORDER IS EXEMPT
-- ═════════════════════════════════════════════════════════════════════════════

-- Four assertions about a whole schedule, checked together because they are one idea.
--
--   ⓵ terminal orders are EXEMPT, and must say so. Plan 7.5(ก) is emphatic: without the
--     exemption, cancelling an order that already holds a deposit violates the footing
--     constraint and becomes unrepresentable — unfixable without a migration, on the day
--     somebody needs it. The exemption is a stamp (`closed_at`) and not a special case
--     buried in the assertion, so the reason and the date survive.
--     It runs BOTH WAYS: a live order may not carry a closed schedule either, or "closed"
--     becomes a way to switch the footing rule off.
--
--   ⓶ `seq` is dense from 1 — `min = 1 AND max = count`. This is what makes MAX and COUNT
--     unable to disagree (plan 7.5(ค)) and it is the reason the frontier can be a max.
--
--   ⓷ at most one `remainder`, and it is LAST. The unique index carries "at most one";
--     "last" needs to compare rows and lives here.
--
--   ⓸ SUM(due) = orders.grand_total_thb_minor. ฿8,791 split 50/50 with half_up is
--     ฿4,396 + ฿4,396 = ฿8,792 — over by ฿1 — and the last instalment being the difference
--     is what fixes it. A rule that lives in a service is a rule the next service forgets.
--
-- DEFERRED to commit, so a recompute may renumber, delete and re-insert freely inside its
-- transaction and be judged only on what it leaves behind.
CREATE FUNCTION assert_order_schedule(p_order_id uuid) RETURNS void AS $$
DECLARE
  parent        orders%ROWTYPE;
  closed        timestamptz;
  n             integer;
  min_seq       integer;
  max_seq       integer;
  total_due     bigint;
  remainder_seq integer;
BEGIN
  SELECT * INTO parent FROM orders WHERE id = p_order_id;
  -- Gone in this transaction: this is the cascade from a delete the order rules allowed.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*), min(i.seq), max(i.seq), sum(i.due_thb_minor)
    INTO n, min_seq, max_seq, total_due
    FROM order_instalments i WHERE i.order_id = p_order_id;

  IF n = 0 THEN RETURN; END IF;  -- No schedule yet. A draft cart owes nothing.

  SELECT s.closed_at INTO closed FROM order_payment_schedules s WHERE s.order_id = p_order_id;

  -- ⓵
  IF parent.status IN ('cancelled', 'superseded') THEN
    IF closed IS NULL THEN
      RAISE EXCEPTION 'order % is % and its payment schedule must be closed', p_order_id, parent.status
        USING ERRCODE = 'restrict_violation',
              HINT = 'set order_payment_schedules.closed_at in the same transaction as the cancellation';
    END IF;

    RETURN;  -- Exempt. The money it still holds is a refund question, not a footing one.
  END IF;

  IF closed IS NOT NULL THEN
    RAISE EXCEPTION 'order % is % but its payment schedule is closed', p_order_id, parent.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ⓶
  IF min_seq <> 1 OR max_seq <> n THEN
    RAISE EXCEPTION 'order % has instalment seq up to % over % rows; seq must be dense from 1',
      p_order_id, max_seq, n
      USING ERRCODE = 'restrict_violation',
            HINT = 'MAX(seq) and COUNT(*) disagree the moment there is a hole, and the frontier is a MAX';
  END IF;

  -- ⓷
  SELECT i.seq INTO remainder_seq
    FROM order_instalments i WHERE i.order_id = p_order_id AND i.basis = 'remainder';

  IF FOUND AND remainder_seq <> max_seq THEN
    RAISE EXCEPTION 'order % has its remainder instalment at seq % of %; it absorbs the difference and must be last',
      p_order_id, remainder_seq, max_seq
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ⓸
  IF parent.grand_total_thb_minor IS NULL THEN
    RAISE EXCEPTION 'order % has a schedule but no total to foot to', p_order_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF total_due <> parent.grand_total_thb_minor THEN
    RAISE EXCEPTION 'order % schedules % but its grand total is %',
      p_order_id, total_due, parent.grand_total_thb_minor
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION order_instalments_assert() RETURNS trigger AS $$
BEGIN
  -- Explicit branches, not `CASE TG_OP … NEW.order_id`: on a DELETE the NEW record is
  -- unassigned, and plpgsql resolves the field reference whether or not the branch is taken.
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_order_schedule(OLD.order_id);
  ELSE
    PERFORM assert_order_schedule(NEW.order_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER order_instalments_dense_seq
  AFTER INSERT OR UPDATE OR DELETE ON order_instalments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_instalments_assert();
--> statement-breakpoint

-- The same assertion, from the other two directions. A schedule stops footing either
-- because the instalments moved, or because the TOTAL moved (a 5c quote edit), or because
-- the order became terminal — and only the first of those touches order_instalments.
CREATE FUNCTION order_payment_schedules_assert() RETURNS trigger AS $$
BEGIN
  PERFORM assert_order_schedule(NEW.order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER order_payment_schedules_assert
  AFTER INSERT OR UPDATE ON order_payment_schedules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_payment_schedules_assert();
--> statement-breakpoint

CREATE FUNCTION orders_assert_schedule() RETURNS trigger AS $$
BEGIN
  PERFORM assert_order_schedule(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER orders_assert_schedule
  AFTER UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_assert_schedule();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS LOCKED WHEN MONEY ARRIVES — plan 7.5(ง)
--
-- An instalment money has touched has its `due` locked. The `remainder` is the exception
-- and it is not an oversight: it is *defined* as the absorber, and locking it would make
-- every recompute after the first payment impossible — which is the same as saying the
-- price may never change after a deposit, on orders that spend weeks in `redesign`.
--
-- The second rule is the one that keeps the first honest: no instalment's `due` may fall
-- below what has already been allocated to it. Plan 7.5(ง)(4) and 7.10 both say the same
-- thing — a reduction below money already received is a REFUND, not a smaller instalment —
-- and without this the remainder simply absorbs itself negative and the refund never
-- happens.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION order_instalments_guard_write() RETURNS trigger AS $$
DECLARE
  allocated bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT coalesce(sum(a.amount_thb_minor), 0) INTO allocated
      FROM slip_allocations a WHERE a.instalment_id = OLD.id;

    IF allocated > 0 THEN
      RAISE EXCEPTION 'instalment % of order % has % allocated to it and cannot be removed',
        OLD.seq, OLD.order_id, allocated
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
  END IF;

  IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'an instalment belongs to the order it was scheduled on'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(a.amount_thb_minor), 0) INTO allocated
    FROM slip_allocations a WHERE a.instalment_id = OLD.id;

  IF allocated = 0 THEN
    RETURN NEW;  -- Untouched by money. Recompute it freely.
  END IF;

  IF OLD.basis <> 'remainder' AND NEW.due_thb_minor IS DISTINCT FROM OLD.due_thb_minor THEN
    RAISE EXCEPTION 'instalment % of order % has been paid against and its amount is fixed at %',
      OLD.seq, OLD.order_id, OLD.due_thb_minor
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.due_thb_minor < allocated THEN
    RAISE EXCEPTION 'instalment % of order % already holds %; reducing it to % is a refund, not a schedule edit',
      OLD.seq, OLD.order_id, allocated, NEW.due_thb_minor
      USING ERRCODE = 'restrict_violation',
            HINT = 'plan 7.5(ง)(4): never let an instalment go negative — open a refund';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER order_instalments_guard_write
  BEFORE UPDATE OR DELETE ON order_instalments
  FOR EACH ROW EXECUTE FUNCTION order_instalments_guard_write();
--> statement-breakpoint

-- Trap 6's mechanism, reused exactly as 0007 predicted it would be — one line in a
-- migration rather than a second copy of the reasoning. A schedule is written while the
-- quote is still editable; `redesign` is in the list because plan 7.5(ง) says the
-- recompute service must accept it and a bounce from the factory always lands there.
CREATE TRIGGER order_instalments_live_orders_only
  BEFORE INSERT ON order_instalments
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{draft,awaiting_payment,redesign}'
  );
--> statement-breakpoint

-- ⚠️ AND THE SAME MECHANISM WITH A DIFFERENT LIST FOR SLIPS. 0007 guessed
-- `'{awaiting_payment}'` for this, and the guess is WRONG the moment there is a deposit:
-- the balance instalment is transferred while the order is already in production. A slip
-- against a `delivered`, `cancelled` or `superseded` order is the one that must be refused
-- — money arriving on a finished contract is a reconciliation exception, not a payment.
CREATE TRIGGER payment_slips_live_orders_only
  BEFORE INSERT ON payment_slips
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status(
    'order_id',
    '{awaiting_payment,production_confirmed,in_production,awaiting_installation,redesign}'
  );
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — A SLIP'S ALLOCATIONS SUM TO THE SLIP
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ WITHOUT THIS, A REVIEWER SETTLES INSTALMENTS WITH MONEY THAT NEVER ARRIVED.
--
-- Plan 7.8 lists it as a CHECK and not a matter of discipline, and the reason it is easy
-- to miss is that every row involved is individually valid: the slip is a real slip, the
-- allocation is a positive number against a real instalment, and nothing referential is
-- broken. The only thing wrong is the total, and totals are exactly what a foreign key
-- cannot see.
--
-- Deferred, because one slip is allocated across two instalments in two statements and the
-- first of them is legitimately short.
--
-- Both directions are asserted:
--   accepted  → allocations sum to the slip's amount, exactly.
--   otherwise → no allocations at all. A rejected slip that still settles an instalment is
--               the same hole with a different label on it.
CREATE FUNCTION assert_slip_allocations(p_slip_id uuid) RETURNS void AS $$
DECLARE
  slip      payment_slips%ROWTYPE;
  allocated bigint;
BEGIN
  SELECT * INTO slip FROM payment_slips WHERE id = p_slip_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(sum(a.amount_thb_minor), 0) INTO allocated
    FROM slip_allocations a WHERE a.slip_id = p_slip_id;

  IF slip.status = 'accepted' THEN
    IF allocated <> slip.amount_thb_minor THEN
      RAISE EXCEPTION 'slip % is for % but % is allocated from it',
        p_slip_id, slip.amount_thb_minor, allocated
        USING ERRCODE = 'restrict_violation',
              HINT = 'an accepted slip settles exactly the money it is evidence of';
    END IF;
  ELSIF allocated <> 0 THEN
    RAISE EXCEPTION 'slip % is % and cannot settle anything, but % is allocated from it',
      p_slip_id, slip.status, allocated
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION slip_allocations_assert() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_slip_allocations(OLD.slip_id);
  ELSE
    PERFORM assert_slip_allocations(NEW.slip_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER slip_allocations_foot
  AFTER INSERT OR UPDATE OR DELETE ON slip_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION slip_allocations_assert();
--> statement-breakpoint

CREATE FUNCTION payment_slips_assert_allocations() RETURNS trigger AS $$
BEGIN
  PERFORM assert_slip_allocations(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The other direction: accepting a slip with nothing allocated must fail too, and that
-- write never touches slip_allocations.
CREATE CONSTRAINT TRIGGER payment_slips_allocations_foot
  AFTER INSERT OR UPDATE ON payment_slips
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_slips_assert_allocations();
--> statement-breakpoint

-- Where an allocation is allowed to point, and what carrying money looks like.
--
-- Plan 7.8: money carried to a revision order is an ALLOCATION REFERENCING THE ANCESTOR,
-- never a new instalment row on the new order. As an instalment row, the old order goes on
-- folding its own slips forever and reports the same ฿5,530 the new order reports — two
-- internally consistent reports of one payment, which is the hardest kind of wrong to find.
CREATE FUNCTION slip_allocations_guard_write() RETURNS trigger AS $$
DECLARE
  slip_order       uuid;
  slip_status      text;
  instalment_order uuid;
  previous_order   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.status INTO slip_status FROM payment_slips s WHERE s.id = OLD.slip_id;

    IF slip_status = 'accepted' THEN
      RAISE EXCEPTION 'allocation % belongs to an accepted slip and is evidence, not a draft', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
  END IF;

  SELECT s.order_id, s.status INTO slip_order, slip_status
    FROM payment_slips s WHERE s.id = NEW.slip_id;
  SELECT i.order_id INTO instalment_order FROM order_instalments i WHERE i.id = NEW.instalment_id;

  /*
   * ⚠️ CARRYING MONEY IS A **MOVE**, NOT A SECOND ALLOCATION.
   *
   * This is stricter than plan 7.8 says and it has to be, because the plan's two rules
   * collide head-on and the collision only shows up when both are implemented:
   *
   *   `SUM(allocations) = slip.amount` for an accepted slip   (plan 7.8)
   *   money carried to a revision is an allocation on the ancestor's slip   (plan 7.8)
   *
   * Adding a second allocation row for the revision doubles the sum, so the footing
   * assertion refuses it — and it refuses it for the right reason: two allocation rows IS
   * the same payment counted twice, which is the exact failure the "not an instalment row"
   * rule exists to prevent. It just wears a different table.
   *
   * So the ancestor's allocation MOVES onto the revision's instalment. One payment, one
   * allocation row, forever, and the ancestor's settled fold correctly drops to zero
   * because its money is no longer on it. Where the money has been lives in the ledger,
   * which is append-only, and in `carried_from_order_id`.
   *
   * The move is only ever forward: to an instalment of a DESCENDANT order, with the amount
   * and the slip unchanged.
   */
  IF TG_OP = 'UPDATE' AND slip_status = 'accepted' THEN
    IF NEW.amount_thb_minor IS DISTINCT FROM OLD.amount_thb_minor
       OR NEW.slip_id IS DISTINCT FROM OLD.slip_id THEN
      RAISE EXCEPTION 'allocation % is evidence of %; carrying it forward does not change it',
        OLD.id, OLD.amount_thb_minor
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.instalment_id IS DISTINCT FROM OLD.instalment_id THEN
      SELECT i.order_id INTO previous_order FROM order_instalments i WHERE i.id = OLD.instalment_id;

      IF NOT order_is_ancestor_of(previous_order, instalment_order) THEN
        RAISE EXCEPTION 'order % is not a revision of order %; settled money moves forward or not at all',
          instalment_order, previous_order
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  IF slip_order IS NULL OR instalment_order IS NULL THEN
    RAISE EXCEPTION 'allocation names a slip or instalment that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF slip_order = instalment_order THEN
    IF NEW.carried_from_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'the slip already belongs to order %; nothing is being carried', slip_order
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- Cross-order: this is a carry, and it has to say so.
  IF NEW.carried_from_order_id IS DISTINCT FROM slip_order THEN
    RAISE EXCEPTION 'slip belongs to order % but the allocation claims to carry from %',
      slip_order, NEW.carried_from_order_id
      USING ERRCODE = 'restrict_violation',
            HINT = 'carried money must name the ancestor it came from — plan 7.8';
  END IF;

  IF NOT order_is_ancestor_of(slip_order, instalment_order) THEN
    RAISE EXCEPTION 'order % is not an ancestor of order %; money does not move sideways',
      slip_order, instalment_order
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER slip_allocations_guard_write
  BEFORE INSERT OR UPDATE OR DELETE ON slip_allocations
  FOR EACH ROW EXECUTE FUNCTION slip_allocations_guard_write();
--> statement-breakpoint

-- A slip is evidence. Once reviewed it is frozen whole — plan 7.6's two-column comparison
-- has no meaning if the left-hand column can be edited after the decision.
--
-- The status may still move `submitted → accepted|rejected` and nowhere else. A review
-- that could be re-opened is a review, singular, that happens as many times as necessary
-- to get the answer somebody wanted.
CREATE FUNCTION payment_slips_guard_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'slip % is evidence of a payment and cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'to remove the image for PDPA, clear storage_key and stamp storage_key_erased_at';
  END IF;

  IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'a slip belongs to the order it was uploaded against'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'submitted' THEN
    -- Frozen, with two deliberate exceptions: the PDPA erasure of the image, and
    -- `updated_at`. Everything the reviewer looked at stays as it was.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.amount_thb_minor IS DISTINCT FROM OLD.amount_thb_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.transferred_at IS DISTINCT FROM OLD.transferred_at
       OR NEW.bank_reference IS DISTINCT FROM OLD.bank_reference
       OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.rejected_reason_th IS DISTINCT FROM OLD.rejected_reason_th
    THEN
      RAISE EXCEPTION 'slip % was reviewed at % and is frozen', OLD.id, OLD.reviewed_at
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.storage_key IS DISTINCT FROM OLD.storage_key AND NEW.storage_key IS NOT NULL THEN
      RAISE EXCEPTION 'the image of reviewed slip % may be erased, not replaced', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('submitted', 'accepted', 'rejected') THEN
    RAISE EXCEPTION 'a slip goes from submitted to accepted or rejected, not to %', NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payment_slips_guard_write
  BEFORE UPDATE OR DELETE ON payment_slips
  FOR EACH ROW EXECUTE FUNCTION payment_slips_guard_write();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — THE LEDGER IS APPEND-ONLY AND EVERY ENTRY BALANCES
-- ═════════════════════════════════════════════════════════════════════════════

-- Same rule as the spine and a published catalogue document, for the same reason: every
-- balance in this phase is a fold over these rows, so a row that can be rewritten makes
-- every balance a claim rather than a derivation. A correction is a REVERSING ENTRY, which
-- is what accountants do anyway and which leaves both facts visible.
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; correct it with a reversing entry', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint

CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint

-- Two legs at least, and they sum to zero. Deferred because an entry and its legs are
-- three statements and the first two never balance.
--
-- One-legged entries are how a double-entry ledger stops being one: money appears in
-- `revenue` with nowhere it came from, every account still looks plausible on its own, and
-- the only symptom is that the trial balance does not.
CREATE FUNCTION assert_ledger_entry_balances(p_entry_id uuid) RETURNS void AS $$
DECLARE
  legs  integer;
  total bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE id = p_entry_id) THEN
    RETURN;
  END IF;

  SELECT count(*), coalesce(sum(p.amount_thb_minor), 0) INTO legs, total
    FROM ledger_postings p WHERE p.entry_id = p_entry_id;

  IF legs < 2 THEN
    RAISE EXCEPTION 'ledger entry % has % leg(s); a movement of money has two ends', p_entry_id, legs
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger entry % is out of balance by %', p_entry_id, total
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Two thin wrappers rather than one function branching on TG_TABLE_NAME. plpgsql resolves
-- `NEW.<column>` when the function is COMPILED, not when the branch is taken, so a single
-- function reading `NEW.entry_id` on one side and `NEW.id` on the other fails with
-- "record new has no field entry_id" — on whichever table it is attached to second.
CREATE FUNCTION ledger_entries_assert_balance() RETURNS trigger AS $$
BEGIN
  PERFORM assert_ledger_entry_balances(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION ledger_postings_assert_balance() RETURNS trigger AS $$
BEGIN
  PERFORM assert_ledger_entry_balances(NEW.entry_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_assert_balance();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_postings_balance
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_assert_balance();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — A REFUND'S AMOUNT AND PAYEE FREEZE WHEN IT LEAVES `requested`
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ OTHERWISE APPROVING APPROVES NOTHING — plan 7.12, and it is the sharpest finding of
-- the round:
--
--   approve ฿3,594 → UPDATE the row to ฿359,400 and change the destination account
--
-- Both the amount and every payee column freeze, together, the moment the status leaves
-- `requested`. Freezing only the amount would leave the money going to a different bank
-- account, which is the half a reviewer is least likely to re-check.
--
-- The status itself still moves — `requested → approved|rejected`, `approved → disbursed`
-- — and nothing returns to `requested`. A refund that could be sent back for editing would
-- make the freeze a lock with the key hanging beside it.
CREATE FUNCTION refunds_guard_write() RETURNS trigger AS $$
DECLARE
  in_transit bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund % is an accounting record', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'requested' THEN
    IF NEW.amount_thb_minor IS DISTINCT FROM OLD.amount_thb_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.accrual_entry_id IS DISTINCT FROM OLD.accrual_entry_id
       OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
       OR NEW.payee_bank_code IS DISTINCT FROM OLD.payee_bank_code
       OR NEW.payee_account_last4 IS DISTINCT FROM OLD.payee_account_last4
       OR NEW.payee_is_original_account IS DISTINCT FROM OLD.payee_is_original_account
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    THEN
      RAISE EXCEPTION 'refund % left `requested`; its amount and payee are what was approved', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected'))
      OR (OLD.status = 'approved' AND NEW.status = 'disbursed')
    ) THEN
      RAISE EXCEPTION 'a refund does not go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Plan 7.11: never pay real cash out against money that has not landed. An accepted
    -- slip for a cross-border transfer sits in `remittance_in_transit` for one to two
    -- working days, and a refund disbursed in that window is the company's own money.
    IF NEW.status = 'disbursed' THEN
      in_transit := order_account_thb_minor(NEW.order_id, 'remittance_in_transit');

      IF in_transit <> 0 THEN
        RAISE EXCEPTION 'order % still has % in remittance_in_transit; a refund cannot be paid against money that has not landed',
          NEW.order_id, in_transit
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER refunds_guard_write
  BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_guard_write();
--> statement-breakpoint

-- The amount is the obligation, not a figure somebody typed beside one.
--
-- Plan 7.12(1): `accrual_event_id NOT NULL` plus a CHECK that the amount equals what was
-- accrued. Here the accrual is a ledger entry, so the check is against its `refund_payable`
-- leg — credited, therefore negative, therefore negated here. Deferred, because the entry,
-- its legs and the refund row are written in one transaction and the refund may go first.
CREATE FUNCTION refunds_assert_accrual() RETURNS trigger AS $$
DECLARE
  accrued bigint;
BEGIN
  SELECT -coalesce(sum(p.amount_thb_minor), 0) INTO accrued
    FROM ledger_postings p
   WHERE p.entry_id = NEW.accrual_entry_id AND p.account = 'refund_payable';

  IF accrued <> NEW.amount_thb_minor THEN
    RAISE EXCEPTION 'refund % is for % but entry % accrued % into refund_payable',
      NEW.id, NEW.amount_thb_minor, NEW.accrual_entry_id, accrued
      USING ERRCODE = 'restrict_violation',
            HINT = 'a refund is the payment of a recorded obligation, not a number beside one';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER refunds_match_accrual
  AFTER INSERT OR UPDATE ON refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refunds_assert_accrual();
--> statement-breakpoint

-- An approval, once given, is a fact about the past.
CREATE FUNCTION approvals_guard_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval % is the record that somebody authorised this', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval % was decided at % by %', OLD.id, OLD.decided_at, OLD.decided_by_user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.order_document_id IS DISTINCT FROM OLD.order_document_id
     OR NEW.dimension IS DISTINCT FROM OLD.dimension
     OR NEW.concession_thb_minor IS DISTINCT FROM OLD.concession_thb_minor
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
  THEN
    RAISE EXCEPTION 'what is being approved cannot change while it is being approved'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER approvals_guard_write
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_guard_write();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 8 — THE FORFEIT TABLE IS DENSE, OR THE POLICY IS NOT USABLE
-- ═════════════════════════════════════════════════════════════════════════════

-- Plan 7.8: every (cancellable status × fault), and 🚫 NO `'ANY'` WILDCARD.
--
-- A wildcard is a value no CHECK can define. Does `('in_production','ANY')` beat
-- `('in_production','customer')`? Does `('ANY','customer')` beat either? Every answer is
-- somebody's refund, and the row that decides it looks the same in all three designs.
--
-- The coverage set is read from `order_status_transitions` and NOT from a list in this
-- file, so a seventh cancellable status added by a future migration makes every effective
-- policy incomplete at once — loudly, at commit — instead of quietly forfeiting nothing
-- from a status nobody remembered to price.
CREATE FUNCTION assert_forfeit_policy_complete(p_policy_id uuid) RETURNS void AS $$
DECLARE
  missing text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM forfeit_policies p WHERE p.id = p_policy_id AND p.effective_from IS NOT NULL
  ) THEN
    RETURN;  -- Still being written. Incomplete is what "draft" means.
  END IF;

  SELECT string_agg(cell.from_status || '/' || cell.fault, ', ' ORDER BY cell.from_status, cell.fault)
    INTO missing
    FROM (
      SELECT DISTINCT t.from_status, f.fault
        FROM order_status_transitions t
        CROSS JOIN (VALUES ('customer'), ('company')) AS f(fault)
       WHERE t.to_status = 'cancelled'
    ) AS cell
   WHERE NOT EXISTS (
     SELECT 1 FROM forfeit_policy_rules r
      WHERE r.policy_id = p_policy_id
        AND r.from_status = cell.from_status
        AND r.fault = cell.fault
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'forfeit policy % is effective but has no rule for: %', p_policy_id, missing
      USING ERRCODE = 'restrict_violation',
            HINT = 'every cancellable status × fault, and no ANY wildcard — plan 7.8';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION forfeit_policy_rules_assert() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_forfeit_policy_complete(OLD.policy_id);
  ELSE
    PERFORM assert_forfeit_policy_complete(NEW.policy_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER forfeit_policy_rules_complete
  AFTER INSERT OR UPDATE OR DELETE ON forfeit_policy_rules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION forfeit_policy_rules_assert();
--> statement-breakpoint

CREATE FUNCTION forfeit_policies_assert() RETURNS trigger AS $$
BEGIN
  PERFORM assert_forfeit_policy_complete(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The other direction: making a half-written policy effective must fail too.
CREATE CONSTRAINT TRIGGER forfeit_policies_complete
  AFTER INSERT OR UPDATE ON forfeit_policies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION forfeit_policies_assert();
--> statement-breakpoint


-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ THE ONLY POLICY THAT EXISTS ON DAY ONE — A DEFAULT, NOT A DECISION.
--
-- Plan 13, the forfeit row: "ริบ 0 ทุกช่อง = คืนเต็มเสมอ · ปลอดภัยกับลูกค้า แต่ต้องรู้ตัวว่ากำลัง
-- ship แบบนี้". Every cell is zero. Every cancellation refunds in full, from every status,
-- whoever is at fault, including one cancelled the hour before delivery.
--
-- That is a real exposure and it is shipped deliberately, because the alternative is an
-- invented percentage presented as though somebody had agreed to it — which plan 13 exists
-- to prevent, and which this table would make look official.
--
-- Two of the twelve zeroes are NOT defaults and cannot be changed by data entry:
-- `production_confirmed` (nothing has been cut yet) and every `company`-fault cell (the
-- company's mistake is not the customer's cost) are held at zero by CHECK constraints.
-- The other ten are the owner's to answer.
--
-- An empty table would be worse than this one. Plan 13's rule for the whole page is that
-- every default must have a defined behaviour on day one, and `order_forfeit_thb_minor()`
-- raises rather than assuming zero when a cell is missing — so "no policy" fails closed
-- and loudly, while "the plan's policy" refunds in full and says why.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO forfeit_policies (id, code, description_th, effective_from)
VALUES (
  '00000000-0000-4000-8000-0000000f0001',
  'plan13_default',
  'ค่าตั้งต้นตามแผนข้อ 13 — ริบ 0 ทุกช่อง คืนเต็มเสมอ · รอคำตอบจากเจ้าของกิจการ',
  now()
);
--> statement-breakpoint

INSERT INTO forfeit_policy_rules (policy_id, from_status, fault, forfeit_bp, note_th)
SELECT '00000000-0000-4000-8000-0000000f0001', cell.from_status, cell.fault, 0,
       CASE
         WHEN cell.from_status = 'production_confirmed'
           THEN 'ยังไม่มีอะไรถูกตัด — บังคับเป็น 0 ด้วย CHECK ไม่ใช่ค่าตั้งต้น'
         WHEN cell.fault = 'company'
           THEN 'ความผิดของบริษัทไม่ใช่ต้นทุนของลูกค้า — บังคับเป็น 0 ด้วย CHECK'
         ELSE 'ค่าตั้งต้นข้อ 13 — รอคำตอบจากเจ้าของกิจการ'
       END
  FROM (
    SELECT DISTINCT t.from_status, f.fault
      FROM order_status_transitions t
      CROSS JOIN (VALUES ('customer'), ('company')) AS f(fault)
     WHERE t.to_status = 'cancelled'
  ) AS cell;
