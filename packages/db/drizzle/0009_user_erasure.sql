-- ─────────────────────────────────────────────────────────────────────────────
-- DELETION IS A STATUS FLAG — plan 7.15 item 1, answered by the business owner:
--
--   "การลบข้อมูลให้ใช้การ flag status เท่านั้นจะไม่ใช่การลบจริง"
--
-- That answers the question the phase-5a `ON DELETE RESTRICT` on `orders.customer_user_id`
-- was waiting on: nothing gets deleted, so the restriction never fires. It does NOT, on
-- its own, answer PDPA. A flag hides a row; erasure requires the personal data to be gone,
-- and a design that does only the first while calling it deletion is this project's
-- recurring failure — the tool reports success and the work did not happen.
--
-- So this migration ships two operations and refuses to let one be mistaken for the other.
--
--   close_user()   the owner's decision, exactly. Sign-in refused, every session revoked,
--                  NOTHING scrubbed, the verified address still held. Reversible, and
--                  genuinely so: `IdentityLinkService` reinstates a closed account when the
--                  person proves control of it again through a provider. A cooling-off
--                  state whose only exit is an UPDATE nobody can issue is not reversible,
--                  it is a slower dead end.
--
--   erase_user()   the scrub has run. Terminal. Every credential and every lookup key is
--                  DELETED; the `users` row survives as a tombstone that carries no
--                  personal data and that nothing can authenticate as.
--
-- ── THE ENFORCEMENT ARGUMENT, WHICH IS THE WHOLE POINT OF THIS FILE ──────────────
--
-- The obvious design is a CHECK per scrub target keyed on the status:
-- `status <> 'erased' or display_name is null`. That was proposed, and it is not enough,
-- for a reason that is structural rather than a detail: **every constraint on `users` is a
-- same-row check, and every scrub target except `display_name` is a different row.** A
-- single hand-written
--
--   UPDATE users SET status='erased', erased_at=now(), display_name=NULL WHERE id = …;
--
-- satisfies every such CHECK and commits a row that says `erased` with the email address,
-- the provider identity, the password hash and a live session all still attached. Worse
-- than a no-op: the terminal-state trigger then makes it permanent, the customer is locked
-- out for good, and a DSAR audit reading `users.status` is told the erasure ran.
--
-- The invariant is cross-row, so the enforcement is a trigger: `users_erasure_is_earned()`
-- refuses the transition into `erased` unless the scrub has demonstrably already happened
-- and a paper-trail row exists **in the same transaction** — the `write_txid` /
-- `pg_current_xact_id()` mechanism `notifications_guard_insert()` (0007_order_guards.sql)
-- already uses to make "written by the transaction that caused it" a database rule.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────────
--
-- It does not touch `orders.contact_email/name/phone`, `order_events.payload` or
-- `notification_attempts.recipient_key`. Those hold real personal data, they are outside
-- this round's ownership (packages/db/src/schema/order.ts), and two of the three refuse
-- UPDATE outright. `erase_user()` therefore records what it withheld, in words, on the
-- request row — so "we erased you" is never a claim the database makes about data it did
-- not reach. Plan 7.15 item 1 carries the full escalation.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The two enums that must stop being enums ────────────────────────────────────
--
-- `user_status` grows by two members here and `session_revocation_reason` by one. Verified
-- against this project's own server (PostgreSQL 18.4): `ALTER TYPE … ADD VALUE` followed by
-- a statement that USES the new value in the same transaction raises
--
--   ERROR: unsafe use of new value "…" of enum type …
--   HINT:  New enum values must be committed before they can be used.
--
-- and drizzle's migrator runs each file in one transaction (src/test-database.ts). So a
-- migration that adds `account_closed` and then revokes the sessions of accounts closed by
-- the same release cannot exist. `ALTER TYPE … ADD VALUE` also cannot be rolled back, which
-- is the reason `order.ts` moved order statuses to `text` + CHECK after that set grew once
-- having been called final. Same argument, same remedy, applied before the rake rather
-- than after it.
--
-- ⚠️ The CHECK has to come off first, and this is not a formality. `ALTER COLUMN … TYPE`
-- re-plans every constraint on the table against the new type, and
-- `users_suspended_at_present` compares the column to a literal that Postgres had already
-- resolved as `user_status`: the conversion fails with
--
--   ERROR: operator does not exist: text <> user_status
--
-- The migration drizzle-kit generates for this schema change does NOT contain these two
-- lines and therefore does not apply. Found by running it, not by reading it.
ALTER TABLE "users" DROP CONSTRAINT "users_suspended_at_present";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_suspended_at_present"
  CHECK ("users"."status" <> 'suspended' OR "users"."suspended_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_known"
  CHECK ("users"."status" IN ('active', 'suspended', 'closed', 'erased'));--> statement-breakpoint

ALTER TABLE "sessions" ALTER COLUMN "revoked_reason" TYPE text USING "revoked_reason"::text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason_known"
  CHECK ("sessions"."revoked_reason" IS NULL OR "sessions"."revoked_reason" IN
    ('logout', 'refresh_reuse', 'password_changed', 'email_changed', 'revoked_by_admin', 'account_closed'));--> statement-breakpoint

DROP TYPE "public"."user_status";--> statement-breakpoint
DROP TYPE "public"."session_revocation_reason";--> statement-breakpoint

-- ── The two timestamps, shape-checked one way only ──────────────────────────────
--
-- One-way implications and not biconditionals, copying `users_suspended_at_present`. A
-- biconditional on `closed_at` reads stricter and makes the erasure of a closed account
-- unrepresentable: the UPDATE to `erased` would have to NULL `closed_at` to satisfy it,
-- destroying the date the customer asked — the one fact that proves the cooling-off period
-- was honoured.
ALTER TABLE "users" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_closed_at_present"
  CHECK ("users"."status" <> 'closed' OR "users"."closed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_erased_at_present"
  CHECK ("users"."status" <> 'erased' OR "users"."erased_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_erased_at_shape"
  CHECK ("users"."erased_at" IS NULL OR "users"."status" = 'erased');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_erased_has_no_name"
  CHECK ("users"."status" <> 'erased' OR "users"."display_name" IS NULL);--> statement-breakpoint

-- ── The paper trail ─────────────────────────────────────────────────────────────
CREATE TABLE "user_erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"channel" text NOT NULL,
	"legal_basis" text NOT NULL,
	"completed_at" timestamp with time zone,
	"withheld_scope" text,
	"scrub_schema_version" integer DEFAULT 1 NOT NULL,
	"write_txid" text NOT NULL,
	CONSTRAINT "user_erasure_requests_channel_present" CHECK (length(btrim("user_erasure_requests"."channel")) > 0),
	CONSTRAINT "user_erasure_requests_basis_present" CHECK (length(btrim("user_erasure_requests"."legal_basis")) > 0),
	CONSTRAINT "user_erasure_requests_completed_after_requested" CHECK ("user_erasure_requests"."completed_at" IS NULL OR "user_erasure_requests"."completed_at" >= "user_erasure_requests"."requested_at")
);--> statement-breakpoint
ALTER TABLE "user_erasure_requests" ADD CONSTRAINT "user_erasure_requests_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_erasure_requests" ADD CONSTRAINT "user_erasure_requests_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_erasure_requests_user_idx" ON "user_erasure_requests" USING btree ("user_id");--> statement-breakpoint

-- The record of an erasure cannot be erased by one. Same shape as
-- `notification_attempts_append_only` (0007_order_guards.sql), and for the same reason:
-- without it the durable fact is the irreversible one and the record justifying it is the
-- one anybody can rewrite, which is exactly backwards for a DSAR.
CREATE FUNCTION user_erasure_requests_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'user_erasure_requests is append-only; request % is what was asked and what was done', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER user_erasure_requests_append_only
  BEFORE UPDATE OR DELETE ON user_erasure_requests
  FOR EACH ROW EXECUTE FUNCTION user_erasure_requests_append_only();--> statement-breakpoint

-- ── `erased` is a claim the database checks, not a job's promise ────────────────
--
-- Mutation-tested by removing one conjunct at a time; each removal turns
-- packages/db/tests/erasure.test.ts red on its own. See the results table in plan 7.15.
CREATE FUNCTION users_erasure_is_earned() RETURNS trigger AS $$
DECLARE
  survivor text;
BEGIN
  -- Terminal, in the direction that matters. Note this check is AFTER the earning check
  -- below in importance but BEFORE it in order, because a row that reached `erased`
  -- dishonestly must not also be un-erasable — and under this trigger it cannot reach it.
  IF OLD.status = 'erased' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'user % is erased; that is not a state it can leave', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status <> 'erased' OR OLD.status = 'erased' THEN
    RETURN NEW;
  END IF;

  -- Erasure is reachable from closure and from nowhere else. Not pedantry: `closed` is
  -- what gives the customer a dated, reversible window in which to change their mind, and
  -- an `active → erased` path is that window removed for whoever calls the function
  -- fastest.
  IF OLD.status <> 'closed' THEN
    RAISE EXCEPTION 'user % is % ; erasure is reachable from closed and nothing else', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The cross-row half. One query per table rather than one clever union, so the error
  -- message names the table that is still holding a credential.
  SELECT t INTO survivor FROM (
    SELECT 'user_emails' AS t WHERE EXISTS (SELECT 1 FROM user_emails WHERE user_id = NEW.id)
    UNION ALL
    SELECT 'provider_identities' WHERE EXISTS (SELECT 1 FROM provider_identities WHERE user_id = NEW.id)
    UNION ALL
    SELECT 'password_credentials' WHERE EXISTS (SELECT 1 FROM password_credentials WHERE user_id = NEW.id)
    UNION ALL
    SELECT 'auth_tokens' WHERE EXISTS (SELECT 1 FROM auth_tokens WHERE user_id = NEW.id)
    UNION ALL
    SELECT 'sessions' WHERE EXISTS (SELECT 1 FROM sessions WHERE user_id = NEW.id)
  ) surviving LIMIT 1;

  IF survivor IS NOT NULL THEN
    RAISE EXCEPTION 'user % still has rows in %; a half-run scrub cannot commit a row that says erased', NEW.id, survivor
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The paper trail, in this transaction. `write_txid` is compared rather than merely
  -- required to exist, so a request row written last week cannot authorise a scrub today.
  IF NOT EXISTS (
    SELECT 1 FROM user_erasure_requests r
     WHERE r.user_id = NEW.id
       AND r.completed_at IS NOT NULL
       AND r.write_txid = pg_current_xact_id()::text
  ) THEN
    RAISE EXCEPTION 'user % has no completed erasure request in this transaction; an erasure nobody can describe afterwards is not an erasure', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER users_erasure_is_earned
  BEFORE UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION users_erasure_is_earned();--> statement-breakpoint

-- ── Nothing may attach a credential to a tombstone ──────────────────────────────
--
-- No path today does this: after `erase_user()` there is no `sub` and no verified address
-- left for `IdentityLinkService` branches 1 and 2 to match, so a returning person lands in
-- branch 3 and gets a fresh account. That is exactly why the guard is worth writing now —
-- the absence of it is invisible until a new caller exists, and phase 6's "add an email to
-- this account" admin action is that caller.
--
-- `FOR SHARE` and not a bare read. A concurrent OAuth sign-in that reads `status='active'`
-- while `erase_user()` is mid-flight would otherwise commit a provider identity onto a row
-- that says `erased` — reproduced with two connections before this line existed. The share
-- lock makes the reader wait on `erase_user()`'s `FOR UPDATE`, which is the same remedy
-- 0004_auth_hardening.sql applied to the address race.
CREATE FUNCTION auth_rows_refuse_erased_user() RETURNS trigger AS $$
DECLARE
  owner_status text;
BEGIN
  SELECT u.status INTO owner_status FROM users u WHERE u.id = NEW.user_id FOR SHARE;

  IF owner_status = 'erased' THEN
    RAISE EXCEPTION 'user % is erased; % cannot gain a row that would make it reachable again',
      NEW.user_id, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER user_emails_refuse_erased_user
  BEFORE INSERT ON user_emails
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint
CREATE TRIGGER provider_identities_refuse_erased_user
  BEFORE INSERT ON provider_identities
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint
CREATE TRIGGER password_credentials_refuse_erased_user
  BEFORE INSERT ON password_credentials
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint
CREATE TRIGGER auth_tokens_refuse_erased_user
  BEFORE INSERT ON auth_tokens
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint
CREATE TRIGGER sessions_refuse_erased_user
  BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint
CREATE TRIGGER user_groups_refuse_erased_user
  BEFORE INSERT ON user_groups
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();--> statement-breakpoint

-- ── A status that leaves `active` takes the sessions with it ────────────────────
--
-- There was no trigger on `users` at all before this one, which meant suspending an
-- account wrote a column and did nothing else: enforcement was entirely the per-request
-- read in `RbacGuard`, `sessions.revoked_at` stayed NULL forever, and the user's own device
-- list — the stated reason `user_agent` and `ip` exist — showed live sessions for a closed
-- account. `sessions_revoke_cascade` (0003_auth_guards.sql) then stamps the refresh tokens
-- for free, which is what makes `rotate_refresh_token()`'s claim UPDATE find nothing.
--
-- `account_closed` and not `revoked_by_admin`: the latter is factually wrong when the
-- customer is the one who asked, and this enum is small enough that the wrong word would be
-- used forever once chosen.
CREATE FUNCTION users_status_revoke_sessions() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE sessions
       SET revoked_at = now(),
           revoked_reason = CASE WHEN NEW.status = 'suspended' THEN 'revoked_by_admin' ELSE 'account_closed' END
     WHERE user_id = NEW.id
       AND revoked_at IS NULL;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER users_status_revoke_sessions
  AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION users_status_revoke_sessions();--> statement-breakpoint

-- ── close_user(): the owner's decision, exactly ────────────────────────────────
CREATE FUNCTION close_user(p_user uuid) RETURNS void AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM users WHERE id = p_user FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such user: %', p_user USING ERRCODE = 'no_data_found';
  END IF;

  IF current_status = 'erased' THEN
    RAISE EXCEPTION 'user % is erased; that is not a state it can leave', p_user
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF current_status = 'closed' THEN
    RETURN;
  END IF;

  UPDATE users SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = p_user;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── erase_user(): the scrub, and the only thing that may write `erased` ─────────
--
-- Order of operations is load-bearing and each step is here for a named reason:
--
--   1. `FOR UPDATE` on the user first, so a concurrent sign-in taking `FOR SHARE` in
--      `auth_rows_refuse_erased_user` blocks rather than racing.
--   2. `pg_advisory_xact_lock(4919, hashtext(address))` per address, in a deterministic
--      order. 0004_auth_hardening.sql reserved that namespace and takes the lock on INSERT
--      and on verification; erasure introduces DELETE as a third concurrent writer of one
--      address and without this line the comment at 0004:16-30 covers two operations out of
--      three. ORDER BY so two erasures sharing an unverified claim cannot deadlock.
--   3. DELETE the credentials and lookup keys.
--   4. INSERT the paper trail — before the status write, because the trigger requires it.
--   5. UPDATE the status, which is where `users_erasure_is_earned` checks all of the above.
--
-- **`user_emails` rows are DELETED, never scrubbed**, and that is not a preference:
-- `user_emails_verification_is_final` (0003_auth_guards.sql) refuses both un-verifying a
-- row and changing a verified address, and is right to. Deleting is the only legal exit and
-- is the only thing that releases `user_emails_one_verified_owner` — which is status-blind,
-- so a retained verified address is a permanent denial of service on that mailbox across
-- every provider, surfacing months later at signup as an opaque refusal that names no
-- cause. That release does not reopen pre-hijacking ⓐ: `users` holds no address column, so
-- ownership is `orders.customer_user_id` and an address can change hands without an order
-- changing hands. A later attacker who proves the freed mailbox reaches branch 3 and a
-- fresh account, not this tombstone.
--
-- SECURITY INVOKER (the default) on purpose. Nothing here needs privileges the caller does
-- not have, and a SECURITY DEFINER function is a standing capability to erase anybody.
CREATE FUNCTION erase_user(
  p_user         uuid,
  p_requested_by uuid,
  p_channel      text,
  p_legal_basis  text
) RETURNS uuid AS $$
DECLARE
  current_status text;
  request_id     uuid;
  withheld       text :=
    'Withheld under the accounting exemption and outside this round''s ownership: '
    || 'orders.contact_email/contact_name/contact_phone (orders_submitted_has_a_contact_channel '
    || 'refuses a NULL address on a submitted order — so a NEW event on a retained order '
    || 'still fans out to that address; the outbox refuses it only for orders whose '
    || 'customer_user_id is this account), order_events.payload free text (append-only by '
    || 'trigger; required_payload_keys mandates a reason on post-freeze cancellation), and '
    || 'notification_attempts.recipient_key (the attempt log refuses UPDATE and DELETE, so '
    || 'every address a message was ever SENT to survives). Also unreachable from a user id: '
    || 'orders submitted by a guest that was never claimed. See plan 7.16 item (ฉ).';
BEGIN
  SELECT status INTO current_status FROM users WHERE id = p_user FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such user: %', p_user USING ERRCODE = 'no_data_found';
  END IF;

  IF current_status = 'erased' THEN
    RAISE EXCEPTION 'user % is already erased', p_user USING ERRCODE = 'restrict_violation';
  END IF;

  IF current_status <> 'closed' THEN
    RAISE EXCEPTION 'user % is %; close the account before erasing it', p_user, current_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(4919, hashtext(address))
     FROM user_emails
    WHERE user_id = p_user
    ORDER BY address;

  DELETE FROM auth_tokens WHERE user_id = p_user;
  DELETE FROM user_emails WHERE user_id = p_user;
  DELETE FROM provider_identities WHERE user_id = p_user;
  DELETE FROM password_credentials WHERE user_id = p_user;
  -- Cascades to refresh_tokens. `sessions.ip` and `user_agent` are location and device
  -- data with no accounting value whatsoever.
  DELETE FROM sessions WHERE user_id = p_user;

  -- The guest cookie becomes unpresentable. `GuestRepository.isOpenGuest` already treats a
  -- NULL secret as "can never again be presented as a cookie", so this revokes without
  -- inventing anything. The claim link itself stays: it is a uuid pointing at a tombstone.
  UPDATE guests SET secret_hash = NULL WHERE claimed_by_user_id = p_user;

  -- ── The outbox, which is where "flag the row" stops being enough ──────────────
  --
  -- Found by exercising this function, not by reading it. Before this block:
  --
  --   1. a message queued *before* the erasure kept `recipient_key = 'email:<them>'`,
  --      stayed `pending`, and was claimed and DELIVERED by the worker minutes after the
  --      erasure committed — a real message to somebody who had asked to be forgotten,
  --      sent by a system whose `users` row said `erased`;
  --   2. a `dead` message to the same address kept its retry button, so the same delivery
  --      could be re-attempted by hand months later.
  --
  -- Suppression and not deletion, and the distinction is the whole design: `notifications`
  -- is the record of what the company told the customer, and destroying it would answer a
  -- PDPA request by deleting the evidence that the request was honoured. What is removed is
  -- the *address*; what remains is a row saying a message existed and was not sent, and why.
  --
  -- Scoped by `orders.customer_user_id` and NOT by address. Matching on the address would
  -- silently answer the question this round escalates instead — การลบ ของใคร, of an account
  -- or of a person — by also suppressing a guest's messages that happen to share a mailbox.
  -- The unit of erasure here is the account, and that is a decision the owner has not made
  -- yet. Plan 7.16(ฉ) item 4.
  --
  -- `recipient_kind = 'customer'` only. `group:sales_queue` messages about the same order are
  -- the company talking to itself about an accounting record it is keeping; suppressing them
  -- would answer a customer's erasure by breaking the company's own workflow.
  --
  -- `pending` and `dead`, deliberately not `sending`. A `sending` row is one a worker has
  -- already claimed and may already have handed to SMTP: suppressing it would race the
  -- worker's own bookkeeping and could not un-send anything. So the honest limit of this
  -- block is stated rather than hidden — **a message already in flight cannot be recalled**,
  -- and `pg_advisory_xact_lock` cannot help because the worker's claim is a different lock on
  -- a different table. The window is one poll interval wide.
  --
  -- `dead_at` is deliberately left set on a row that was dead. It is the record of the
  -- failures that happened, `notifications_status_shape` does not object (the `suppressed`
  -- arm checks only the reason and the address), and clearing it would lose the one fact
  -- explaining why the row has three attempts on it.
  UPDATE notifications n
     SET status            = 'suppressed',
         suppressed_reason = 'recipient_erased',
         recipient_key     = NULL,
         updated_at        = now()
   WHERE n.status IN ('pending', 'dead')
     AND n.recipient_kind = 'customer'
     AND n.recipient_key IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM orders o WHERE o.id = n.order_id AND o.customer_user_id = p_user
     );

  INSERT INTO user_erasure_requests
    (user_id, requested_by_user_id, channel, legal_basis, completed_at, withheld_scope, write_txid)
  VALUES
    (p_user, p_requested_by, p_channel, p_legal_basis, now(), withheld, pg_current_xact_id()::text)
  RETURNING id INTO request_id;

  UPDATE users
     SET status = 'erased',
         erased_at = now(),
         display_name = NULL,
         updated_at = now()
   WHERE id = p_user;

  RETURN request_id;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── The other half of the outbox, which erase_user() cannot reach ───────────────
--
-- Suppressing what is already queued closes yesterday's messages. It does nothing about
-- tomorrow's, and this was the sharper half when it was run: an order retained under the
-- accounting exemption keeps `orders.contact_email`, so the very next event on it —
-- `change_resolved`, a staff-side transition, anything on the spine — resolved that address
-- again and queued a fresh `pending` message to a person the database says is erased.
--
-- `orders_submitted_has_a_contact_channel` refuses to let that column be nulled on a
-- submitted order, and it is right to: an invoice with no buyer on it is not an invoice.
-- Both rules are correct and they collide, exactly as `notification_attempts_append_only`
-- collides with "a draft cart must be erasable" (0007). The resolution is to separate what
-- is *kept* from what may be *used*: the order goes on holding the contact for the accounts,
-- and the outbox refuses to address it.
--
-- Reproduced from 0007_order_guards.sql with one added branch and nothing else changed.
-- CREATE OR REPLACE and not an edit to 0007: that file has shipped, and rewriting an applied
-- migration changes its hash and diverges every database that already ran it.
--
-- ⚠️ WHAT THIS STILL DOES NOT COVER, stated because a green test here would otherwise imply
-- it: an order submitted by a guest who never signed in has `customer_user_id IS NULL` and
-- reaches `users` through no foreign key at all. There is nothing for this branch to read.
-- That is not an oversight in this function, it is the unanswered business question — the
-- unit of erasure is an account today, and if the answer is "a person" the key is an address
-- and this branch is the wrong shape. Plan 7.16(ฉ) item 4.
CREATE OR REPLACE FUNCTION order_events_fan_out_notifications() RETURNS trigger AS $$
DECLARE
  parent   orders%ROWTYPE;
  rule     notification_rules%ROWTYPE;
  address  text;
  key      text;
  reason   text;
BEGIN
  SELECT * INTO parent FROM orders WHERE id = NEW.order_id;

  FOR rule IN
    SELECT * FROM notification_rules r
     WHERE r.event_type = NEW.event_type AND r.is_enabled
  LOOP
    key := NULL;
    reason := NULL;

    IF rule.recipient_kind = 'customer' THEN
      -- Asked first, and before the channel, because it is true of every channel: there is
      -- nobody to write to. Checked against `users.status` rather than against a column on
      -- the order, so it cannot drift out of step with the erasure — an order can only be
      -- addressable again if the account leaves `erased`, and `users_erasure_is_earned`
      -- guarantees it never does.
      IF parent.customer_user_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM users u WHERE u.id = parent.customer_user_id AND u.status = 'erased'
         ) THEN
        reason := 'recipient_erased';
      ELSIF rule.channel = 'email' THEN
        -- A signed-in customer is reached at the address they proved (auth's
        -- `user_emails_primary_is_verified` guarantees a primary one is verified); a guest
        -- at the address they gave when they asked for the quote (plan 10.2).
        SELECT e.address INTO address
          FROM user_emails e
         WHERE e.user_id = parent.customer_user_id AND e.is_primary;

        address := coalesce(address, parent.contact_email);

        IF address IS NULL THEN
          reason := 'no_contact_channel';
        ELSE
          key := 'email:' || address;
        END IF;
      ELSE
        -- LINE is a legal channel with no address book yet (plan 13: email only until the
        -- owner answers). Suppressed *visibly* rather than skipped, because a message that
        -- was never queued is a message nobody can discover was never sent.
        reason := 'channel_disabled';
      END IF;
    ELSE
      key := 'group:' || rule.recipient_kind;
    END IF;

    INSERT INTO notifications (
      order_id, event_id, latest_event_id,
      recipient_kind, recipient_key, channel, template_key,
      status, suppressed_reason, coalesce_key, send_after
    )
    VALUES (
      NEW.order_id, NEW.id, NEW.id,
      rule.recipient_kind, key, rule.channel, rule.template_key,
      CASE WHEN reason IS NULL THEN 'pending' ELSE 'suppressed' END,
      reason,
      CASE WHEN reason IS NULL THEN rule.coalesce_group ELSE NULL END,
      now() + make_interval(secs => rule.coalesce_seconds)
    )
    -- Plan 10.5(2). `send_after` is deliberately NOT pushed back: the window starts at the
    -- first event of the storm, so five edits in ten minutes are one message ten minutes
    -- after the first — not a message that recedes for as long as somebody keeps typing.
    ON CONFLICT (order_id, coalesce_key, recipient_key, channel)
      WHERE status = 'pending' AND coalesce_key IS NOT NULL
    DO UPDATE SET
      latest_event_id = EXCLUDED.latest_event_id,
      coalesced_count = notifications.coalesced_count + 1,
      updated_at      = now();
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
