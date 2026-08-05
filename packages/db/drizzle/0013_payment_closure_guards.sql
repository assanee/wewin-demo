-- What the 5b red team found, closed in the one place a second code path cannot reopen.
--
-- Same arrangement as 0007 and 0011, for the same reason: drizzle-kit generates tables,
-- constraints and indexes from src/schema and does not generate triggers, functions or
-- deferred assertions. 0012 is the generated half of this change; this is the half that
-- needs to read a second table, and every rule below is one that a CHECK provably cannot
-- carry.
--
-- Four findings, in the order they cost money:
--
--   ⓵ THE TWO-PERSON RULE WAS A NULL. `payment_slips.submitted_by_user_id` is NULL for
--     every guest slip and the guest funnel is the MAIN funnel (plan 6). Both enforcement
--     points compared against that one nullable column, so both passed for every reviewer
--     in the company — including the one holding the browser that uploaded it. Reproduced
--     end to end with one human and one private window: cart → guest slip → sign in →
--     accept → the order freezes on money nobody independent looked at.
--
--   ⓶ NOTHING CAPPED AN ALLOCATION AT THE INSTALMENT'S DUE. Plan 7.8 asked for a CHECK and
--     there was none. Piling ฿39,444.48 onto an instalment due ฿5,916.67 satisfied every
--     constraint in the schema, and `order_settled_through()` compares `due <= allocated`
--     per row — so the *fully funded* balance instalment read unsettled and its gate stayed
--     shut. Only TypeScript stopped it, which is to say only one caller stopped it.
--
--   ⓷ AN OVERPAID SLIP WAS A PERMANENT ORPHAN. Allocations had to foot to the slip exactly
--     and no instalment could absorb more than its due, so ฿20,000.00 against a ฿19,722.24
--     order had nowhere to put ฿277.76: the slip could not be accepted, not deleted, not
--     truthfully rejected. The money was in the bank and the system held ฿0.00.
--
--   ⓸ THE PAYER WAS A FIELD THE PAYER TYPED. `payer_name` / `payer_account_last4` arrive on
--     the customer's own create-slip body and nothing compared them to the image — so the
--     party plan 7.12's fraud control exists to catch was choosing the account that later
--     read as "the account the money came from".


-- ═════════════════════════════════════════════════════════════════════════════
-- ⓵ THE SUBMITTER IS TWO COLUMNS, BECAUSE THE SUBMITTER IS TWO KINDS OF PERSON
-- ═════════════════════════════════════════════════════════════════════════════

-- A guest is a real identity here — `guests.secret_hash`, migration 0008 — and signing in
-- *claims* it. That is what makes the link recoverable: the slip records which guest
-- uploaded it, and an acceptance by the user who claimed that guest is the same person
-- reviewing their own upload, whatever the two user-id columns say.
--
-- ⚠️ WHAT THIS DOES NOT CLOSE, SAID OUT LOUD. A reviewer who uses a second browser and
-- never claims the guest is still two identities to this system and always will be —
-- nothing identity-based can catch an anonymous submitter. What it closes is the path a
-- single person reaches by following the ordinary funnel, which is the path that was
-- actually walked. The residual is a reason for the *queue* to be reviewed by someone whose
-- own orders are not in it, and that is a staffing control, not a column.
CREATE FUNCTION slip_submitter_user_ids(p_slip_id uuid) RETURNS TABLE (user_id uuid) AS $$
  SELECT s.submitted_by_user_id
    FROM payment_slips s
   WHERE s.id = p_slip_id AND s.submitted_by_user_id IS NOT NULL
  UNION
  SELECT g.claimed_by_user_id
    FROM payment_slips s
    JOIN guests g ON g.id = s.submitted_by_guest_id
   WHERE s.id = p_slip_id AND g.claimed_by_user_id IS NOT NULL;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- ⓷ AN ACCEPTED SLIP FOOTS TO ALLOCATIONS **PLUS THE EXCESS IT COULD NOT PLACE**
-- ═════════════════════════════════════════════════════════════════════════════

