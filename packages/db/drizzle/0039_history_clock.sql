-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE SAFETY NET UNDER EVERY HISTORY TABLE WAS WOVEN FROM THE FAILURE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- All four `*_changes` tables carried `changed_at timestamptz DEFAULT now()`. Every one of
-- them exists to prove one property — that entry N's `before` equals entry N−1's `after`, read
-- in `changed_at` order — and `now()` is the exact value that breaks it.
--
-- `now()` is `transaction_timestamp()`: fixed at BEGIN and frozen for the whole transaction.
-- Two concurrent writers to one subject both open before either takes its row lock, so the one
-- that blocks on the lock can hold the *earlier* `now()` while committing *second*. Sorted by
-- `changed_at`, the chain then reads in an order that never happened. This repository has
-- broken that invariant three times; the fix each time was to pass `clock_timestamp()`
-- explicitly at the call site, and each time the wrong value was left sitting in the column
-- default underneath.
--
-- ── Why this is safe to change, checked rather than assumed ──────────────────────
--
-- The default never fires on any path that exists today. Every writer names the value:
--   apps/api/src/organisation/organisation.service.ts:105, :161, :226
--   apps/api/src/organisation/tax-country.service.ts:191, :246
--   apps/api/src/quotes/authority/authority.repository.ts  (insertLimitChange)
-- There is no SQL-side INSERT into any of these tables anywhere in the repository — not in a
-- migration, not in the seed, not in a trigger. `erase_user()` only UPDATEs them, under
-- `session_replication_role = replica` (0030). The only inserts that rely on the default are
-- in `packages/db/tests`, and none of them asserts anything about the value.
--
-- So the default's whole job is to catch the *next* writer, or a `psql` session, that forgets.
-- `clock_timestamp()` does that job: it is volatile, Postgres accepts it as a column default,
-- and it reads the wall clock per row, so two rows written inside one transaction get distinct
-- and correctly ordered values. Measured on `authority_limit_changes` with a writer that
-- deliberately forgets the explicit value: 12 of 12 runs red under `DEFAULT now()`, 12 of 12
-- green under this one.
--
-- ⚠️ This changes only the fallback. The explicit `clock_timestamp()` at every call site stays,
-- because that is where the comment explaining the hazard lives, and because a default is a net
-- rather than a plan.
--
-- ── Why `authority_limit_changes` is in this list ────────────────────────────────
--
-- 0038 creates it with the right default already, which is what a database migrated from
-- scratch gets. But 0038 shipped on this branch before this fix and has been applied to
-- developer databases, and drizzle decides what to run by the journal's timestamp rather than
-- by a file hash — so editing 0038 alone would leave those databases on `now()` while the file
-- said otherwise, with the tests (which drop and recreate) green either way. That silent drift
-- is worse than one redundant statement, so the ALTER is here as well and is a no-op on a
-- freshly-migrated database.

ALTER TABLE "bank_account_changes"
  ALTER COLUMN "changed_at" SET DEFAULT clock_timestamp();
--> statement-breakpoint

ALTER TABLE "tax_country_changes"
  ALTER COLUMN "changed_at" SET DEFAULT clock_timestamp();
--> statement-breakpoint

ALTER TABLE "organisation_profile_changes"
  ALTER COLUMN "changed_at" SET DEFAULT clock_timestamp();
--> statement-breakpoint

ALTER TABLE "authority_limit_changes"
  ALTER COLUMN "changed_at" SET DEFAULT clock_timestamp();
