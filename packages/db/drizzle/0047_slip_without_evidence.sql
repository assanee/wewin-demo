-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A PAYMENT MAY BE RECORDED WITH NO IMAGE — AND NEVER WITHOUT A STATED REASON.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The owner's report, in their words: *"เจ้าหน้าที่สามารถปิดยอดการชำระได้โดยไม่มีการยืนยันสลิป
-- แต่ต้องระบุเหตุผล เพราะอาจมีกรณีที่ลูกค้าโอนชำระแล้วแต่ไม่ได้แนบสลิปยืนยัน"* — the customer
-- transferred the money and never attached the photograph, and today the balance can only be
-- closed by a picture nobody has.
--
-- Told that this opens a path for money to enter the ledger with no customer evidence behind
-- it, the owner answered *"สิ่งสำคัญคือต้องสามารถตรวจสอบย้อนหลังได้ ถ้าทำได้ก็โอเค"* — it is
-- acceptable **if it can be audited afterwards**. That sentence is the whole design of this
-- file: nothing below makes an evidence-free payment harder to record. Everything below makes
-- it impossible to record *silently*.
--
-- ── ⚠️ WHAT IS NOT BEING WEAKENED ───────────────────────────────────────────
--
-- `0011_payment_guards.sql`, as amended by `0013_payment_closure_guards.sql`, still holds every
-- rule it held this morning and this migration re-states the whole function body to say so:
--
--   * a slip can never be DELETED — "slip is evidence of a payment";
--   * `order_id` is immutable;
--   * `submitted_by_user_id`/`submitted_by_guest_id` are immutable — the cheapest possible way
--     to defeat the two-person rule;
--   * a row that has left `submitted` is FROZEN, and the frozen list GROWS here by the two
--     columns this migration adds. A reason that can be rewritten after the money landed is
--     not an audit trail, it is a draft;
--   * the PDPA erasure of the image, and `updated_at`, remain the only permitted edits.
--
-- ── ⓵ EVIDENCE EXISTS IN ONE OF THREE FORMS, AND THE CHECK NAMES ALL THREE ──
--
-- `payment_slips_evidence_exists`:
--
--     an image                 storage_key IS NOT NULL
--     an image that was erased storage_key_erased_at IS NOT NULL     ← PDPA. Must stay legal.
--     a stated reason          no_slip_reason_th IS NOT NULL
--
-- The middle arm is the one that is easy to leave out and expensive to leave out. A slip whose
-- picture a retention sweep destroyed has no `storage_key` *and* no `no_slip_reason_th` — it is
-- an ordinary customer slip that was photographed, reviewed and then lawfully erased — and a
-- two-armed CHECK would have made `eraseImage()` fail on every slip in the table. See
-- `payment_slips_erasure_shape`, which already refuses the two erasure columns disagreeing;
-- together they mean the middle arm can only be true of a row that really did carry an image.
--
-- ⚠️ Verified against the live table before this was written, not reasoned about:
--
--     select count(*) filter (where storage_key is null and storage_key_erased_at is null)
--       from payment_slips;   -- 0 of 1 row
--
-- and again by `ADD CONSTRAINT` itself, which is `NOT VALID`-free here on purpose: Postgres
-- validates the whole table as part of this statement, so a row this CHECK would refuse fails
-- the migration rather than surviving inside it.
--
-- ── ⓶ SELF-REVIEW IS NEVER SILENT — WHICH IS NOT THE SAME AS "PERMITTED" ────
--
-- The owner chose that a high permission may bypass the two-person rule. **The database cannot
-- see permissions.** `payment_slips` has no idea what a group is, and a CHECK that tried to say
-- "unless they hold X" would have to join a table this row has no reference to, in a constraint
-- that must be evaluable on one row. So the layers are split, and the split is the point:
--
--     the APP decides WHETHER    — `payments.self_review_slip` is checked in
--                                  `SlipsService.accept`, before the write.
--     the DATABASE guarantees THE TRAIL — reviewer = submitter is refused unless
--                                  `self_review_reason_th` is filled, whoever is asking and
--                                  whatever code path they came through.
--
-- Read that as a weakening and it is one. Read it as what it is — a rule that used to say "this
-- never happens" now saying "this never happens unnoticed" — and the reason is that the first
-- version was not true: staff key in telephoned transfers today (`submitted_by_user_id` exists
-- for exactly that), and a company with one person on the payments desk answered the refusal by
-- not using the software. Money outside the system has no audit trail at all.
--
-- ⚠️ THE RULE LIVES IN TWO PLACES AND BOTH MOVE HERE. `payment_slips_reviewer_is_not_submitter`
-- (the CHECK) and `payment_slips_guard_write()` (the trigger) are not redundant: the CHECK sees
-- one column and the trigger calls `slip_submitter_user_ids()`, which resolves a guest cart
-- later signed into an account to the same person. Amending one and not the other would leave
-- the other refusing every bypass — which is a feature that appears to work in a unit test and
-- fails on the first real order.
--
-- ── What this migration deliberately does NOT do ────────────────────────────
--
-- It grants nothing. `payments.record_without_slip` and `payments.self_review_slip` are inserted
-- into `permissions` by `permission-sync.service.ts` at boot and held by **no group**, exactly as
-- `quotes.approve` and `users.erase` are: who holds them is the owner's answer to give, and a
-- grant invented here would be inventing it. Until they grant one, this whole feature is refused
-- for want of a permission — the fail-closed direction.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "payment_slips"
  ADD COLUMN "no_slip_reason_th" text,
  ADD COLUMN "self_review_reason_th" text;
