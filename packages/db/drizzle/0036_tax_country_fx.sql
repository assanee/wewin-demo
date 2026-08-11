-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE EXCHANGE-RATE SPREAD, PER DESTINATION — SETTINGS ONLY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Open Exchange Rates publishes the **mid-market** rate: the midpoint between what banks buy
-- and sell at, and a price nobody transacts at. A ฿36,500 product quoted at a mid-market 36.5
-- THB/USD becomes USD 1,000; the customer pays USD 1,000; the bank converts at something
-- nearer 35.9 and ฿35,900 lands — ฿600 short of the price that was agreed. These columns are
-- what close that gap, one row per destination.
--
-- **Nothing reads them yet.** `packages/core/src/fx.ts` is the arithmetic and has tests;
-- nothing in `apps/api` or `apps/dashboard` converts a quotation, on purpose. Three of the
-- four questions that gate real conversion are answered (pin at staff confirmation, fall back
-- to the last cached rate, sync daily); the fourth — how a foreign figure is *displayed*
-- beside or instead of baht — is not, and `quote_documents` is frozen once issued
-- (0018_quote_document_freeze.sql), so wiring it in before that answer exists would freeze the
-- wrong thing permanently.
--
-- ── ⭐ THE RULE, WHEN BOTH ARE SET ─────────────────────────────────────────────
--
-- A manual override means **that exact rate**. `fx_spread_bp` is NOT applied on top of it.
--
-- The two settings correct different things. The spread corrects a rate we did not choose: a
-- mid-market figure is the midpoint of a spread that already exists in the market, and the
-- percentage is our estimate of the half of it the bank will take from us. The override
-- replaces that number with one we did choose — a figure read off a bank's screen — and a
-- rate a bank quotes is a *transactable* rate with the bank's own margin already inside it.
-- That is the whole reason to type one in. Applying the percentage on top would charge that
-- margin twice: roughly ฿730 of invented margin on a ฿36,500 quotation at 2%, arriving with
-- nothing on the document saying where it came from.
--
-- The rule lives in `resolveFxRate` (`packages/core/src/fx.ts`), which is the only
-- constructor of a resolved rate, so no caller can apply both by accident. Its header carries
-- the full argument, including why the spread marks the *rate* down (`mid × (1 − s)`) rather
-- than marking the customer's *amount* up (`× (1 + s)`) — the second form is short by `s²`
-- and so never quite closes the gap it exists for.
--
-- `fx_spread_bp` is deliberately not cleared when an override is set. It stays on the row, so
-- removing the override restores the previous behaviour without anybody retyping it, and so
-- `tax_country_changes` records the two independently.
--
-- ── WHY THREE COLUMNS AND NOT TWO ──────────────────────────────────────────────
--
-- The owner asked for two settings, and two settings is what this is. The third column is not
-- a third setting: it is the **unit** the second one is measured in. `fx_manual_rate =
-- 27.05` is not a rate until something says 27.05 baht per *what*, and nothing in this schema
-- mapped a destination to a currency — `tax_countries` had a code, a name and a tax rule, and
-- `user_preferences.display_currency` is a *presentation* preference belonging to a user, not
-- a fact about a destination. Without `fx_currency` the override would be a number an
-- administrator could type against the wrong currency with no constraint able to notice, and
-- `resolveFxRate` would have had to take the currency from a caller that has nowhere to get
-- it. NULL is the honest default and what Thailand keeps: quoted in baht, no conversion.
--
-- Hand-written with no snapshot, like every migration since 0028.

ALTER TABLE "tax_countries" ADD COLUMN "fx_currency" char(3);--> statement-breakpoint

-- `0` is a real setting, not a placeholder: it means "convert at mid-market". NOT NULL with
-- that default is therefore a complete answer for every existing row and needs no backfill
-- decision — unlike 0034, where the tempting default would have been an invented business
-- fact. Nothing converts anything until `fx_currency` is set, so the seeded TH row is
-- unaffected either way.
ALTER TABLE "tax_countries" ADD COLUMN "fx_spread_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- `numeric`, not `double precision` and not an integer of some invented minor unit. A rate is
-- a decimal ratio between two currencies, not an amount of either — the same call the header
-- of `fx_rates` (0033) makes about why that table stores `jsonb` rather than money columns.
-- drizzle reads a `numeric` back as an exact decimal *string*, which is what `readRatio`
-- parses as digits rather than as a float. `(20, 10)` holds both ends of `CURRENCIES`:
-- 39.xxxxxxxxxx baht per EUR and 0.0014321000 baht per VND.
ALTER TABLE "tax_countries" ADD COLUMN "fx_manual_rate" numeric(20, 10);--> statement-breakpoint

-- Membership, from the same `CURRENCIES` the schema file imports rather than a hand-copied
-- list — `user_preferences_currency_known` (0027) is built the identical way, and
-- `tests/review.test.ts` reads that one back out of `pg_constraint` to prove the pattern
-- cannot drift.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_fx_currency_known" CHECK ("tax_countries"."fx_currency" is null
          or "tax_countries"."fx_currency" in ('CNY', 'EUR', 'INR', 'LAK', 'MYR', 'SGD', 'THB', 'USD', 'VND'));--> statement-breakpoint

-- Baht to baht is not a conversion. Left legal, a destination set to THB with a 2% spread
-- would mark the domestic price up by 2% with nothing saying so — the quietest possible way
-- for this feature to overcharge. `resolveFxRate` refuses it too, so neither guard depends on
-- the other being present.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_fx_currency_not_thb" CHECK ("tax_countries"."fx_currency" is null
          or "tax_countries"."fx_currency" <> 'THB');--> statement-breakpoint

-- The ceiling is here for the same reason `tax_countries_rate_in_range` (0029) is: core bounds
-- the spread only where the arithmetic breaks — at 100%, where the effective rate is zero and
-- the division is undefined. 2,000 bp is five times the worst retail FX spread, so anything
-- above it is a typo, and `20` meant as twenty basis points but read as twenty per cent is
-- exactly the mistake this catches.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_fx_spread_in_range" CHECK ("tax_countries"."fx_spread_bp" between 0 and 2000);--> statement-breakpoint

-- A rate is a ratio *of* something. Without a currency the figure is unusable and
-- unreviewable, and the pair is the shape a half-finished edit leaves behind.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_fx_manual_rate_needs_currency" CHECK ("tax_countries"."fx_manual_rate" is null
          or "tax_countries"."fx_currency" is not null);--> statement-breakpoint

-- `readRatio` returns null for a zero or negative rate and `resolveFxRate` then refuses the
-- whole conversion, so a stored zero would be a row that silently converts nothing. Refused
-- at rest instead of discovered at quote time.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_fx_manual_rate_positive" CHECK ("tax_countries"."fx_manual_rate" is null
          or "tax_countries"."fx_manual_rate" > 0);
