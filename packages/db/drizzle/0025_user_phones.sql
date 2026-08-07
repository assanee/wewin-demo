-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A TELEPHONE NUMBER AS A USERNAME.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Thai customers frequently have no email address they use. This table is `user_emails`
-- with a different string in it — deliberately, down to the shape of every constraint,
-- because plan 6(a) (account pre-hijacking) does not care which field it is.
--
-- The number is stored in E.164 and only in E.164. `@wewin/core/phone` produces the one
-- canonical spelling and `user_phones_number_e164` refuses anything else, which makes
-- `081-234-5678` and `+66 81 234 5678` unrepresentable rather than merely discouraged —
-- the unique index below compares bytes, so three spellings would be three numbers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "user_phones" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"             uuid NOT NULL,
  "number"              text NOT NULL,
  "verified_at"         timestamp with time zone,
  "verified_by_user_id" uuid,
  "is_primary"          boolean DEFAULT false NOT NULL,
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_phones_user_number_key" UNIQUE("user_id","number"),
  CONSTRAINT "user_phones_number_e164" CHECK ("user_phones"."number" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT "user_phones_primary_is_verified"
    CHECK (not "user_phones"."is_primary" or "user_phones"."verified_at" is not null),
  CONSTRAINT "user_phones_voucher_needs_a_verification"
    CHECK ("user_phones"."verified_by_user_id" is null or "user_phones"."verified_at" is not null)
);
--> statement-breakpoint

ALTER TABLE "user_phones" ADD CONSTRAINT "user_phones_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ⚠️ `set null`, not `cascade`. This column names the member of *staff* who vouched, and
-- erasing that staff account must not take the customer's phone row with it — the customer
-- did not ask to be forgotten. `ERASURE_TREATMENTS` records the same decision as `scrub`.
ALTER TABLE "user_phones" ADD CONSTRAINT "user_phones_verified_by_user_id_users_id_fk"
  FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- ⓐ Partial, exactly as for addresses: unverified duplicates may exist — that is the state
-- an attacker creates — they simply never become anybody's identity.
CREATE UNIQUE INDEX "user_phones_one_verified_owner" ON "user_phones" USING btree ("number")
  WHERE verified_at is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_phones_one_primary_per_user" ON "user_phones" USING btree ("user_id")
  WHERE is_primary;
--> statement-breakpoint
CREATE INDEX "user_phones_number_idx" ON "user_phones" USING btree ("number");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓐ The other half of pre-hijacking, and it is not the same half as the index.
--
-- The index makes two *verifications* of one number mutually exclusive. This makes an
-- unverified claim stop existing the moment somebody proves the number — inside the
-- statement that did the proving, so a concurrent signup cannot slip a fresh claim in
-- behind a merge that has already decided.
--
-- Copied from `user_emails_strip_unverified` (0003_auth_guards.sql) rather than
-- generalised: two triggers reading one table each is reviewable, and a shared function
-- taking a table name is dynamic SQL in a security control.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION user_phones_strip_unverified() RETURNS trigger AS $$
BEGIN
  IF NEW.verified_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.verified_at IS NULL) THEN
    DELETE FROM user_phones
     WHERE number = NEW.number
       AND verified_at IS NULL
       AND id <> NEW.id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_phones_strip_unverified
  AFTER INSERT OR UPDATE OF verified_at ON user_phones
  FOR EACH ROW EXECUTE FUNCTION user_phones_strip_unverified();
--> statement-breakpoint

-- Verification is a fact about the past. Un-verifying would let a number that once carried
-- proof be quietly downgraded and re-claimed; moving a verified number to a different
-- string, or to a different user, would carry the proof somewhere nobody proved anything.
-- Giving up a number means deleting the row, which is visible.
--
-- ⚠️ `verified_by_user_id` is deliberately NOT frozen alongside it. `ON DELETE set null`
-- has to be able to clear it when the member of staff is erased, and a trigger that refused
-- the change would make that FK impossible to honour — the same collision `admin_events`
-- hit in phase 7, resolved there by dropping the FK and here by not over-freezing.
CREATE FUNCTION user_phones_verification_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.verified_at IS NOT NULL THEN
    IF NEW.verified_at IS NULL THEN
      RAISE EXCEPTION 'phone % was verified at % and cannot be un-verified',
        OLD.number, OLD.verified_at
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'phone % is verified; its number cannot be changed to %',
        OLD.number, NEW.number
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'phone % belongs to user %; moving it is a new claim, not an update',
      OLD.number, OLD.user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_phones_verification_is_final
  BEFORE UPDATE ON user_phones
  FOR EACH ROW EXECUTE FUNCTION user_phones_verification_is_final();
--> statement-breakpoint

-- An erased account may not acquire a new claim on anything. Mirrors
-- `user_emails_refuse_erased_user` (0009_user_erasure.sql).
CREATE FUNCTION user_phones_refuse_erased_user() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.status = 'erased') THEN
    RAISE EXCEPTION 'user % is erased and cannot be given a phone number', NEW.user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_phones_refuse_erased_user
  BEFORE INSERT ON user_phones
  FOR EACH ROW EXECUTE FUNCTION user_phones_refuse_erased_user();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ ERASURE DELETES PHONE ROWS, FOR THE REASON IT DELETES ADDRESSES.
