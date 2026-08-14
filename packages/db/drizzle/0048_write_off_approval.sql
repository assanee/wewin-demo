-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ ขออนุมัติตัดยอดค้างทิ้ง — FORGIVING A DEBT IS A THIRD FOLD, NOT A PAYMENT.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The owner's fifth payment requirement was *"กระบวนการขอแบบยืดหยุ่นเพื่อให้รองรับสถานการณ์
-- ที่คาดไม่ถึง"*, and asked what would actually be requested they chose
-- **ขออนุมัติตัดยอดค้างทิ้ง**: the customer will not pay, or a settlement was agreed halfway,
-- or the remainder is not worth chasing. Somebody with authority forgives what is left.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓵ THREE FOLDS, NOT TWO — AND THE REASON IS ONE WORD MEANING ONE THING
-- ═════════════════════════════════════════════════════════════════════════════
--
-- An approved write-off must make the outstanding balance fall. There are two ways to make
-- that happen and only one of them is honest:
--
--   ✗ fold it into `order_settled_thb_minor()`. Two lines above that function, in
--     `0011_payment_guards.sql`, is the sentence *"Only ACCEPTED slips count. A submitted slip
--     is a photograph, not money."* — settled means **money that arrived**. The overview's
--     "received this month" card reads accepted slips; `order_cash_thb_minor()` reads postings.
--     A forgiveness inside `settled` would make one word mean *money we got* and *money we
--     agreed never to get*, and the day the owner asks how much was written off this year the
--     answer would be unrecoverable — there is no column to subtract.
--
--   ✓ a fold of its own, subtracted alongside it.
--
--       outstanding = grand_total − settled − written_off
--
-- `order_settled_thb_minor()` is **not touched by this migration** and means exactly what it
-- meant this morning. Nothing about cash, held money or the ledger moves either: a write-off
-- posts no ledger entry, because no money changes hands.
--
-- ⚠️ THE FOLD HAS SEVEN READERS AND THEY ALL CHANGE AT ONCE. That is the intent, and every one
-- was verified rather than assumed:
--
--     GET /orders                       `scoped-order.ts` OUTSTANDING_FOLD — the ค้างชำระ column
--     GET /orders?payment=outstanding   the same fold in the WHERE and the ORDER BY, so a
--                                       fully-written-off order LEAVES the debt filter
--     GET /orders/:id                   the same row, the money card's ค้างชำระ
--     GET /orders/:id/payment-instructions
--                                       `ledger.repository.ts money()` — the customer's screen
--     GET /overview                     the aggregate and its top-eight breakdown, both of
--                                       which filter `> 0`, so the order drops out of both
--     order_payment_queue_bucket()      returns 'settled' once nothing is left owing
--     the transition-balance notice     `transition-balance.ts`, from the same wire field
--
-- ── ⚠️ WHY `dimension = 'cashflow'` IS NOT ENOUGH ON ITS OWN ─────────────────
--
-- A write-off draws on the `cashflow` ceiling — forgiving cash the company is owed is a
-- cashflow act, and `authority_limits` already carries the row. But `cashflow` is **already
-- spoken for**: `apps/api/src/quotes/authority/concession.ts` measures a `cashflow` concession
-- at *quote* time — `gate_below_floor`, a schedule that gates less before production than
-- `organisation_profile.deposit_bp` requires — and `POST /quotes/approvals` will happily
-- record and approve one today (an order predating `orders.deposit_floor_bp` whose live policy
-- has since risen measures a concession, and the endpoint accepts `dimension: 'cashflow'`).
--
-- So a fold defined as *"approved cashflow approvals"* would count an approved **deposit
-- schedule** as forgiven debt and silently reduce a live balance by it. That is the identical
-- failure the ✗ arm above rejects, one table along: one value meaning two things. Hence
-- `kind`, which names the mechanism, beside `dimension`, which names the budget it draws on.
--
-- ── ⚠️ AND WHAT A WRITE-OFF DOES TO `order_next_due_thb_minor()` ─────────────
--
-- 0042 folds **per instalment** and never read the outstanding. So forgiving a balance left
-- every instalment's `due_thb_minor` exactly where it was, and a screen could ask for a
-- next-due larger than the whole remaining debt — ฿5,000 "งวดถัดไปต้องการ" under ฿0.00
-- ค้างชำระ. That is a defect whichever number the reader believes.
--
-- The fix is a cap and deliberately **not** an allocation. Nothing in the data says which
-- instalment a write-off forgives — the request names an amount and a reason, not a `seq` —
-- so spreading it across the schedule would be inventing an allocation, and one that
-- `order_settled_through()` would then read as a settled prefix and open a production gate on.
-- What is knowable is the bound: **nobody may be asked for more than the whole remaining
-- debt.** `least(…, outstanding)` says exactly that and nothing more.
--
-- ⚠️ It also changes one case that has nothing to do with write-offs, stated rather than
-- hidden: a reviewer who allocates a slip to instalment 2 while instalment 1 is unpaid leaves
-- the first shortfall larger than the total debt (฿10,000 total, ฿5,000+฿5,000, ฿8,000 all
-- allocated to seq 2 → shortfall ฿5,000, outstanding ฿2,000). That was already wrong and this
-- caps it too. `greatest(0, …)` because the outstanding is negative on an overpaid order,
-- which is a modelled state (see 0011) and not a debt to invert.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ AND THE GUARD THAT WAS MISSING: A CONCESSION LARGER THAN THE BALANCE OWED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Nothing stopped approving a ฿50,000 concession against a ฿10,000 debt. Harmless while a
-- concession was only ever *compared* against a ceiling; not harmless the moment one is
-- **subtracted from a balance**, because the result is a negative outstanding — which every
-- screen in this system reads as *settled*, and which the refund module would price a payable
-- from.
--
-- It is closed here and not only in the service, because the service is not the only writer:
-- `db:seed`, a psql session, a future worker. A CHECK cannot do it — the balance lives in
-- three other tables — so it is a trigger, and it fires at **both** moments money is at stake:
--
--   the ask        `NEW.concession_thb_minor > outstanding` is refused outright. A request that
--                  could never be granted is not a queue item, it is a trap for an approver.
--   the yes        the write-off is already inside the fold by then, so the rule is simply
--                  **the outstanding may not go negative**.
--
-- ⚠️ Both are needed and neither implies the other. The balance MOVES between them — a
-- customer may transfer part of what they owe while the request sits in the inbox — so a
-- request that was valid on Monday can be an over-write-off by Wednesday. The service refuses
-- that approval with a Thai sentence and this trigger is what makes the refusal true.
--
-- ⚠️ **AFTER, not BEFORE**, and that is load-bearing. A BEFORE ROW trigger's queries run on
-- the snapshot from the start of the statement, so the row being approved is still `pending`
-- and invisible to the fold — and worse, one statement approving two write-offs on one order
-- would see neither of the other's change and let both through. AFTER ROW triggers fire once
-- the statement's rows are all written, so the fold this reads includes every row the
-- statement touched. The exception still rolls the statement back.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⓷ WHAT IS NOT WEAKENED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every guard on `approvals` stands, and `approvals_guard_write()` is restated in full below
-- so that this file says so rather than implying it — four-eyes, the ceiling shape, the
-- ceiling covering the concession, a positive concession, the hex revision, one open request
-- per order per dimension. The frozen-column list **grows** here by `kind`: a request that
-- could be turned from a deposit schedule into a debt forgiveness while an approver was
-- reading it is the whole two-person rule defeated by an UPDATE.

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓵ `kind` — which mechanism this approval is, beside which budget it draws on
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `DEFAULT 'quote_concession'` and `NOT NULL` in one statement, so the one existing row (and
-- every row any test fixture has already written) becomes what it has always been: a
-- concession measured from a quote. Postgres 11+ adds a defaulted NOT NULL column without
-- rewriting the table.
ALTER TABLE "approvals"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'quote_concession';
--> statement-breakpoint

ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_kind_known"
  CHECK ("kind" in ('quote_concession', 'write_off'));
