-- The rules of a review that are not tables: five functions, six triggers, two views, and
-- two functions from 0009 replaced because erasure now has to reach further than it did.
--
-- Same arrangement and the same reason as 0007_order_guards.sql, 0011_payment_guards.sql
-- and 0016_quote_guards.sql: drizzle-kit generates tables, constraints and indexes from
-- src/schema and generates no triggers, no functions and no views. This is a migration
-- applied by the same `drizzle-kit migrate` in the same order, not a runbook step.
--
-- ── What is in here, and why none of it could be a CHECK ─────────────────────────
--
--   * "the line's order has been delivered" reads `orders`;
--   * "the line was not removed during a redesign" reads `quote_lines`;
--   * "a review is hidden, never deleted" is a statement about DELETE;
--   * "the rating is frozen once the review is public" compares OLD to NEW *and* compares
--     `now()` against a column, which no CHECK may do — a CHECK must be immutable, and the
--     whole design here is that the passage of time changes what is true;
--   * "the average is over every counted review, hidden or not" is a query, so it is a view.
--
-- ── And one thing that is NOT here, said out loud ────────────────────────────────
--
--   ⚠️ NO INVITATION, AND NO SCHEDULE TABLE. Plan 9.2's invitation fires once, N days after
--      delivery, and its natural home is the outbox — whose producer today is `order_events`
--      and only `order_events` (`notifications_guard_insert()` refuses a row that did not
--      come from a trigger in the event's own transaction). Adding a second producer is the
--      "second nullable source column plus a CHECK that exactly one is set" the SEAM note at
--      the bottom of order.ts already specifies, and it is a change to the outbox rather
--      than to reviews. Inventing a `review_invitations` table here would be a second
--      scheduler nobody asked for, with its own answer to retries, coalescing and `dead`.
--      `REVIEW_INVITATION_DELAY_DAYS_DEFAULT` in review.ts is the number, marked as plan
--      13's default and not as an answer.


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE WINDOW OPENS AT `delivered`, AND NEVER CLOSES
-- ═════════════════════════════════════════════════════════════════════════════

-- Reusing `order_child_require_status()` from 0007_order_guards.sql rather than writing a
-- fourth copy of the same idea. That function is trap 6's answer — it takes `FOR SHARE` on
-- the order rather than merely ordering the race, so a review racing a transition *blocks*,
-- re-reads under READ COMMITTED and refuses, instead of passing on a snapshot taken before
-- the transition committed.
--
-- ⚠️ ONE STATUS, AND THE FACT THAT IT IS TERMINAL IS WHAT MAKES THE WINDOW ENDLESS.
-- Plan 9.2 wants reviews accepted for ever: aluminium is judged after a rainy season, not
-- after three days. `delivered` has no outgoing transition in `order_status_transitions` —
-- the six cancellation rows are `draft`, `awaiting_payment`, `production_confirmed`,
-- `in_production`, `awaiting_installation` and `redesign` — so an order that arrives here
-- stays here, and a guard keyed on the status can never be the thing that closes the window.
-- If a `delivered → …` row is ever added, this is where the assumption is written down.
CREATE TRIGGER reviews_delivered_orders_only
  BEFORE INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION order_child_require_status('order_id', '{delivered}');
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — PUBLICATION IS ARITHMETIC, NOT A JOB
-- ═════════════════════════════════════════════════════════════════════════════

-- Plan 9.3: *moderation must have a deadline — nobody acts within N days and it publishes
-- itself.* An approve-before-publish queue with no SLA is one where reviews never appear,
-- which is the failure the refund queue already has in plan 7.12.
--
-- ⚠️ THE DEADLINE IS A FACT THE DATABASE CAN SEE. There is no `status` column on `reviews`
-- and nothing anywhere flips one. A review is counted when its moderation is settled — a
-- person acted, or the window elapsed — and public when it is counted and not hidden. Both
-- are functions of the row and of `now()`, which means:
--
--   * no worker can fail to publish, because no worker publishes;
--   * no queue can be drained wrongly, because there is no queue to drain;
--   * a review cannot be parked in a state nobody looks at, because there is no such state.
--
-- STABLE and not IMMUTABLE, deliberately: they read `now()`. That is also why neither can
-- appear in a CHECK constraint or in the predicate of a partial index, and why
-- `reviews_moderation_queue_idx` indexes `created_at` over the unhidden, unpublished rows
-- and leaves the window arithmetic to the query.
--
-- Written against the whole row rather than against loose arguments so that the trigger and
-- the two views cannot drift into three slightly different definitions of "public" — which
-- is the failure mode plan 7.13 opens with, six mechanisms pretending to be one.
CREATE FUNCTION review_is_moderated(r reviews) RETURNS boolean AS $$
  SELECT r.hidden_at IS NOT NULL
      OR r.published_at IS NOT NULL
      OR r.created_at + make_interval(hours => r.moderation_window_hours) <= now();
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- Hidden reviews are moderated and not public: the text comes down, the rating stays in the
-- average. That is the whole of plan 9.3's second bullet, and it is one AND away from being
-- the thing it forbids.
CREATE FUNCTION review_is_public(r reviews) RETURNS boolean AS $$
  SELECT r.hidden_at IS NULL AND review_is_moderated(r);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — WHAT A REVIEW MAY NOT BECOME
-- ═════════════════════════════════════════════════════════════════════════════

-- Four rules in one BEFORE trigger so they all see the same row.
--
-- ⓵ ⭐ A REVIEW IS HIDDEN, NEVER DELETED. This codebase has settled the delete-versus-flag
--    argument twice — plan 7.15 item 1 for users, plan 7.9(ค) for quote lines — and a third
--    answer in the other direction would make the first two arbitrary. It is also the only
--    way the sentence "hiding is not a tool for dressing the score" survives contact with a
--    moderator who would rather the score were higher: if DELETE were available, hiding
--    would be the polite option and deletion the effective one.
--
-- ⓶ A LINE REMOVED DURING A REDESIGN IS NOT DELIVERED. `quote_lines_live_orders_only`
--    permits edits in `draft`, `awaiting_payment` and `redesign`, so a frozen order that the
--    factory bounced can lose a line and then go on to be delivered without it. The
--    composite foreign key cannot see that — the row is still there, `removed_at` and all —
--    so this is the one part of "there is something to review" that has to be a trigger.
--
-- ⓷ THE MODERATION WINDOW IS FIXED WHEN THE REVIEW IS WRITTEN. Without this, burying a
--    review is a sequence of individually legal writes: extend the window, extend it again.
--    `reviews_moderation_window_bounded` caps one write; this is what stops the second.
--
-- ⓸ ⭐ THE RATING IS FROZEN ONCE THE REVIEW IS MODERATED, and so is the prose. This is what
--    makes plan 9.3's "record a reason and a person" more than paperwork: the moderator who
--    hides a two-star review cannot also make it a five, and the customer who was replied to
--    cannot rewrite what the reply is answering.
--
--    The one permitted exception is the erasure, and it is permitted precisely — `body_th`
--    and `author_display_name` to NULL, together, stamped with `content_erased_at`, once.
--    Not "an UPDATE by erase_user()": the guard cannot see who is calling and should not
--    try. It sees a shape, and the shape is the erasure. Every other route to changing a
--    published review's text is closed, including that one used twice.
CREATE FUNCTION reviews_guard_write() RETURNS trigger AS $$
DECLARE
  line    quote_lines%ROWTYPE;
  erasing boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review % is hidden, never deleted', OLD.id
      USING ERRCODE = 'restrict_violation',
            HINT = 'set hidden_at, hidden_by_user_id and hidden_reason — the rating goes on counting, which is the point';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO line FROM quote_lines WHERE id = NEW.quote_line_id FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'quote line % does not exist', NEW.quote_line_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF line.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'quote line % was removed from order %; nothing was delivered to review',
        NEW.quote_line_id, NEW.order_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- What a review is about can never change. A review re-pointed at another line is a
  -- verdict on a window the customer never bought, and the two composite foreign keys would
  -- happily follow it there.
  IF NEW.order_id <> OLD.order_id
     OR NEW.quote_line_id <> OLD.quote_line_id
     OR NEW.product_version_id <> OLD.product_version_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.author_guest_id IS DISTINCT FROM OLD.author_guest_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'review % cannot be re-pointed or re-attributed; what it is about and who wrote it are fixed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.moderation_window_hours <> OLD.moderation_window_hours THEN
    RAISE EXCEPTION 'review %: the moderation window is fixed at % hours when the review is written', OLD.id, OLD.moderation_window_hours
      USING ERRCODE = 'restrict_violation',
            HINT = 'a window that can be extended is a review that can be buried by a sequence of legal writes';
  END IF;

  IF OLD.content_erased_at IS NOT NULL
     AND NEW.content_erased_at IS DISTINCT FROM OLD.content_erased_at THEN
    RAISE EXCEPTION 'review %: the record of a content erasure cannot be rewritten', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  erasing := OLD.content_erased_at IS NULL
         AND NEW.content_erased_at IS NOT NULL
         AND NEW.body_th IS NULL
         AND NEW.author_display_name IS NULL;

  IF review_is_moderated(OLD) THEN
    -- The rating has no exception, not even for the erasure. A number between one and five
    -- names nobody once the prose and the display name are gone, and dropping it would let
    -- an erasure do exactly what hiding is forbidden from doing.
    IF NEW.rating <> OLD.rating THEN
      RAISE EXCEPTION 'review %: the rating is fixed once the review has been moderated', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT erasing
       AND (NEW.body_th IS DISTINCT FROM OLD.body_th
            OR NEW.author_display_name IS DISTINCT FROM OLD.author_display_name) THEN
      RAISE EXCEPTION 'review %: what was published cannot be rewritten', OLD.id
        USING ERRCODE = 'restrict_violation',
              HINT = 'the only permitted change is the erasure: body_th and author_display_name to NULL together, stamped with content_erased_at';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reviews_guard_write
  BEFORE INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_guard_write();
--> statement-breakpoint

-- ── A tombstone writes no reviews ───────────────────────────────────────────────
--
-- The same guard `auth_rows_refuse_erased_user()` makes for credentials, and it is NOT the
-- same function because that one reads `NEW.user_id` and this column is `author_user_id`.
--
-- ⚠️ AND UNLIKE THE CREDENTIAL VERSION, THIS ONE HAS A REACHABLE CALLER TODAY. 0009 wrote
-- its guards against a caller that does not exist yet (an erased account cannot sign in, so
-- no HTTP path reaches those inserts). A review invitation is a tokenised link in an email,
-- not a session: an erased customer who still has the invitation in their inbox can follow
-- it. Without this, "forget me" is followed by that person publishing a paragraph and a
-- photograph of their house.
--
-- `FOR SHARE` and not a bare read, for the reason 0009 gives: a review that began before the
-- erasure committed would otherwise read `closed`, pass, and land on a tombstone.
CREATE FUNCTION reviews_refuse_erased_author() RETURNS trigger AS $$
DECLARE
  author_status text;
BEGIN
  SELECT u.status INTO author_status FROM users u WHERE u.id = NEW.author_user_id FOR SHARE;

  IF author_status = 'erased' THEN
    RAISE EXCEPTION 'user % is erased; nothing may be published under that account', NEW.author_user_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reviews_refuse_erased_author
  BEFORE INSERT ON reviews
  FOR EACH ROW WHEN (NEW.author_user_id IS NOT NULL)
  EXECUTE FUNCTION reviews_refuse_erased_author();
--> statement-breakpoint

-- The profile gets the credential treatment unchanged, and for once the column name lines
-- up so the existing function is reused rather than copied.
CREATE TRIGGER user_preferences_refuse_erased_user
  BEFORE INSERT OR UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION auth_rows_refuse_erased_user();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — THE PHOTOGRAPHS
-- ═════════════════════════════════════════════════════════════════════════════

-- ⓵ ⭐ DELETE IS ALLOWED HERE, AND NOWHERE ELSE IN THIS PHASE. Plan 9.4(2): a photo must be
--    deletable while the rating survives — the same split plan 7.6 already made for slip
--    images. The review row is what carries the rating, so removing the picture removes the
--    picture and changes no average. That is the entire reason a photo is a child row.
--
-- ⓶ A PHOTO CANNOT BE ADDED AFTER MODERATION HAS SETTLED. Otherwise the window is a control
--    over prose only: post a bland review, wait three days, then attach whatever you like to
--    a page that is already public and that nobody is going to look at again.
--
-- ⓷ A PHOTO'S IDENTITY CANNOT BE EDITED — media.ts's rule, restated because the reason is
--    the same one: repointing `storage_key` at different bytes leaves a published page
--    showing an image nobody moderated, and it is not an anomaly any referential check could
--    see. Alt text is the one editable column, for media.ts's stated reason.
--
-- ⓸ THE ONE PERMITTED MOVE FOR `storage_key` IS TO NULL, STAMPED. That is the retention
--    sweep and the erasure: the bytes go, the row stays saying a photo existed and was
--    removed. `review_photos_erasure_shape` holds the shape; this holds the direction, and
--    without the direction the sweep is reversible by re-pointing at the same object.
CREATE FUNCTION review_photos_guard_write() RETURNS trigger AS $$
DECLARE
  parent reviews%ROWTYPE;
BEGIN
  -- Deliberate, and the point of plan 9.4(2). See ⓵.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO parent FROM reviews WHERE id = NEW.review_id FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'review % does not exist', NEW.review_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF review_is_moderated(parent) THEN
      RAISE EXCEPTION 'review % has already been moderated; a photograph added now would never be looked at', NEW.review_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.review_id <> OLD.review_id
     OR NEW.seq <> OLD.seq
     OR NEW.content_type <> OLD.content_type
     OR NEW.byte_size <> OLD.byte_size
     OR NEW.width <> OLD.width
     OR NEW.height <> OLD.height
     OR NEW.checksum_sha256 <> OLD.checksum_sha256
     OR NEW.source_checksum_sha256 <> OLD.source_checksum_sha256
     OR NEW.strip_recipe <> OLD.strip_recipe
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'photo % identifies a fixed sequence of bytes; upload again rather than editing it', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     AND NOT (OLD.storage_key IS NOT NULL
              AND NEW.storage_key IS NULL
              AND NEW.storage_key_erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'photo %: the only move storage_key has is to NULL, stamped with storage_key_erased_at', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER review_photos_guard_write
  BEFORE INSERT OR UPDATE OR DELETE ON review_photos
  FOR EACH ROW EXECUTE FUNCTION review_photos_guard_write();
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — THE TWO READS, AS VIEWS — plan 9.5
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ **THERE IS NO `avg` COLUMN HERE, AND THAT IS THE FEATURE.**
--
-- Plan 9.5: *never show an average without its count* — "5.0 ★" from one review reads as
-- advertising rather than as information. A view that exposed `avg_rating` would make the
-- honest rendering the one that remembers to select a second column, and somewhere a card
-- component would not. So the sum and the count are exposed and the average is not: a caller
-- who wants one has to divide, and to divide it has to be holding the count.
--
-- ⚠️ **AND A PRODUCT WITH NOTHING TO SAY HAS NO ROW.**
--
-- Plan 9.5 again: with 81 products and no orders yet there will be no reviews for months,
-- and *"ยังไม่มีรีวิว"* printed on 81 pages is worse than silence. `GROUP BY` produces no
-- row for a product with no counted review, so there is nothing to render a zero from — the
-- storefront's "hide the whole block" is `if (!stats) return null`, which is the shape that
-- gets written correctly by accident.
--
-- ⚠️ **AND `hidden_at` IS NOT IN THE WHERE CLAUSE.**
--
-- Plan 9.3, the sentence the whole moderation design turns on: *the rating still counts
-- toward the average even when the text is hidden* — otherwise hiding becomes the tool for
-- dressing the score. `visible_count` is beside it so a page can tell "eleven ratings, nine
-- of which have text you can read" from "eleven reviews", which is a different sentence and
-- an honest one.
CREATE VIEW product_review_stats AS
  SELECT pv.product_id,
         count(*)::bigint                                          AS rating_count,
         sum(r.rating)::bigint                                     AS rating_sum,
         count(*) FILTER (WHERE r.hidden_at IS NULL)::bigint       AS visible_count,
         count(*) FILTER (WHERE r.body_th IS NOT NULL
                            AND r.hidden_at IS NULL)::bigint       AS visible_with_text_count,
         max(r.created_at)                                         AS newest_review_at
    FROM reviews r
    JOIN product_versions pv ON pv.id = r.product_version_id
   WHERE review_is_moderated(r)
   GROUP BY pv.product_id;
--> statement-breakpoint

-- The public read, as a deliberate projection rather than as `SELECT *`.
--
-- ⓵ `review_is_public(r)` and nothing else in the WHERE clause, so a caller cannot forget
--    the hidden filter or the moderation window. That forgetting is the failure mode: a
--    page that renders `SELECT * FROM reviews WHERE product_id = …` publishes both the
--    unmoderated and the hidden ones, and looks completely normal doing it.
--
-- ⓶ ⭐ `author_user_id` AND `author_guest_id` ARE NOT IN THE LIST. The public projection
--    cannot be joined back to a person, so the query that renders a review page has nothing
--    to leak even if somebody adds a join to it later. Plan 9.4's whole worry is a review
--    page that publishes more about the customer than the customer meant to publish.
--
-- ⓷ `public_since` is the honest publication date: the moderator's stamp when there was one,
--    and the moment the window elapsed when there was not. A page that showed `created_at`
--    would be telling the reader the review had been up for three days longer than it had.
CREATE VIEW published_reviews AS
  SELECT r.id,
         pv.product_id,
         r.product_version_id,
         r.quote_line_id,
         r.rating,
         r.body_th,
         r.author_display_name,
         r.content_erased_at,
         r.reply_th,
         r.replied_at,
         r.created_at,
         COALESCE(r.published_at,
                  r.created_at + make_interval(hours => r.moderation_window_hours)) AS public_since
    FROM reviews r
    JOIN product_versions pv ON pv.id = r.product_version_id
   WHERE review_is_public(r);
--> statement-breakpoint

-- ── The cache trap this phase would otherwise walk into — plan 8.2 trap 1, plan 9.5 ──
--
-- `apps/web` runs `revalidate = false`, so a product page is built once and served until
-- something calls `revalidateTag('product:' + id)`. Every other writer in this system is a
-- request that can make that call: the dashboard publishes a version, the API accepts a
-- review.
--
-- ⚠️ **AUTO-PUBLICATION HAS NO WRITER.** A review that publishes itself three days after it
-- was written changes the average on a cached page, and there is no HTTP request, no row
-- update and no transaction anywhere at that moment to hang a `revalidateTag` on. This is
-- the same shape as trap 1 and it arrives from the one direction the plan does not name.
--
-- This view is the answer available to a schema: it says, per product, when the next such
-- silent change will happen, so `apps/web` can schedule a revalidation instead of
-- discovering the drift. It has a row only while something is genuinely pending, so polling
-- it costs nothing on the 81 products that have no reviews at all.
--
-- What it does NOT do is make the revalidation happen. That is `apps/web`'s and the API's,
-- and it is stated here rather than assumed because a view nobody reads is a fact nobody has.
CREATE VIEW product_review_schedule AS
  SELECT pv.product_id,
         min(r.created_at + make_interval(hours => r.moderation_window_hours)) AS next_publication_at,
         count(*)::bigint                                                      AS pending_count
    FROM reviews r
    JOIN product_versions pv ON pv.id = r.product_version_id
   WHERE NOT review_is_moderated(r)
   GROUP BY pv.product_id;
--> statement-breakpoint


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — ERASURE HAS TO REACH FURTHER THAN IT DID
-- ═════════════════════════════════════════════════════════════════════════════

-- Two functions from 0009 are replaced. Neither is a change of mind about anything 0009
-- decided; both are the same decisions extended over two tables that did not exist then.
--
-- `ERASURE_TREATMENTS` in src/schema/auth.ts carries the argument in full — including the
-- part a lawyer still has to settle — and tests/erasure.test.ts fails the phase if a
-- foreign key to `users` appears without an entry there. Five were added:
--
--   reviews.author_user_id        scrub   the prose, the display name and the photographs go;
--                                         the rating and the uuid stay
--   reviews.published_by_user_id  keep    who acted, as with every other control
--   reviews.hidden_by_user_id     keep
--   reviews.replied_by_user_id    keep
--   user_preferences.user_id      delete  a display setting is not an accounting record

-- ── The survivor list gains one table ───────────────────────────────────────────
--
-- Replaced verbatim from 0009 with `user_preferences` added to the union. `delete` is a
-- claim, and this trigger is what makes it one the database checks: a half-run scrub cannot
-- commit a row that says `erased`. A `delete` treatment whose table is missing here is a
-- promise with nothing behind it — and the generic coverage test in tests/erasure.test.ts
-- runs *after* `erase_user()` returns, so it would be green either way.
CREATE OR REPLACE FUNCTION users_erasure_is_earned() RETURNS trigger AS $$
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
    UNION ALL
    -- Phase 7. Not a credential — a display preference — and it is on this list for the
    -- same reason the credentials are: `delete` has to be a claim the database checks.
    SELECT 'user_preferences' WHERE EXISTS (SELECT 1 FROM user_preferences WHERE user_id = NEW.id)
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
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ── And the scrub itself ────────────────────────────────────────────────────────
--
-- Replaced verbatim from 0009 with three statements added before the paper trail is written,
-- and the withheld-scope sentence extended so the DSAR answer still describes what the
-- function actually does. The three:
--
--   ⓵ DELETE the profile. Uncomplicated: a tombstone that remembers somebody reads Burmese
--      and thinks in inches is personal data retained for no purpose anybody has stated.
--
--   ⓶ DELETE their review photographs. ⭐ This is the one that matters, and plan 9.4 is why:
--      a customer photographs their own window, and the file carries the coordinates of
--      their house. Publishing it publishes their address; retaining it after they asked to
--      be forgotten retains their address. The row goes entirely — this is the one table in
--      the phase where DELETE is legal, and this is the reason it had to be.
--
--   ⓷ SCRUB the prose and the display name, stamped. `reviews_guard_write()` permits exactly
--      this shape and nothing else once a review is public, so the erasure is not a
--      privileged path — it is the only path, and it is available to anybody writing exactly
--      that UPDATE, which is the same property `erase_user()` has everywhere else (SECURITY
--      INVOKER, no standing capability).
--
-- ⚠️ WHAT IS DELIBERATELY NOT DONE, AND IS THE LAWYER'S QUESTION, NOT AN OVERSIGHT:
--
--   * **the rating stays**, so the average other customers already read does not move, and
--     so erasure cannot do what plan 9.3 forbids hiding from doing;
--   * **the review row stays attached to its order line**, which is attached to an order
--     that still carries `contact_email`, `contact_name` and `contact_phone` under the
--     accounting exemption — **one join re-identifies the author.** This is exactly the
--     sentence plan 7.16 already writes about `erased` users, arriving at a second address.
--     The honest description is *"the review's own content is gone and the order it hangs
--     off is not"*, and it is in `withheld_scope` so a DSAR answer says it out loud;
--   * **a review written by a guest that was never claimed is unreachable**, because there
--     is no user id to erase by. Same blindness as guest orders, and the main funnel.
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