--> statement-breakpoint

COMMENT ON COLUMN "payment_slips"."no_slip_reason_th" IS
  'Why this payment has no image. Set by staff at INSERT; frozen once the slip is reviewed.';
--> statement-breakpoint

COMMENT ON COLUMN "payment_slips"."self_review_reason_th" IS
  'Why the reviewer is also the submitter. The app checks the permission; this column is the trail.';
--> statement-breakpoint

-- ⓵ Evidence exists in one of three forms. See the header for why the middle arm is there.
ALTER TABLE "payment_slips"
  ADD CONSTRAINT "payment_slips_evidence_exists" CHECK (
    "storage_key" IS NOT NULL
    OR "storage_key_erased_at" IS NOT NULL
    OR "no_slip_reason_th" IS NOT NULL
  );
--> statement-breakpoint

-- A reason made of spaces is the absence of a reason wearing a value. Both columns exist to be
-- read by a person months later, so both refuse blank the same way.
ALTER TABLE "payment_slips"
  ADD CONSTRAINT "payment_slips_no_slip_reason_shape" CHECK (
    "no_slip_reason_th" IS NULL OR btrim("no_slip_reason_th") <> ''
  );
--> statement-breakpoint

-- A declared bypass belongs to a review, and there is no review on a `submitted` row —
-- `payment_slips_review_shape` already holds `reviewed_by_user_id` NULL there. So this pins the
-- declaration to the decision it excuses, and makes `self_review_reason_th IS NOT NULL` a
-- truthful marker for the audit list rather than a field anybody can fill in advance.
ALTER TABLE "payment_slips"
  ADD CONSTRAINT "payment_slips_self_review_shape" CHECK (
    "self_review_reason_th" IS NULL
    OR (btrim("self_review_reason_th") <> '' AND "reviewed_by_user_id" IS NOT NULL)
  );
--> statement-breakpoint

-- ⓶a The CHECK half of the two-person rule.
--
-- Dropped and recreated under the SAME NAME on purpose. `packages/db/tests/payment.test.ts`
-- counts the two-person rules in `pg_constraint` by name — plan 7.13's budget of four, because
-- eight approval gates in one workflow kill the single control that means anything — and a
-- rename would silently retire one of the four rather than amend it.
ALTER TABLE "payment_slips"
  DROP CONSTRAINT "payment_slips_reviewer_is_not_submitter";
--> statement-breakpoint

ALTER TABLE "payment_slips"
  ADD CONSTRAINT "payment_slips_reviewer_is_not_submitter" CHECK (
    "reviewed_by_user_id" IS NULL
    OR "reviewed_by_user_id" IS DISTINCT FROM "submitted_by_user_id"
    OR "self_review_reason_th" IS NOT NULL
  );
--> statement-breakpoint

-- ⓶b The trigger half — the one that can see both identities.
--
-- Restated whole rather than patched, because `CREATE OR REPLACE FUNCTION` has no partial form
-- and because a reader of this file is entitled to see every rule that survives rather than
-- diffing against two earlier migrations. Two changes from the definition 0013 left behind, and
-- they are marked ⭐ below. Everything else is character for character what was already running.
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
  --
  -- ⭐ CHANGED: `AND NEW.self_review_reason_th IS NULL`.
  --
  -- The rule is not "somebody else must review this". It is now "reviewing your own entry
  -- leaves a written reason on the row, for ever". Whether this reviewer is *allowed* to
  -- declare it at all is `payments.self_review_slip`, checked in the application — see the
  -- header for why that cannot live here. What cannot happen, through this trigger, through a
  -- second code path, through a script or through psql, is a self-review with nothing written
  -- down: `payment_slips_self_review_shape` pins the reason to the review, and the frozen list
  -- below stops it being edited afterwards.
  IF NEW.reviewed_by_user_id IS NOT NULL
     AND NEW.self_review_reason_th IS NULL
     AND NEW.reviewed_by_user_id IN (SELECT user_id FROM slip_submitter_user_ids(NEW.id)) THEN
    RAISE EXCEPTION 'user % uploaded slip % and cannot review it', NEW.reviewed_by_user_id, NEW.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'a guest cart signed into an account is the same person — plan 7.7''s single control; a declared self-review sets self_review_reason_th';
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
       -- ⭐ ADDED: the two reasons freeze exactly as the money columns do.
       --
       -- These are the whole of what the owner is trusting. "ตรวจสอบย้อนหลังได้" — auditable
       -- afterwards — is a claim about a row nobody can go back and improve the wording of once
       -- the money has landed, so they belong in this list and not beside `updated_at`.
       OR NEW.no_slip_reason_th IS DISTINCT FROM OLD.no_slip_reason_th
       OR NEW.self_review_reason_th IS DISTINCT FROM OLD.self_review_reason_th
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

-- ⓷ The audit surface, in the only place it can be cheap.
--
-- "Which payments were recorded with no slip" is the question the owner said made this
-- acceptable, and it is a question with a highly selective answer — a handful of rows in a table
-- that grows with every transfer the company receives. A partial index means the audit list is a
-- scan of the exceptions rather than of the payments.
--
-- `transferred_at DESC` because that is the order the list is read in: what happened most
-- recently, first.
CREATE INDEX "payment_slips_no_slip_idx"
  ON "payment_slips" ("transferred_at" DESC)
  WHERE "no_slip_reason_th" IS NOT NULL;