-- The rule 0011 wrote — `SUM(allocations) = slip.amount` — is right about the thing it was
-- defending (a reviewer settling instalments with money that never arrived) and wrong about
-- one case it did not consider: money that genuinely arrived and genuinely closes nothing.
-- Refusing the slip does not make that money go away, it makes it invisible.
--
-- So the identity becomes `SUM(allocations) + unallocated = slip.amount`, with `unallocated`
-- a column the reviewer must set deliberately (`payment_slips_unallocated_needs_acceptance`
-- keeps it zero until acceptance). The defence is unchanged in the direction that mattered:
-- the sum is still tied to the slip, and every satang still has to be accounted for.
--
-- The pay-off beyond closing the orphan: `paidMinor` and `settledMinor` are now genuinely
-- different numbers on a reachable path, which plan 7.13 says they must be and which the red
-- team showed they were not.
CREATE OR REPLACE FUNCTION assert_slip_allocations(p_slip_id uuid) RETURNS void AS $$
DECLARE
  slip      payment_slips%ROWTYPE;
  allocated bigint;
BEGIN
  SELECT * INTO slip FROM payment_slips WHERE id = p_slip_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(sum(a.amount_thb_minor), 0) INTO allocated
    FROM slip_allocations a WHERE a.slip_id = p_slip_id;

  IF slip.status = 'accepted' THEN
    IF allocated + slip.unallocated_thb_minor <> slip.amount_thb_minor THEN
      RAISE EXCEPTION 'slip % is for % but % is allocated and % is recorded as unallocated',
        p_slip_id, slip.amount_thb_minor, allocated, slip.unallocated_thb_minor
        USING ERRCODE = 'restrict_violation',
              HINT = 'an accepted slip accounts for exactly the money it is evidence of';
    END IF;
  ELSIF allocated <> 0 THEN
    RAISE EXCEPTION 'slip % is % and cannot settle anything, but % is allocated from it',
      p_slip_id, slip.status, allocated
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- ⓶ AND NO INSTALMENT ABSORBS MORE THAN IT IS DUE
-- ═════════════════════════════════════════════════════════════════════════════

-- The mirror image of `order_instalments_guard_write()`, which already refuses lowering a
-- `due` below what has been allocated to it. That guard made one direction impossible and
-- left the other wide open, and the two are the same invariant:
--
--     allocated(instalment) <= instalment.due
--
-- Read the same way `order_settled_through()` reads it — accepted slips only — because that
-- is the fold the frontier is computed from, and a rule that disagreed with the frontier
-- would be a rule about a number nothing uses.
--
-- Deferred, because acceptance flips the slip's status and writes the allocations in
-- separate statements and either order is legitimate mid-transaction.
CREATE FUNCTION assert_instalment_allocation(p_instalment_id uuid) RETURNS void AS $$
DECLARE
  inst      order_instalments%ROWTYPE;
  allocated bigint;
