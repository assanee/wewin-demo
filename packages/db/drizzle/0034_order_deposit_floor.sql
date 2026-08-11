-- The `cashflow` approval floor, pinned to the order the way the ceiling is pinned to the approval.
--
-- ── The defect ──────────────────────────────────────────────────────────────────
--
-- `organisation_profile.deposit_bp` is the share of `grand_total_thb_minor` a payment schedule
-- must gate before production opens, and `AuthorityService.measureFor` read it **live**, through
-- `DEPOSIT_POLICY`, on every measurement. So an order submitted while the policy was 30% and
-- re-read after the owner moved it to 100% reported a 70% `cashflow` concession that nobody ever
-- asked for. `GET /quotes/authority/orders/:orderId` and the approval-detail `live` figure both
-- showed it.
--
-- Enforcement was never affected — `gate` has exactly one production caller, `OrdersService`
-- at submit, and it runs inside that transaction — so this is display and audit rather than
-- money. That is not a reason to leave it: an audit trail that re-interprets a historical order
-- against today's policy answers a different question each time it is asked.
--
-- ── Why a column, and why this one ──────────────────────────────────────────────
--
-- `orders.scheduled_deposit_thb_minor` is already pinned at submit and looks like it should
-- answer this, and it cannot. It is what the schedule *gates*; the floor is what the policy
-- *required*. The concession is `percentOf(grand_total, floor_bp) − scheduled_deposit`, so one
-- pinned deposit against two floors is two different concessions — ฿0.00 at a 30% floor, 70% of
-- the order at a 100% one. The floor is a second fact and nothing on the row implies it.
--
-- `approvals` was considered and rejected: a concession is measured for orders that never raise
-- an approval at all — the assessment endpoint runs on every quote — so a column there would
-- leave the reporting path reading the live setting exactly as before.
--
-- The precedent is `approvals.decided_ceiling_thb_minor`, added by 0017 for the identical
-- retroactive re-interpretation on the ceiling side. It pins the *input* to the comparison and
-- not the verdict, and this follows it: the concession itself stays derived, because the schedule
-- may legitimately be edited after submit and a frozen figure would hide that.
--
-- ── ⚠️ NOTHING IS BACKFILLED, AND THAT IS THE POINT ─────────────────────────────
--
-- Every order already submitted predates this column and genuinely has no recorded floor. The
-- tempting value is 10 000 — 0029 seeded `deposit_bp` with it and `GATE_COVERAGE_BP_DEFAULT` is
-- the same number — but that is the *shipping default*, not a fact anybody recorded about any of
-- these contracts, and no column on `orders` says which of them were submitted before or after
-- the setting became live. Writing it would be inventing a business fact, which is exactly what
-- 0017 refused to do for `quote_revision`.
--
-- So the column is NULL on every existing row, and `AuthorityService.measureFor` falls back to
-- the live policy when it is NULL — today's behaviour, unchanged, for precisely the rows that
-- already have it. Orders submitted from here on carry the floor they were judged against.
--
-- Not folded into `orders_submitted_shape`: that constraint is an `=` between two nullabilities,
-- and every already-submitted row would violate it on the spot.
ALTER TABLE "orders" ADD COLUMN "deposit_floor_bp" smallint;--> statement-breakpoint

-- The same range `organisation_profile_deposit_in_range` puts on the column this is copied from.
-- **1 and not 0**: a zero floor is expressed by authoring terms with no gate — `planSchedule`
-- refuses `depositPercentTerms(0)` — not by zeroing the setting.
ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_floor_in_range" CHECK ("orders"."deposit_floor_bp" is null
          or "orders"."deposit_floor_bp" between 1 and 10000);--> statement-breakpoint

-- A draft has no contract and therefore no floor. One-way, for the reason above.
ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_floor_needs_a_contract" CHECK ("orders"."deposit_floor_bp" is null
          or "orders"."submitted_at" is not null);
