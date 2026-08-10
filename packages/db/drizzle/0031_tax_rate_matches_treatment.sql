-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A RATE THAT AGREES WITH WHAT IT CLAIMS TO BE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Found in review of 0029: nothing stopped `('SG', …, rate_bp = 900, treatment =
-- 'zero_rated')` from storing. That row computes ฿0 VAT — `charges()` in
-- packages/core/src/vat.ts requires `treatment = 'standard'` before it charges anything —
-- and prints "VAT 9%" regardless, because packages/core/src/quotation.ts renders
-- `String(document.vatRateBp / 100)` with no awareness of `treatment` at all. Spec §8.3
-- chose that renderer deliberately ("VAT 0%" is correct wording on a Thai export invoice),
-- and that choice is safe only while a non-`standard` treatment always carries a zero rate.
--
-- `standard` at 0 bp stays legal: `assertRate`/`charges()` already treat `standard` at 0 bp
-- as filing differently from `exempt`, and this CHECK only forbids the reverse pairing — a
-- non-`standard` treatment with a nonzero rate.
ALTER TABLE "tax_countries" ADD CONSTRAINT "tax_countries_rate_matches_treatment"
  CHECK ("treatment" = 'standard' OR "rate_bp" = 0);