--> statement-breakpoint

-- A write-off forgives cash the company is owed, so it draws on the `cashflow` ceiling and on
-- no other. Without this, a `margin` write-off would be a debt forgiven out of the discount
-- budget — and `order_written_off_thb_minor()` below, which reads both columns, would not see
-- it at all: the money would vanish from the balance-guard's arithmetic while still being
-- forgiven. Refused at the row, where it is one comparison.
ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_write_off_is_cashflow"
  CHECK ("kind" <> 'write_off' OR "dimension" = 'cashflow');
--> statement-breakpoint

-- The audit answer to *"how much did we write off this year?"*, which is the question that
-- makes folding this into `settled` unacceptable. Highly selective — a handful of rows in a
-- table that grows with every quote — so a partial index is a scan of the exceptions.
CREATE INDEX "approvals_write_off_idx"
  ON "approvals" ("decided_at" DESC)
  WHERE "kind" = 'write_off' AND "status" = 'approved';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓵ THE THIRD FOLD
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Only **approved** rows. A pending request has forgiven nothing — it is a question — and a
-- rejected one forgave nothing either. This is the same rule `order_settled_thb_minor()`
-- applies to a slip: *"a submitted slip is a photograph, not money."*
--
-- Both `kind` and `dimension` are in the WHERE even though `approvals_write_off_is_cashflow`
-- makes the second redundant today. It is not decoration: this function is the definition of
-- forgiven money, and it must keep meaning that if a later migration ever widens which
-- dimensions a write-off may draw on. A fold that agreed with a CHECK by accident is a fold
-- that stops agreeing silently.
CREATE FUNCTION order_written_off_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT coalesce(sum(a.concession_thb_minor), 0)::bigint
    FROM approvals a
   WHERE a.order_id = p_order_id
     AND a.kind = 'write_off'
     AND a.dimension = 'cashflow'
     AND a.status = 'approved';
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- The one definition of "what is still owed", now with three terms.
--
-- ⚠️ `order_settled_thb_minor()` is deliberately still the middle term and still means money
-- that arrived. Nothing about it changes here.
CREATE OR REPLACE FUNCTION order_outstanding_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  SELECT coalesce(o.grand_total_thb_minor, 0)
       - order_settled_thb_minor(p_order_id)
       - order_written_off_thb_minor(p_order_id)
    FROM orders o WHERE o.id = p_order_id;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓵ NEXT DUE MAY NEVER EXCEED THE WHOLE REMAINING DEBT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0042's body is restated verbatim inside the cap, comments and all, because that is what an