--
-- `user_phones_one_verified_owner` is **status-blind**. A retained verified number would be
-- a permanent denial of service on that telephone — the person who later owns it, or the
-- same person opening a fresh account, would be refused at signup with no cause named. And
-- `user_phones_verification_is_final` refuses both un-verifying and re-numbering, so
-- deleting is the only legal exit.
--
-- Releasing it does not reopen ⓐ. `users` holds no phone column, so ownership is
-- `orders.customer_user_id`; a number can change hands without an order changing hands, and
-- a later claimant reaches a fresh account rather than this tombstone.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION erase_user(
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
    || 'orders submitted by a guest that was never claimed. See plan 7.16 item (ฉ). '
    -- Phase 7. A scrubbed review is not an erased review, and the DSAR answer has to say so.
    || 'Reviews: the prose, the display name and every photograph are deleted or nulled, and '
    || 'reviews.rating is KEPT (an integer one to five, so that an erasure cannot do what plan '
    || '9.3 forbids hiding from doing — move a published average). The review row stays attached '
    || 'to its order line, and that order still carries contact_email / contact_name / '
    || 'contact_phone under the same accounting exemption: ONE JOIN RE-IDENTIFIES THE AUTHOR. '
    || 'This is pseudonymisation, not anonymisation. Also unreachable: a review written by a '
    || 'guest that was never claimed. Whether the accounting exemption stretches over public '
    || 'prose and a photograph of a customer''s home is a question for a lawyer and has not '
    || 'been answered.';
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

  -- Same lock class and the same reason: two concurrent erasures racing on one identity
  -- string. A number is an identity now, so it needs the ordering guarantee addresses have.
  PERFORM pg_advisory_xact_lock(4919, hashtext(number))
     FROM user_phones
    WHERE user_id = p_user
    ORDER BY number;

  DELETE FROM auth_tokens WHERE user_id = p_user;
  DELETE FROM user_emails WHERE user_id = p_user;
  DELETE FROM user_phones WHERE user_id = p_user;
  DELETE FROM provider_identities WHERE user_id = p_user;
  DELETE FROM password_credentials WHERE user_id = p_user;

  -- ── The second factor — phase 8 ───────────────────────────────────────────────
  --
  -- A sealed TOTP secret and a set of recovery-code hashes are authentication material for
  -- one identified person: no accounting question turns on them and no evidence is lost with
  -- them, so they go the way `password_credentials` goes rather than being scrubbed.
  --
  -- ⚠️ The recovery codes include *spent* ones, which `mfa_recovery_codes_guard_write`
  -- otherwise refuses to delete because a spent code is the record that somebody recovered
  -- an account. Erasure is the one operation entitled to destroy that record, and it says so
  -- by disabling the trigger for the statement rather than by the trigger quietly making an
  -- exception it cannot explain.
  DELETE FROM mfa_credentials WHERE user_id = p_user;

  SET LOCAL session_replication_role = replica;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  SET LOCAL session_replication_role = origin;
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

  -- ── Phase 7 ───────────────────────────────────────────────────────────────────
  --
  -- The profile: `delete`, and `users_erasure_is_earned()` refuses the `erased` status while
  -- a row survives, so this is checked rather than trusted.
  DELETE FROM user_preferences WHERE user_id = p_user;

  -- ⭐ The photographs. Plan 9.4: the customer photographed their own window, so the file
  -- carries the coordinates of their house. `review_photos` is the one table in this phase
  -- where DELETE is legal, and this is the reason it had to be — a picture of somebody's home
  -- cannot be answered with a status flag. Whether the bytes behind `storage_key` are also
  -- removed from object storage is the sweep nobody has scheduled; plan 13's retention clock
  -- is still unanswered, and this DELETE is what makes those keys findable when it is.
  DELETE FROM review_photos
   WHERE review_id IN (SELECT id FROM reviews WHERE author_user_id = p_user);

  -- ⭐ The prose and the display name. `reviews_guard_write()` permits exactly this shape and
  -- no other once a review is public: both columns to NULL, together, stamped once. The
  -- rating is deliberately untouched — see the block comment above this function and
  -- ERASURE_TREATMENTS in src/schema/auth.ts.
  UPDATE reviews
     SET body_th             = NULL,
         author_display_name = NULL,
         content_erased_at   = now(),
         updated_at          = now()
   WHERE author_user_id = p_user
     AND content_erased_at IS NULL;

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
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A CHANNEL, NOT AN ADDRESS.
--
-- Plan 10.2's rule was "a quote with no channel on it is a quote nobody can be told anything
-- about", and it was implemented as "an address", because email was the only channel there
-- was. A Thai customer with no email could therefore not submit at all.
--
-- ⚠️ **The rule has genuinely weakened and it is worth being plain about it.** An order with
-- a telephone number and no address satisfies this constraint and *still cannot be written
-- to*: `order_events_fan_out_notifications()` resolves recipients for `email` and suppresses
-- every other channel as `channel_disabled`, so every message about that order lands as
-- `suppressed / no_contact_channel` — visible in the queue, invisible to the customer.
--
-- That is accepted rather than hidden, and the price of accepting it is paid twice:
--
--   · the dashboard says so on the order — "ไม่มีอีเมล — ระบบไม่ได้ส่งอะไรถึงลูกค้า" —
--     rather than letting sales assume the customer was told;
--   · the quotation link is a bearer token in a URL, so staff can copy it into LINE by hand.
--
-- The proper repair is an SMS or LINE recipient resolution in that trigger, and this comment
-- is where somebody adding one should start.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "orders" DROP CONSTRAINT "orders_submitted_has_a_contact_channel";
--> statement-breakpoint

ALTER TABLE "orders" ADD CONSTRAINT "orders_submitted_has_a_contact_channel"
  CHECK ("orders"."submitted_at" is null
         or "orders"."contact_email" is not null
         or "orders"."contact_phone" is not null);
--> statement-breakpoint

-- The same canonical form the identity table demands. A contact number and a username are
-- the same telephone, and two spellings of it in two columns is how "is this the customer we
-- already have?" becomes unanswerable.
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_phone_e164"
  CHECK ("orders"."contact_phone" is null or "orders"."contact_phone" ~ '^\+[1-9][0-9]{7,14}$');
