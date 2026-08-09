-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ ERASURE REACHES THE ORGANISATION ACTORS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `bank_accounts.updated_by_user_id`, `bank_account_changes.changed_by_user_id` and
-- `organisation_profile.updated_by_user_id` each name the member of *staff* who last
-- touched a payment record or the company profile — never the customer being erased.
-- The FK is `ON DELETE SET NULL`, which fires only on a literal `DELETE FROM users`, and
-- erasure does not delete the user row; it scrubs and closes. So `erase_user()` has to
-- null these three explicitly, the same way it already nulls
-- `user_phones.verified_by_user_id` (0025_user_phones.sql): the record that a change
-- happened survives, and only the name of who made it is removed. See
-- `ERASURE_TREATMENTS` in src/schema/auth.ts and packages/db/tests/erasure.test.ts.
--
-- `erase_user()`'s body below is carried **unchanged** from `pg_proc.prosrc` as dumped
-- after 0027, plus exactly the three `UPDATE` statements in the new "organisation actors"
-- block near the end. Nothing else in this function was rewritten.
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

  UPDATE bank_accounts SET updated_by_user_id = NULL WHERE updated_by_user_id = p_user;

  -- `bank_account_changes_append_only` is BEFORE UPDATE OR DELETE and refuses this exact
  -- statement otherwise — proved by running it without the bypass and watching every test in
  -- this file that reaches `erase_user()` fail with "bank_account_changes is append-only".
  -- Same bypass, same reasoning as the recovery-codes DELETE above: the trigger is right to
  -- refuse an ordinary caller and wrong to refuse this one.
  SET LOCAL session_replication_role = replica;
  UPDATE bank_account_changes SET changed_by_user_id = NULL WHERE changed_by_user_id = p_user;
  SET LOCAL session_replication_role = origin;

  UPDATE organisation_profile SET updated_by_user_id = NULL WHERE updated_by_user_id = p_user;

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
