-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ A CEILING IS WITHDRAWN, NOT DELETED — AND EVERY MOVE OF ONE IS RECORDED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `authority_limits` shipped in 0015 with no way to put a row in it and no way to take one
-- out except `DELETE`. Task 13's screen gives it the first; this migration gives it the
-- second in the shape the rest of this schema already uses for policy tables — a flag, a
-- trigger that refuses the delete, and an append-only change log beside it.
--
-- ── Why a ceiling cannot simply be deleted ───────────────────────────────────────
--
-- `approvals.decided_ceiling_thb_minor` pins the decider's own ceiling at the moment they
-- approved, precisely so that raising a limit next month does not make last month's
-- approvals look unnecessary (see `authority.service.ts`, note 3). That pin answers *"what
-- was the number?"*. It does not answer *"who granted this role that authority, and who
-- took it away?"* — and with a `DELETE` behind a `PUT`-shaped endpoint, nothing could:
-- the row that named the granter vanished with the authority.
--
-- So revocation becomes two columns and the row survives. `revoked_at IS NULL` is the live
-- predicate, and `AuthorityRepository.ceiling()` — the ONE read that decides whether a
-- concession needs somebody else's yes — now carries it. That distinction matters more here
-- than in `tax_countries`, because the module's whole fail-closed rule turns on **no row**
-- (`undefined`, no authority at all) being a different answer from **a row of 0** (may
-- record a concession, may approve none of its own). A revoked row has to read as the
-- former; it is filtered out of the read, never coerced to zero.

ALTER TABLE "authority_limits" ADD COLUMN "revoked_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "authority_limits" ADD COLUMN "revoked_by_user_id" uuid;
--> statement-breakpoint

-- `restrict`, matching `granted_by_user_id` beside it. Erasure never deletes a user row —
-- it scrubs and closes — so this fires only on a literal `DELETE FROM users`, and both
-- columns are declared `keep` in `ERASURE_TREATMENTS`: revoking authority is an act by a
-- member of staff, and a customer cannot hold, grant or withdraw a ceiling.
ALTER TABLE "authority_limits" ADD CONSTRAINT "authority_limits_revoked_by_user_id_users_id_fk"
  FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint

-- Same idiom as `quote_lines_removal_shape`: a withdrawal has a time and a person, or it did
-- not happen. Half of one is a row nobody can read.
ALTER TABLE "authority_limits" ADD CONSTRAINT "authority_limits_revocation_shape"
  CHECK (num_nonnulls("revoked_at", "revoked_by_user_id") in (0, 2));
--> statement-breakpoint

-- The index the decision read actually uses: `ceiling()` asks for one dimension, a handful of
-- group ids, and live rows only. `authority_limits_dimension_idx` (0015) stays — it is what a
-- report over the whole table, revoked rows included, reads.
CREATE INDEX "authority_limits_live_idx" ON "authority_limits" USING btree ("dimension","group_id")
  WHERE "revoked_at" is null;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ THE DELETE THAT IS REFUSED, AND THE ONE THAT IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠️ `authority_limits.group_id` is `ON DELETE CASCADE` towards `groups`, and 0015 defends
-- that at length: deleting a role deletes its authority, which is the fail-closed direction.
-- A trigger that refused every DELETE would therefore break `DELETE /groups/:groupId`
-- outright — the cascade is itself a delete, and it would be refused on a row the
-- administrator never named.
--
-- So this uses the idiom `quote_lines_guard_write()` established for exactly this shape
-- (0016, and `order_events_append_only()` before it): look for the parent. `NOT FOUND` means
-- the `groups` row is already gone inside this transaction, i.e. this is the cascade from a
-- group delete that the group's own guards have already permitted. Anything else is somebody
-- reaching for `DELETE FROM authority_limits`, and that is what `revoked_at` is for.
CREATE FUNCTION authority_limits_block_delete() RETURNS trigger AS $$
DECLARE
  parent groups%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM groups WHERE id = OLD.group_id;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'authority limit (group %, %) is who granted this role its ceiling; revoke it instead of deleting it',
    OLD.group_id, OLD.dimension
    USING ERRCODE = 'restrict_violation',
          HINT = 'set revoked_at and revoked_by_user_id — authority_limit_changes points at this row';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER authority_limits_block_delete
  BEFORE DELETE ON "authority_limits"
  FOR EACH ROW EXECUTE FUNCTION authority_limits_block_delete();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- ⭐ WHO MOVED A CEILING, FROM WHAT, AND WHEN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same table `tax_country_changes` and `bank_account_changes` are: `before`/`after`
-- snapshots, the actor, and an append-only trigger. What is different is deliberate and
-- there are two things.
--
-- ⓵ **No foreign key on `group_id`, and `group_code` is carried denormalised.**
--
--    `groups` is deletable — `DELETE /groups/:groupId` exists and is refused only while the
--    group still has members — and `authority_limits` cascades away with it. A `restrict` FK
--    here would make any group that ever held a ceiling permanently undeletable, which is a
--    regression in group administration; a `cascade` FK would destroy the history at exactly
--    the moment it becomes the only surviving record of the authority. Neither is right, so
--    there is no FK: this table outlives its subject on purpose. `group_code` is copied in so
--    that a row still names something a human recognises after the group is gone.
--
-- ⓶ **`changed_by_user_id` is NOT NULL and `restrict`**, where the three settings tables use
--    nullable + `set null` + a `scrub` in `erase_user()`. It follows `authority_limits`'
--    own `granted_by_user_id` instead, which is NOT NULL and `keep`, for the reason
--    `ERASURE_TREATMENTS` already gives about this family: these are staff columns recording
--    that a control was exercised, a uuid naming a tombstone identifies nobody, and a
--    customer cannot grant authority. A history of authority whose actor can become NULL is
--    a weaker record than the row it describes, which would be the wrong way round.
CREATE TABLE "authority_limit_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "group_code" text NOT NULL,
  "dimension" text NOT NULL,
  "changed_by_user_id" uuid NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL,
  CONSTRAINT "authority_limit_changes_dimension_known"
    CHECK ("dimension" in ('margin', 'cashflow'))
);
--> statement-breakpoint

ALTER TABLE "authority_limit_changes" ADD CONSTRAINT "authority_limit_changes_changed_by_user_id_users_id_fk"
  FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint

CREATE INDEX "authority_limit_changes_subject_idx"
  ON "authority_limit_changes" ("group_id","dimension","changed_at");
--> statement-breakpoint

-- ⚠️ `changed_at` has `DEFAULT now()` and NOTHING IS SUPPOSED TO USE IT.
--
-- `now()` is `transaction_timestamp()` — fixed at BEGIN. Two concurrent writes to one ceiling
-- both open before either takes the row lock, so the one that blocks can hold the *earlier*
-- `now()` while committing *second*, and a history sorted by `changed_at` then reads out of
-- order: entry N's `before` no longer equals entry N−1's `after`, which is the one property
-- this table exists to prove. `AuthorityService` writes `clock_timestamp()` explicitly for
-- that reason — see the comment there, and the identical one in `tax-country.service.ts`. The
-- default is kept only so a `psql` session cannot produce a row with no timestamp at all.
CREATE FUNCTION authority_limit_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'authority_limit_changes is append-only; a change to who may concede cannot be un-recorded'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER authority_limit_changes_append_only
  BEFORE UPDATE OR DELETE ON "authority_limit_changes"
  FOR EACH ROW EXECUTE FUNCTION authority_limit_changes_append_only();
