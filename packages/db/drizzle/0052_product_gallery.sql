-- ═════════════════════════════════════════════════════════════════════════════
-- 0052 — a product may show more than one picture, and one video
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `products.hero_image` has held one path since 0000, and until this round nothing on the
-- storefront rendered it at all: `apps/web` never referenced `heroImage`, and the 81 seeded
-- values point at `/products/<slug>.svg` files that do not exist anywhere in the repository.
-- So a catalogue of custom aluminium joinery has been sold with no pictures.
--
-- ⓵ `product_images` hangs off `products` — the **editable** layer — because that is where
--    every other product field a person edits lives (`schema/catalog.ts`'s header: "the
--    normalised tables the dashboard writes to"). `compile.ts` copies the editable row into
--    the frozen document at publish, and images ride along with everything else. A picture
--    changed after a publish therefore reaches customers on the next publish, exactly like a
--    changed name or lead time.
--
--    ⚠️ The one catalogue fact deliberately kept OUT of the freeze is `option_values.available`,
--    with its own CHECK forbidding it in the document — stock changes without a publish. A
--    photograph is not stock: it is part of how the product is described, and describing it
--    differently *is* a new version of the description.
--
-- ⓶ `path text`, not a foreign key to `media_objects`. `schema/media.ts` states the contract:
--    *"What a reference looks like is therefore the whole contract between this table and the
--    catalogue, and it is exactly one string: `/media/<media_objects.id>`"*. Following it buys
--    the delete guard for free — `media_objects_block_referenced_delete` (0005) refuses to
--    delete an object whose `/media/<id>` appears anywhere in a non-draft document's text, and
--    its own comment says it was written this way so it *"does not have to be updated when the
--    document grows a second place to hold an image — a per-option-value picture, a gallery"*.
--    This is that gallery. The guard already covers it.
--
--    It also means a path may point at a static file (`/products/x.svg`) as `hero_image` does
--    today, so nothing has to be migrated to make the column usable.
--
-- ⓷ `sort_order` is unique per product. Dense-ness is nobody's business — deleting the middle
--    picture must not renumber the others — but two pictures claiming the same position is a
--    gallery whose order depends on which row Postgres happened to return.
--
-- ⓸ `products.video_url` — **one video, as a link, and not an uploaded file.**
--
--    ⚠️ The owner asked for an attached video and the answer had to be a link, because
--    `media_objects` cannot hold one: `media_objects_content_type_supported` allows exactly
--    `image/jpeg`, `image/png` and `image/webp`, the upload path sniffs magic bytes and refuses
--    everything else, and each accepted format has a hand-written reader in
--    `apps/api/src/media/image/` that strips metadata and reads the dimensions out of the bytes.
--    Accepting an MP4 would mean writing a container parser in that same style, widening the
--    CHECK, and raising a per-upload ceiling that is 8 MiB. A URL costs none of it, and product
--    video is hosted on YouTube or Vimeo in practice anyway.
--
--    One column rather than a table because the requirement is one video. A `product_videos`
--    table would model a list nobody asked for and would need its own ordering rules.
--
--    ⚠️ It is NOT validated as a URL here. A CHECK that accepted `https://…` would still accept
--    `https://example.com/nothing`, so it would buy the appearance of validation and none of
--    the substance; the shape is checked in the contract, where the refusal can be a sentence.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "products" ADD COLUMN "video_url" text;
--> statement-breakpoint

CREATE TABLE "product_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" text NOT NULL,
  "path" text NOT NULL,
  "sort_order" integer NOT NULL,
  "alt_text_th" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_images_product_id_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "public"."products"("id")
    ON UPDATE cascade ON DELETE cascade,
  CONSTRAINT "product_images_product_sort_key" UNIQUE ("product_id", "sort_order"),
  CONSTRAINT "product_images_sort_order_nonnegative" CHECK ("sort_order" >= 0),
  CONSTRAINT "product_images_path_shape" CHECK ("path" ~ '^/[A-Za-z0-9._/-]+$')
);
--> statement-breakpoint

-- Read in one order and one order only: the gallery, for one product.
CREATE INDEX "product_images_gallery_idx" ON "product_images" ("product_id", "sort_order");
