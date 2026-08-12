-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE NUMBER THE CUSTOMER IS BEING ASKED FOR RIGHT NOW
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The owner's ruling, in their words:
--
--   "ถ้าเป็นเคสที่ระบุว่าต้องมัดจำ จึงจะมัดจำ ถ้าไม่ได้ระบุให้ใช้ยอดเต็มเลย"
--
-- An order whose schedule has a deposit is asked for the deposit; an order with no deposit
-- is asked for the whole amount. That reads like two cases and it is one, because
-- `payInFullTerms()` is a schedule too — a single `remainder` row gating
-- `production_confirmed`, which is exactly why `terms.ts` calls one row "not 'no schedule'".
-- So the rule is **the first instalment that is not yet fully settled**, and the two cases
-- are the same fold reading two different schedules.
--
-- ⭐ WHY THIS IS A FUNCTION AND NOT A QUERY IN THE REPOSITORY
--
-- `ledger.repository.ts`'s class header states the rule this file exists to obey: the folds
-- live here and TypeScript *calls* them. Plan 7.13 found `scheduledDepositMinor` written
-- three ways, answering ฿5,530 and ฿18,432 for the same 30/70 order — ฿12,902 of difference
-- in what a customer gets back — and plan 7.5(ค) found the frontier written as a MAX in one
-- place and a COUNT in another. A per-instalment "how much of this one is settled" assembled
-- in the repository would be a second copy of the CTE inside `order_settled_through()`
-- below, and it would agree with it until the day a carried allocation made it not.
--
-- ⚠️ THE REMAINDER OF THE INSTALMENT, NOT THE WHOLE OF IT.
--
-- The question this answers is "what should the amount field open on", and the only answer
-- that lands the customer on the right total is what is *left* on that instalment. A gate
-- instalment of ฿3,960.00 with ฿1,000.00 already accepted against it needs ฿2,960.00 to
-- close, and prefilling ฿3,960.00 would have the customer transfer ฿4,960.00 in total and
-- overpay by exactly the amount they had already sent. `due - settled`, therefore, and not
-- `due`.
--
-- ⚠️ ACCEPTED ALLOCATIONS ONLY — the same `s.status = 'accepted'` filter every other fold in
-- 0011 uses. A slip sitting in `submitted` is a claim nobody has checked yet; counting it
-- would let a customer reduce what the screen asks for by uploading a photograph.
--
-- ⚠️ ORDERED BY `seq`, WHICH IS WHAT KEEPS THE GATE HONEST.
--
-- Only the gating instalment opens production (`FREEZE_GATE_STATUS`), and money allocated to
-- a later instalment must never read as progress toward it. Taking the *first* unsettled row
-- by `seq` means an order whose instalment 2 has been paid while instalment 1 has not still
-- reports instalment 1 — the same prefix semantics `order_settled_through()` already has, so
-- the two cannot disagree about where the frontier is.
--
-- ⚠️ AN ORDER WITH NO SCHEDULE AT ALL FALLS BACK TO THE WHOLE OUTSTANDING.
--
-- Which is not a special case bolted on — it is the second half of the ruling in its purest
-- form. "ไม่ได้ระบุ" means nobody stated instalments, and the answer to that is the full
-- amount. Every order `OrdersService.submit` writes has a schedule (`onSubmitted` opens one),
-- and no submitted order in the database lacks one, so this is a floor rather than a path
-- anybody travels — but the alternative floor is a screen that asks a customer for ฿0.00 on
-- an order that owes money, and a fold that is total is worth three lines.
--
-- Distinguishing it from "settled in full" is the whole reason this is a CASE and not another
-- `coalesce`: with a schedule, no unsettled row means nothing is due and the answer is 0;
-- without one, no unsettled row means nothing has been *decided* and the answer is everything.
--
-- Returns 0 when every instalment is settled, and 0 for a draft — whose outstanding is 0 too,
-- because `order_outstanding_thb_minor()` coalesces a null grand total to zero. Both mean the
-- same thing to a caller, so this never returns NULL and never makes anybody handle a third
-- case.

CREATE OR REPLACE FUNCTION order_next_due_thb_minor(p_order_id uuid)
  RETURNS bigint
  LANGUAGE sql
  STABLE
AS $$
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
  )
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
         );
$$;
--> statement-breakpoint

COMMENT ON FUNCTION order_next_due_thb_minor(uuid) IS
  'The remainder of the first instalment not yet fully settled by accepted slips — what the '
  'payment screen asks a customer for. 0 when nothing is due. See 0042 for the reasoning.';
