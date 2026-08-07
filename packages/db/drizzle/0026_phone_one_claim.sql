-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ ONE CLAIM PER NUMBER, SO SIGN-IN HAS ONE ANSWER.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `0025_user_phones.sql` copied `user_emails` field for field, **including its partial
-- unique index**: unverified duplicates allowed, at most one verified owner. That is right
-- for an address and wrong for a number, and the reason is what each is used for.
--
--   "Which account claimed this?"  — asked at sign-in. Needs exactly one answer.
--   "Does this really belong to them?" — asked when staff attach an order. Needs proof.
--
-- An address answers both at once because proving one is free: a link, and the unverified
-- state lasts minutes. A number has no free proof — Thai SMS is charged per message and the
-- owner has chosen not to spend it — so gating sign-in on `verified_at` meant somebody who
-- registered with a number waited for a telephone call before they could get in. Not
-- self-service, which is the whole reason a number became a username.
--
-- ── ⚠️ What this costs, and why it is accepted ───────────────────────────────
--
-- Plan 6(a) pre-hijacking stops being a takeover and becomes a **denial of service**:
-- somebody can claim a number that is not theirs and the real owner cannot then register it.
-- They telephone, and a member of staff resolves it.
--
-- What the squatter does not get is anything of the victim's, and that is the invariant to
-- protect: **nothing attaches to an unverified number.**
-- `user_phones_primary_is_verified` refuses to make one the number of record, and every
-- staff lookup filters on `verified_at`.
--
-- ⚠️ Password reset must never accept a number. Email-only is load-bearing now rather than
-- incidental — a reset to an unverified claim turns the denial of service back into a
-- takeover.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX "user_phones_one_verified_owner";
--> statement-breakpoint

-- Subsumed: `(user_id, number)` cannot be violated once `number` alone is unique.
ALTER TABLE "user_phones" DROP CONSTRAINT "user_phones_user_number_key";
--> statement-breakpoint

ALTER TABLE "user_phones" ADD CONSTRAINT "user_phones_number_key" UNIQUE("number");
--> statement-breakpoint

-- ⚠️ Dropped, not kept as a safety net.
--
-- It deleted *other* unverified rows for a number when one was proved, which was the second
-- half of closing pre-hijacking while duplicates existed. Duplicates can no longer exist, so
-- it has nothing to delete — and leaving it would be worse than useless: it would read as
-- though displacement still happens automatically, when in fact a squatted number is now
-- resolved by a person, visibly, and should be.
DROP TRIGGER "user_phones_strip_unverified" ON "user_phones";
--> statement-breakpoint
DROP FUNCTION "user_phones_strip_unverified"();
