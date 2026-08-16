-- ═════════════════════════════════════════════════════════════════════════════
-- ⭐ A DEPOSIT SET PER ORDER — "การระบุยอดมัดจำ", the owner's own words
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Until now the deposit share was one number for the whole company
-- (`organisation_profile.deposit_bp`), applied to every order at submit. The flow the owner
-- asked for has staff adjusting an unconfirmed quotation before anybody is asked to pay, and the
-- deposit is one of the two things they adjust.
--
-- ── ⓵ `orders.deposit_bp_authored` — the share somebody chose for THIS order ──
--
-- Nullable, and null is not "0%": it means nobody chose, so the company setting applies. That
-- distinction is load-bearing at the re-issue.
--
-- ⛔ THE BUG IT EXISTS TO PREVENT, found by attacking the design rather than by running it:
-- `OrdersService.reissueQuote` re-plans the schedule from `DepositPolicyPort.depositBp(tx)` —
-- the *company* number. Without a per-order pin, a deposit staff had authored would be silently
-- reverted, along with the forfeit ceiling derived from it, the next time anybody edited the
-- quotation and pressed send. The pin is what `pinsForReissue` reads instead.
--
-- ⚠️ NOT write-once, unlike `deposit_floor_bp` beside it. That column records the policy an
-- order was *measured against* at submit and must never move; this one records a decision staff
-- are expressly allowed to revisit while the quotation is still being negotiated. What stops it
-- moving after that is money: `QuotesService.assertNoMoney` at the write, and
-- `ScheduleService.replacePlanned` refusing any schedule an allocation has touched.
--
-- ── ⓶ `organisation_profile.deposit_below_floor_allowed` — the owner's setting ─
--
-- May staff set a deposit *below* the company standard? The owner's answer was to make it a
-- setting rather than a rule in code, and the default is `false`: raising the deposit asks the
-- customer for more of their own money up front and is nobody's concession, while lowering it is
-- the company financing the difference — which is `AuthorityService`'s `cashflow` dimension and
-- has to pass a ceiling somebody granted.
--
-- ⚠️ With it `true` the feature is only usable once a `cashflow` ceiling exists in
-- `authority_limits` and somebody holds `quotes.approve`; both ship empty, deliberately, so the
-- system fails closed. The refusal says exactly that rather than "forbidden".
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "orders" ADD COLUMN "deposit_bp_authored" smallint;
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_bp_authored_in_range" CHECK (
  "orders"."deposit_bp_authored" is null
  or "orders"."deposit_bp_authored" between 1 and 10000
);
--> statement-breakpoint

-- ⛔ A share nobody agreed to cannot be attached to an order nobody has quoted. The same shape
-- as `orders_deposit_floor_needs_a_contract`: the column belongs to a contract, and a draft has
-- none.
ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_bp_authored_needs_a_contract" CHECK (
  "orders"."deposit_bp_authored" is null or "orders"."submitted_at" is not null
);
--> statement-breakpoint

ALTER TABLE "organisation_profile"
  ADD COLUMN "deposit_below_floor_allowed" boolean NOT NULL DEFAULT false;