-- append-only migration directory means: the effective definition has to be readable in one
-- place, and a diff that showed only `least(...)` would leave the per-instalment rule — the
-- part that is easy to get wrong and that 0042 argues for at length — in a file this one
-- supersedes.
CREATE OR REPLACE FUNCTION order_next_due_thb_minor(p_order_id uuid) RETURNS bigint AS $$
  WITH per_instalment AS (
    SELECT i.seq,
           i.due_thb_minor,
           coalesce(
             sum(a.amount_thb_minor) FILTER (WHERE s.status = 'accepted'), 0
           ) AS settled_thb_minor
      FROM order_instalments i
      LEFT JOIN slip_allocations a ON a.instalment_id = i.id
      LEFT JOIN payment_slips s ON s.id = a.slip_id
     WHERE i.order_id = p_order_id
     GROUP BY i.seq, i.due_thb_minor
  ),
  per_schedule AS (
    SELECT coalesce(
             (SELECT due_thb_minor - settled_thb_minor
                FROM per_instalment
               -- A zero-due instalment is already settled by this test and is stepped over
               -- rather than reported as "฿0.00 due", which would stall the screen on a row
               -- that asks for nothing.
               WHERE due_thb_minor > settled_thb_minor
               ORDER BY seq
               LIMIT 1),
             CASE
               WHEN EXISTS (SELECT 1 FROM per_instalment) THEN 0
               ELSE coalesce(order_outstanding_thb_minor(p_order_id), 0)
             END
           ) AS due_now
  )
  -- ⭐ The cap. `least` against the whole remaining debt, `greatest(0, …)` because the
  -- outstanding is negative on an overpaid order and a negative "pay now" figure is not a
  -- sentence anybody should be shown. The fallback arm above is *already* the outstanding, so
  -- the cap is a no-op on a schedule-less order rather than a second opinion about it.
  SELECT greatest(
           0,
           least(
             (SELECT due_now FROM per_schedule),
             coalesce(order_outstanding_thb_minor(p_order_id), 0)
           )
         );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓶ THE BALANCE GUARD — AT THE ASK AND AT THE YES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION approvals_write_off_within_balance() RETURNS trigger AS $$
