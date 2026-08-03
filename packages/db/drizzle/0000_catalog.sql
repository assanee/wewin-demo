CREATE TYPE "public"."authored_unit" AS ENUM('cm', 'mm');--> statement-breakpoint
CREATE TYPE "public"."option_group_kind" AS ENUM('sku', 'custom');--> statement-breakpoint
CREATE TYPE "public"."option_input" AS ENUM('swatch', 'chip', 'toggle', 'number');--> statement-breakpoint
CREATE TYPE "public"."price_delta_type" AS ENUM('none', 'flat', 'per_sqm', 'percent');--> statement-breakpoint
CREATE TYPE "public"."product_version_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."rule_severity" AS ENUM('error', 'warning');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label_th" text NOT NULL,
	"summary_th" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" "option_group_kind" NOT NULL,
	"label_th" text NOT NULL,
	"input" "option_input" NOT NULL,
	"include_in_sku_code" boolean DEFAULT false NOT NULL,
	"authored_unit" "authored_unit",
	"helper_th" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_groups_code_unique" UNIQUE("code"),
	CONSTRAINT "option_groups_id_kind_key" UNIQUE("id","kind"),
	CONSTRAINT "option_groups_sku_shape" CHECK ("option_groups"."kind" <> 'sku' or ("option_groups"."input" in ('swatch', 'chip', 'toggle') and "option_groups"."authored_unit" is null)),
	CONSTRAINT "option_groups_custom_shape" CHECK ("option_groups"."kind" <> 'custom' or ("option_groups"."input" = 'number' and "option_groups"."authored_unit" is not null and "option_groups"."include_in_sku_code" = false))
);
--> statement-breakpoint
CREATE TABLE "option_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"option_group_id" uuid NOT NULL,
	"group_kind" "option_group_kind" NOT NULL,
	"code" text NOT NULL,
	"label_th" text NOT NULL,
	"swatch_hex" char(7),
	"delta_type" "price_delta_type" NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"delta_minor" bigint,
	"delta_bp" integer,
	"available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_values_group_code_key" UNIQUE("option_group_id","code"),
	CONSTRAINT "option_values_id_group_key" UNIQUE("id","option_group_id"),
	CONSTRAINT "option_values_currency_is_thb" CHECK ("option_values"."currency" = 'THB'),
	CONSTRAINT "option_values_sku_groups_only" CHECK ("option_values"."group_kind" = 'sku'),
	CONSTRAINT "option_values_swatch_hex_format" CHECK ("option_values"."swatch_hex" is null or "option_values"."swatch_hex" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "option_values_delta_shape" CHECK (case "option_values"."delta_type"
            when 'none'    then "option_values"."delta_minor" is null and "option_values"."delta_bp" is null
            when 'percent' then "option_values"."delta_minor" is null and "option_values"."delta_bp" is not null
            else "option_values"."delta_minor" is not null and "option_values"."delta_bp" is null
          end),
	CONSTRAINT "option_values_delta_whole_units" CHECK (("option_values"."delta_minor" is null or "option_values"."delta_minor" % 100 = 0)
          and ("option_values"."delta_bp" is null or "option_values"."delta_bp" % 100 = 0))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"sku_prefix" text NOT NULL,
	"category_id" text NOT NULL,
	"name_th" text NOT NULL,
	"summary_th" text NOT NULL,
	"hero_image" text NOT NULL,
	"lead_time_min_days" integer NOT NULL,
	"lead_time_max_days" integer NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"price_per_sqm_minor" bigint NOT NULL,
	"min_billable_sq_um" bigint NOT NULL,
	"elevation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_sku_prefix_unique" UNIQUE("sku_prefix"),
	CONSTRAINT "products_currency_is_thb" CHECK ("products"."currency" = 'THB'),
	CONSTRAINT "products_lead_time_ordered" CHECK ("products"."lead_time_min_days" <= "products"."lead_time_max_days"),
	CONSTRAINT "products_lead_time_nonnegative" CHECK ("products"."lead_time_min_days" >= 0),
	CONSTRAINT "products_price_positive" CHECK ("products"."price_per_sqm_minor" > 0),
	CONSTRAINT "products_price_whole_baht" CHECK ("products"."price_per_sqm_minor" % 100 = 0),
	CONSTRAINT "products_min_billable_positive" CHECK ("products"."min_billable_sq_um" > 0)
);
--> statement-breakpoint
CREATE TABLE "seed_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"core_version" text NOT NULL,
	"product_count" smallint NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_version_option_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_version_option_id" uuid NOT NULL,
	"option_group_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pvov_option_value_key" UNIQUE("product_version_option_id","option_value_id")
);
--> statement-breakpoint
CREATE TABLE "product_version_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_version_id" uuid NOT NULL,
	"option_group_id" uuid NOT NULL,
	"group_kind" "option_group_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"default_value_code" text,
	"min_um" bigint,
	"max_um" bigint,
	"step_um" bigint,
	"default_um" bigint,
	CONSTRAINT "product_version_options_version_group_key" UNIQUE("product_version_id","option_group_id"),
	CONSTRAINT "product_version_options_id_group_key" UNIQUE("id","option_group_id"),
	CONSTRAINT "product_version_options_sku_shape" CHECK ("product_version_options"."group_kind" <> 'sku' or (
            "product_version_options"."default_value_code" is not null
            and "product_version_options"."min_um" is null and "product_version_options"."max_um" is null
            and "product_version_options"."step_um" is null and "product_version_options"."default_um" is null
          )),
	CONSTRAINT "product_version_options_custom_shape" CHECK ("product_version_options"."group_kind" <> 'custom' or (
            "product_version_options"."default_value_code" is null
            and "product_version_options"."min_um" is not null and "product_version_options"."max_um" is not null
            and "product_version_options"."step_um" is not null and "product_version_options"."default_um" is not null
          )),
	CONSTRAINT "product_version_options_grid" CHECK ("product_version_options"."group_kind" <> 'custom' or (
            "product_version_options"."min_um" > 0
            and "product_version_options"."step_um" > 0
            and "product_version_options"."step_um" % 25 = 0
            and "product_version_options"."min_um" <= "product_version_options"."max_um"
            and "product_version_options"."min_um" % "product_version_options"."step_um" = 0
            and ("product_version_options"."max_um" - "product_version_options"."min_um") % "product_version_options"."step_um" = 0
            and "product_version_options"."default_um" between "product_version_options"."min_um" and "product_version_options"."max_um"
            and ("product_version_options"."default_um" - "product_version_options"."min_um") % "product_version_options"."step_um" = 0
          ))
);
--> statement-breakpoint
CREATE TABLE "product_version_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" "rule_severity" NOT NULL,
	"message_th" text NOT NULL,
	"when_expr" jsonb NOT NULL,
	"referenced_group_codes" text[] NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_version_rules_version_code_key" UNIQUE("product_version_id","code"),
	CONSTRAINT "product_version_rules_references_something" CHECK (array_length("product_version_rules"."referenced_group_codes", 1) >= 1)
);
--> statement-breakpoint
CREATE TABLE "product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" "product_version_status" DEFAULT 'draft' NOT NULL,
	"document" jsonb NOT NULL,
	"document_schema_version" smallint DEFAULT 1 NOT NULL,
	"document_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_versions_product_version_key" UNIQUE("product_id","version"),
	CONSTRAINT "product_versions_version_positive" CHECK ("product_versions"."version" > 0),
	CONSTRAINT "product_versions_published_at_present" CHECK ("product_versions"."status" <> 'published' or "product_versions"."published_at" is not null),
	CONSTRAINT "product_versions_archived_at_present" CHECK ("product_versions"."status" <> 'archived' or "product_versions"."archived_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "option_values" ADD CONSTRAINT "option_values_group_fk" FOREIGN KEY ("option_group_id","group_kind") REFERENCES "public"."option_groups"("id","kind") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_version_option_values" ADD CONSTRAINT "pvov_version_option_fk" FOREIGN KEY ("product_version_option_id","option_group_id") REFERENCES "public"."product_version_options"("id","option_group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_option_values" ADD CONSTRAINT "pvov_option_value_fk" FOREIGN KEY ("option_value_id","option_group_id") REFERENCES "public"."option_values"("id","option_group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_options" ADD CONSTRAINT "product_version_options_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_version_options" ADD CONSTRAINT "product_version_options_group_fk" FOREIGN KEY ("option_group_id","group_kind") REFERENCES "public"."option_groups"("id","kind") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_version_rules" ADD CONSTRAINT "product_version_rules_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "product_version_rules_referenced_groups_idx" ON "product_version_rules" USING gin ("referenced_group_codes");--> statement-breakpoint
CREATE UNIQUE INDEX "product_versions_one_published_per_product" ON "product_versions" USING btree ("product_id") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "product_versions_product_status_idx" ON "product_versions" USING btree ("product_id","status");