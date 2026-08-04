CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"checksum_sha256" char(64) NOT NULL,
	"original_filename" text,
	"alt_text_th" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_objects_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "media_objects_checksum_sha256_unique" UNIQUE("checksum_sha256"),
	CONSTRAINT "media_objects_content_type_supported" CHECK ("media_objects"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "media_objects_byte_size_positive" CHECK ("media_objects"."byte_size" > 0),
	CONSTRAINT "media_objects_dimensions_positive" CHECK ("media_objects"."width" > 0 and "media_objects"."height" > 0),
	CONSTRAINT "media_objects_checksum_hex" CHECK ("media_objects"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "media_objects_created_at_idx" ON "media_objects" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Everything above this line is generated from src/schema/media.ts. Everything
-- below is written by hand, because drizzle-kit does not generate triggers, and
-- these two are the reason the table is safe to point a frozen document at.
-- Same arrangement as 0001_catalog_freeze.sql: a migration, applied by the same
-- `drizzle-kit migrate`, not a runbook step somebody has to remember.
-- ─────────────────────────────────────────────────────────────────────────────

-- A published version's document is the picture of the product a customer bought from.
-- Deleting the bytes it names does not change the document — it makes it a document that
-- describes something nobody can see any more, which is the same class of loss as editing
-- it (plan section 5).
--
-- The reference is matched as a substring of the whole document rather than by reading
-- `document->>'heroImage'`, and that is deliberate:
--
--   * It is the safe direction to be wrong in. A false positive refuses a delete somebody
--     can still argue about; a false negative destroys bytes a frozen document names.
--   * It does not have to be updated when the document grows a second place to hold an
--     image — a per-option-value picture, a gallery — which is exactly the change most
--     likely to be made by somebody who has never read this file.
--
-- The reference string is `/media/<uuid>`, which is `mediaPath()` in src/schema/media.ts.
-- A uuid inside a JSON document that is not a media reference is not a collision anyone
-- can arrange, and if it were, the outcome is a refused DELETE.
--
-- Cost: one sequential scan of `product_versions` with a jsonb→text cast per delete. At
-- the catalogue's real size (81 products) that is microseconds, and deletes are rare by
-- construction. If this table ever grows past what a scan can carry, the fix is a
-- reference table maintained at publish time — not a weaker guard.
CREATE FUNCTION media_objects_block_referenced_delete() RETURNS trigger AS $$
DECLARE
  reference text := '/media/' || OLD.id::text;
  offender  record;
BEGIN
  SELECT pv.product_id, pv.version, pv.status
    INTO offender
    FROM product_versions pv
   WHERE pv.status <> 'draft'
     AND strpos(pv.document::text, reference) > 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'media object % is referenced by the % version % of product %',
      OLD.id, offender.status, offender.version, offender.product_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER media_objects_block_referenced_delete
  BEFORE DELETE ON media_objects
  FOR EACH ROW EXECUTE FUNCTION media_objects_block_referenced_delete();
--> statement-breakpoint

-- Deleting the row is not the only way to break a frozen document: repointing `storage_key`
-- at other bytes leaves every published version showing a picture nobody reviewed, and
-- unlike a delete it leaves no anomaly for a referential check to find. So the columns that
-- say *which bytes this is* cannot move at all.
--
-- Three columns are deliberately absent from the list. `alt_text_th` is an accessibility
-- fact about the picture rather than part of what a customer was quoted. `original_filename`
-- is display text. And `uploaded_by_user_id` **must** stay writable: the FK carries
-- ON DELETE SET NULL, which fires an UPDATE through this very trigger, so freezing it would
-- make closing a user account fail on a photograph they uploaded.
CREATE FUNCTION media_objects_freeze_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.storage_key     IS DISTINCT FROM OLD.storage_key
  OR NEW.content_type    IS DISTINCT FROM OLD.content_type
  OR NEW.byte_size       IS DISTINCT FROM OLD.byte_size
  OR NEW.width           IS DISTINCT FROM OLD.width
  OR NEW.height          IS DISTINCT FROM OLD.height
  OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'media object % identifies stored bytes and cannot be edited; upload the new image instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER media_objects_freeze_identity
  BEFORE UPDATE ON media_objects
  FOR EACH ROW EXECUTE FUNCTION media_objects_freeze_identity();