BEGIN
  SELECT * INTO inst FROM order_instalments WHERE id = p_instalment_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT coalesce(sum(a.amount_thb_minor), 0) INTO allocated
    FROM slip_allocations a
    JOIN payment_slips s ON s.id = a.slip_id
   WHERE a.instalment_id = p_instalment_id AND s.status = 'accepted';

  IF allocated > inst.due_thb_minor THEN
    RAISE EXCEPTION 'instalment % (seq %) is due % but % is allocated to it',
      p_instalment_id, inst.seq, inst.due_thb_minor, allocated
      USING ERRCODE = 'restrict_violation',
            HINT = 'money beyond an instalment belongs to the next one, or to payment_slips.unallocated_thb_minor';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION slip_allocations_assert_instalment() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM assert_instalment_allocation(OLD.instalment_id);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    PERFORM assert_instalment_allocation(NEW.instalment_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER slip_allocations_within_instalment
  AFTER INSERT OR UPDATE OR DELETE ON slip_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION slip_allocations_assert_instalment();
--> statement-breakpoint

-- The other direction, and it is the one that is easy to miss: accepting a slip changes
-- nothing in `slip_allocations` and yet changes every fold above, because the fold counts
-- accepted slips only. Without this trigger a slip could be allocated ฿39,444 while
-- `submitted` — legal, since a submitted slip's allocations are refused by
-- `assert_slip_allocations` for a different reason — and then accepted in one statement
-- that no allocation trigger ever sees.
CREATE FUNCTION payment_slips_assert_instalments() RETURNS trigger AS $$
DECLARE
  instalment_id uuid;
BEGIN
  FOR instalment_id IN
    SELECT a.instalment_id FROM slip_allocations a WHERE a.slip_id = NEW.id
  LOOP
    PERFORM assert_instalment_allocation(instalment_id);
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER payment_slips_within_instalments
  AFTER INSERT OR UPDATE ON payment_slips
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_slips_assert_instalments();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- THE SLIP WRITE GUARD, EXTENDED — ⓵ and ⓸ and the new columns
-- ═════════════════════════════════════════════════════════════════════════════

-- Replaces the 0011 function whole rather than adding a second trigger beside it, because
-- two triggers on one table each holding half of "what may change on a reviewed slip" is
-- exactly the shape that lets the next migration relax one and believe the other still
-- covers it.
--
-- Three additions to what 0011 held:
--
--   * the submitter columns are immutable, always. Neither may be edited into agreement
--     with the reviewer, and neither may be cleared to make the rule below vacuous.
--   * the reviewer may not be the submitter *or the user who claimed the submitting guest*.
--     This is why the rule moved out of the CHECK: it needs `guests`.
--   * `unallocated_thb_minor` and the payer attestation freeze with everything else once
--     the slip has been reviewed, and may only be written by the same statement that
--     reviews it.
CREATE OR REPLACE FUNCTION payment_slips_guard_write() RETURNS trigger AS $$
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

  -- Who uploaded it is a fact about the past on a submitted slip too. Editing it is the
  -- cheapest possible way to defeat the two-person rule, and there is no legitimate reason.
  IF NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
     OR NEW.submitted_by_guest_id IS DISTINCT FROM OLD.submitted_by_guest_id THEN
    RAISE EXCEPTION 'who uploaded slip % is not editable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 🔒 THE TWO-PERSON RULE, WHERE IT CAN SEE BOTH IDENTITIES.
  IF NEW.reviewed_by_user_id IS NOT NULL
     AND NEW.reviewed_by_user_id IN (SELECT user_id FROM slip_submitter_user_ids(NEW.id)) THEN
    RAISE EXCEPTION 'user % uploaded slip % and cannot review it', NEW.reviewed_by_user_id, NEW.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'a guest cart signed into an account is the same person — plan 7.7''s single control';
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
       OR NEW.unallocated_thb_minor IS DISTINCT FROM OLD.unallocated_thb_minor
       OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
       OR NEW.payer_account_last4 IS DISTINCT FROM OLD.payer_account_last4
       OR NEW.payer_verified_by_user_id IS DISTINCT FROM OLD.payer_verified_by_user_id
       OR NEW.payer_verified_at IS DISTINCT FROM OLD.payer_verified_at
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

  -- ⓸ The payer attestation is the reviewer's, and only at the moment of review. Allowing
  -- it before review would let the person who typed the figures also stamp them verified,
  -- which is the control being switched off by the party it is a control against.
  IF NEW.payer_verified_by_user_id IS DISTINCT FROM OLD.payer_verified_by_user_id
     AND NEW.payer_verified_by_user_id IS DISTINCT FROM NEW.reviewed_by_user_id THEN
    RAISE EXCEPTION 'the payer on slip % is attested by whoever reviews it, and by nobody else', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Excess money is a finding of the review. A submitted slip carrying one would be a
  -- customer telling the company how much of their transfer to ignore.
  IF NEW.unallocated_thb_minor IS DISTINCT FROM OLD.unallocated_thb_minor
     AND NEW.status <> 'accepted' THEN
    RAISE EXCEPTION 'unallocated money is recorded when slip % is accepted, not before', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- THE FORFEIT POLICY IS A TERM OF THE CONTRACT — plan 7.13's seventh pin
-- ═════════════════════════════════════════════════════════════════════════════

-- 0012 adds `orders.forfeit_policy_id`. This is the half that makes it mean something: once
-- pinned it is immutable, for exactly the reason `frozen_at` and `supersedes_order_id` are.
-- A pin that can be repointed after the cancellation is a pin that decides the refund after
-- the argument has started.
--
-- Attached as its own trigger rather than folded into `orders_guard_update()` because that
-- function is 0007's and belongs to the order lifecycle; the forfeit policy is money.
CREATE FUNCTION orders_guard_forfeit_policy() RETURNS trigger AS $$
BEGIN
  IF OLD.forfeit_policy_id IS NOT NULL
     AND NEW.forfeit_policy_id IS DISTINCT FROM OLD.forfeit_policy_id THEN
    RAISE EXCEPTION 'order % was contracted under forfeit policy % and that does not change',
      OLD.id, OLD.forfeit_policy_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER orders_guard_forfeit_policy
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_forfeit_policy();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- CARRYING MONEY HAS THE SAME ANCESTRY RULE ON BOTH SIDES OF THE MOVE
-- ═════════════════════════════════════════════════════════════════════════════

-- `slip_allocations_guard_write()` walks `order_is_ancestor_of` before it will let an
-- allocation move. `ledger_entries` checked nothing of the kind, so the two entries a carry
-- writes could be posted between two orders with no relationship at all — every entry
-- balancing, `assert_ledger_entry_balances` passing, both orders internally consistent, and
-- one payment settled on one order while another holds it. The red team did exactly that
-- with ฿5,916.67.
--
-- The two halves of one act were guarded to completely different standards, and only the
-- half that was unreachable was the guarded one.
--
-- A `carried_forward` entry must therefore stand on an order that is genuinely part of a
-- supersedes chain, and on the correct end of it. The direction is read from the legs
-- rather than from a column: the order whose `deposit_held` is debited is giving the money
-- up, so it has to have a revision to give it to; the order whose `deposit_held` is
-- credited is receiving, so it has to supersede something.
--
-- One entry can only ever see its own order, so this is the strongest statement available
-- at this level, and it is deliberately the *structural* half — that the pair is between an
-- ancestor and that ancestor's own descendant is `LedgerService.recordCarriedForward`'s
-- `order_is_ancestor_of` call, which sees both ids. Two halves, and the schema holds the one
-- a second caller cannot skip.
CREATE FUNCTION assert_carry_is_between_relatives(p_entry_id uuid) RETURNS void AS $$
DECLARE
  entry      ledger_entries%ROWTYPE;
  held_delta bigint;
BEGIN
  SELECT * INTO entry FROM ledger_entries WHERE id = p_entry_id;
  IF NOT FOUND OR entry.kind <> 'carried_forward' THEN RETURN; END IF;

  SELECT coalesce(sum(p.amount_thb_minor), 0) INTO held_delta
    FROM ledger_postings p
   WHERE p.entry_id = p_entry_id AND p.account = 'deposit_held';

  -- Nothing to say until a `deposit_held` leg exists; the balance assertion owns that
  -- complaint and reporting it twice would name the wrong cause.
  IF held_delta = 0 THEN RETURN; END IF;

  IF held_delta > 0 THEN
    IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.supersedes_order_id = entry.order_id) THEN
      RAISE EXCEPTION 'order % has no revision to carry money to', entry.order_id
        USING ERRCODE = 'restrict_violation',
              HINT = 'money moves along the supersedes chain or not at all — plan 7.8';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id = entry.order_id AND o.supersedes_order_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'order % supersedes nothing and cannot receive carried money', entry.order_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION ledger_postings_assert_carry() RETURNS trigger AS $$
BEGIN
  PERFORM assert_carry_is_between_relatives(NEW.entry_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_postings_carry_is_between_relatives
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_postings_assert_carry();