DECLARE
  forgiven bigint;
  balance  bigint;
BEGIN
  -- A quote concession is compared against a ceiling and subtracted from nothing. It has no
  -- business with the balance and must not be constrained by it: a legitimate discount on a
  -- quote whose deposit has already been paid can exceed what is still outstanding.
  IF NEW.kind <> 'write_off' THEN
    RETURN NULL;
  END IF;

  -- ⓵ THE ASK. A pending write-off is outside the fold, so the balance cannot have gone
  -- negative yet and the arithmetic below would pass anything. The figure itself is what has
  -- to be bounded, against the balance as it stands right now.
  IF NEW.status = 'pending' THEN
    balance := coalesce(order_outstanding_thb_minor(NEW.order_id), 0);

    IF NEW.concession_thb_minor > balance THEN
      RAISE EXCEPTION
        'write-off of % requested on order % exceeds the % still outstanding',
        NEW.concession_thb_minor, NEW.order_id, balance
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
  END IF;

  -- A refusal forgives nothing, so it is outside the fold and there is nothing to check.
  IF NEW.status <> 'approved' THEN
    RETURN NULL;
  END IF;

  -- ⓶ THE YES. This row is inside `order_written_off_thb_minor()` now — see the AFTER note in
  -- the header — so the whole rule is that the balance did not go under. That composes: two
  -- ฿5,000 write-offs against a ฿10,000 debt both pass and leave ฿0.00; a third is refused.
  forgiven := order_written_off_thb_minor(NEW.order_id);
  balance  := coalesce(order_outstanding_thb_minor(NEW.order_id), 0);

  IF balance < 0 THEN
    RAISE EXCEPTION
      'approving write-off % would forgive % on order %, which owes only %',
      NEW.id, forgiven, NEW.order_id, forgiven + balance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- INSERT as well as UPDATE, because a row may be born approved: nothing in this schema
-- requires an approval to pass through `pending`, and a guard that only watched the UPDATE
-- would be bypassed by one INSERT.
CREATE TRIGGER "approvals_write_off_within_balance"
  AFTER INSERT OR UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_write_off_within_balance();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓷ `kind` JOINS THE FROZEN COLUMNS — restated in full, nothing weakened
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `kind` is *what is being approved*, in the most literal sense this table has: turning a
-- pending `quote_concession` into a `write_off` under an approver who had already read the
-- reason would convert an agreed discount into a forgiven debt, at the same figure, with the
-- same four-eyes row to show for it.
CREATE OR REPLACE FUNCTION approvals_guard_write() RETURNS trigger AS $$
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
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.concession_thb_minor IS DISTINCT FROM OLD.concession_thb_minor
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
  THEN
    RAISE EXCEPTION 'what is being approved cannot change while it is being approved'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
