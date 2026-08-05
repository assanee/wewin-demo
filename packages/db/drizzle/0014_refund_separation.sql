-- The outbound leg of the two-person rule, closed at the one place the composed attack needs.
--
-- ── What this is the answer to ───────────────────────────────────────────────────
--
-- The 5b red team walked one person, holding one plausible "payments officer" permission
-- set (`payments.verify` + `payments.read` + `orders.read` + `orders.write` +
-- `orders.refund`), all the way to real cash:
--
--   1. open a cart anonymously                      no identity is recorded at all
--   2. upload a slip for money that never moved     as the guest, in a second browser
--   3. accept it, attesting the payer as their own account
--   4. cancel the order                             staff, fault=customer, 0 bp
--   5. request the refund to that account           reads `payeeIsOriginalAccount: yes`
--   6. ONE other person clicks approve
--   7. disburse it themselves
--
-- `bank_thb` nets to zero, because the fake money in and the real money out cancel exactly —
-- no per-order balance check could ever have caught it.
--
-- 0013 closed step 3 for the ordinary funnel (a guest cart claimed by signing in is the same
-- person, `slip_submitter_user_ids`), and said out loud what it could not close: a reviewer
-- who never claims the guest is two identities to this system and always will be. Nothing
-- identity-based can catch an anonymous submitter.
--
-- So the rule moves to the leg where an identity always exists. **Whoever said the money
-- arrived does not get to ask for it back.** That is the same sentence as
-- `payment_slips_reviewer_is_not_submitter`, applied to the outbound direction, and it breaks
-- the chain at step 5 without touching any of the others.
--
-- ── Why the requester and not the approver or the disburser ─────────────────────
--
-- Plan 7.13 warns, in its own words, that eight two-person approvals in one workflow kills
-- the single control that means anything, and plan 13 records that **nobody knows how many
-- people this company has**. So this adds no approval point and no click: it constrains who
-- may perform a step that already existed.
--
-- The arithmetic that decided which step. With two employees A and B, and A the reviewer who
-- accepted the payment:
--
--   requester must be B          (this rule)
--   approver must not be B       (`refunds_approver_is_not_requester`) → A
--   disburser must not be A      (`refunds_disburser_is_not_approver`) → B
--
-- Two humans still complete every refund, so no headcount is invented. Extending it to the
-- approver as well would make three humans mandatory, which IS a headcount decision and is
-- not one this migration is entitled to make.
--
-- ── Why a trigger and not a CHECK ───────────────────────────────────────────────
--
-- It reads a second table. `RefundsService.request` refuses first, with a sentence naming the
-- slip; this is what makes the rule true for a transaction typed into psql, and — the reason
-- it is worth having twice — for the next service that inserts a refund row.
CREATE FUNCTION refunds_assert_requester_did_not_take_the_money() RETURNS trigger AS $$
DECLARE
  slip_id uuid;
BEGIN
  SELECT s.id INTO slip_id
    FROM payment_slips s
   WHERE s.order_id = NEW.order_id
     AND s.status = 'accepted'
     AND s.reviewed_by_user_id = NEW.requested_by_user_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'user % accepted payment slip % on order % and cannot request its refund',
      NEW.requested_by_user_id, slip_id, NEW.order_id
      USING ERRCODE = 'restrict_violation',
            HINT = 'money in and money out are different people — plan 7.12';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER refunds_requester_did_not_take_the_money
  BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_assert_requester_did_not_take_the_money();
