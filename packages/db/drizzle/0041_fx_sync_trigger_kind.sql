-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHAT MADE A SYNC HAPPEN — BECAUSE A BUTTON IS ABOUT TO EXIST
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every row in these two tables was written by the daily 01:00 tick or by the once-only
-- startup fetch, so "what caused this" had exactly one answer and needed no column. A
-- manual sync button changes that, and it changes it in a way that is not cosmetic.
--
-- The free Open Exchange Rates plan allows 1,000 requests a month FOR THE WHOLE SYSTEM.
-- The daily tick spends ~30 of them; the ~970 spare is deliberate headroom, not slack —
-- see the class header on apps/api/src/fx/fx-rates.service.ts. A button a person can hold
-- down spends that headroom in an afternoon, and when the quota is gone the SCHEDULED sync
-- stops too: an impatient click today becomes a stale rate and a refused quotation next
-- week. So the button needs a budget, and a budget needs a count.
--
-- ⭐ WHY THE COUNT LIVES IN THE DATABASE AND NOT IN THE SERVICE'S MEMORY
--
-- This repo already has three in-process rate limiters (SignInThrottle, MFA_THROTTLE,
-- FunnelThrottleMiddleware), each of which documents that it is per-process and resets on
-- restart. Each is right about its own problem: they protect *this instance* against
-- traffic aimed at it. This budget is different in kind — it is a property of the provider
-- account, shared by every instance and every deploy. An in-memory counter would reset the
-- guard on every restart, and a restart is exactly the moment somebody is standing over the
-- button wondering why the rate has not moved.
--
-- Counting rows also keeps the figure DERIVED rather than stored, which is the rule
-- 0040_fx_sync_failures.sql already states for the consecutive-failure count: a manual
-- attempt lands in exactly one of these two tables — `fx_rates` when the provider answered,
-- `fx_sync_failures` when it did not — so the count is measured against the very rows it
-- describes and cannot disagree with them. A stored counter is a second copy of a fact,
-- with its own way of being wrong.
--
-- ⚠️ ON BOTH TABLES, and that is not symmetry for its own sake. A manual sync that FAILED
-- still spent a provider request. Counting only successes would let somebody hold the
-- button down through a provider outage and burn the month's budget while the guard saw
-- nothing at all.
--
-- ⚠️ NO ACTOR COLUMN, deliberately. Both tables refuse UPDATE by trigger, and `erase_user()`
-- (0030_erase_tax_actors.sql) scrubs staff actors by UPDATING the rows that name them — so a
-- `triggered_by_user_id` here would be a staff identifier that erasure provably cannot reach.
-- That is precisely the residue 0030's own `withheld` text already lists for
-- `notification_attempts.recipient_key`, and adding a second one uninvited is not this
-- migration's call to make. A manual sync changes no setting and moves no figure; it spends a
-- shared budget, and the budget is the thing that needed recording. If the owner wants the
-- name of whoever pressed it, that is a separate, non-append-only table.
--
-- Backfill: 'scheduled' for every existing row. Not strictly true of the handful written by
-- `onModuleInit` on a fresh environment, and the honest alternative is unavailable — nothing
-- distinguishes them now, and inventing a distinction retroactively would be a worse lie than
-- the default. What matters for the guard is that no historical row counts as 'manual', and
-- none does.

ALTER TABLE "fx_rates"
  ADD COLUMN "trigger_kind" text DEFAULT 'scheduled' NOT NULL;
--> statement-breakpoint

ALTER TABLE "fx_rates"
  ADD CONSTRAINT "fx_rates_trigger_kind_known"
  CHECK ("trigger_kind" IN ('scheduled', 'startup', 'manual'));
--> statement-breakpoint

ALTER TABLE "fx_sync_failures"
  ADD COLUMN "trigger_kind" text DEFAULT 'scheduled' NOT NULL;
--> statement-breakpoint

ALTER TABLE "fx_sync_failures"
  ADD CONSTRAINT "fx_sync_failures_trigger_kind_known"
  CHECK ("trigger_kind" IN ('scheduled', 'startup', 'manual'));
