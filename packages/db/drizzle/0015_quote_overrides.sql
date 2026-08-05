CREATE TABLE "authority_limits" (
	"group_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"max_concession_thb_minor" bigint NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"note_th" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_limits_pkey" PRIMARY KEY("group_id","dimension"),
	CONSTRAINT "authority_limits_dimension_known" CHECK ("authority_limits"."dimension" in ('margin', 'cashflow')),
	CONSTRAINT "authority_limits_ceiling_nonnegative" CHECK ("authority_limits"."max_concession_thb_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"product_version_id" uuid,
	"sku_code" text,
	"selections" jsonb,
	"measures" jsonb,
	"config_hash" char(64),
	"qty" integer DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"computed_total_thb_minor" bigint,
	"charge_total_thb_minor" bigint,
	"is_vat_applicable" boolean DEFAULT true NOT NULL,
	"customer_description_th" text,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_lines_order_seq_key" UNIQUE("order_id","seq"),
	CONSTRAINT "quote_lines_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "quote_lines_seq_positive" CHECK ("quote_lines"."seq" >= 1),
	CONSTRAINT "quote_lines_kind_known" CHECK ("quote_lines"."kind" in ('catalog', 'freeform')),
	CONSTRAINT "quote_lines_currency_is_thb" CHECK ("quote_lines"."currency" = 'THB'),
	CONSTRAINT "quote_lines_qty_positive" CHECK ("quote_lines"."qty" >= 1),
	CONSTRAINT "quote_lines_kind_shape" CHECK (case "quote_lines"."kind"
            when 'catalog' then "quote_lines"."product_version_id" is not null
                                 and "quote_lines"."sku_code" is not null
                                 and "quote_lines"."selections" is not null
                                 and "quote_lines"."measures" is not null
                                 and "quote_lines"."config_hash" is not null
                                 and "quote_lines"."computed_total_thb_minor" is not null
                                 and "quote_lines"."charge_total_thb_minor" is null
            else "quote_lines"."product_version_id" is null
                 and "quote_lines"."sku_code" is null
                 and "quote_lines"."selections" is null
                 and "quote_lines"."measures" is null
                 and "quote_lines"."config_hash" is null
                 and "quote_lines"."computed_total_thb_minor" is null
                 and "quote_lines"."charge_total_thb_minor" is not null
          end),
	CONSTRAINT "quote_lines_computed_nonnegative" CHECK ("quote_lines"."computed_total_thb_minor" is null or "quote_lines"."computed_total_thb_minor" >= 0),
	CONSTRAINT "quote_lines_charge_nonzero" CHECK ("quote_lines"."charge_total_thb_minor" is null or "quote_lines"."charge_total_thb_minor" <> 0),
	CONSTRAINT "quote_lines_config_hash_is_hex" CHECK ("quote_lines"."config_hash" is null or "quote_lines"."config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quote_lines_selections_is_object" CHECK ("quote_lines"."selections" is null or jsonb_typeof("quote_lines"."selections") = 'object'),
	CONSTRAINT "quote_lines_measures_is_object" CHECK ("quote_lines"."measures" is null or jsonb_typeof("quote_lines"."measures") = 'object'),
	CONSTRAINT "quote_lines_removal_shape" CHECK (num_nonnulls("quote_lines"."removed_at", "quote_lines"."removed_by_user_id") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "quote_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"quote_line_id" uuid,
	"anchor" text NOT NULL,
	"computed_thb_minor" bigint,
	"override_thb_minor" bigint,
	"computed_days" integer,
	"override_days" integer,
	"entered_as" text NOT NULL,
	"entered_value_text" text NOT NULL,
	"reason_code" text NOT NULL,
	"note_th" text,
	"set_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_override_id" uuid,
	"superseded_by_user_id" uuid,
	"supersession_reason" text,
	CONSTRAINT "quote_overrides_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "quote_overrides_anchor_known" CHECK ("quote_overrides"."anchor" in ('line_total', 'grand_total', 'lead_time_days')),
	CONSTRAINT "quote_overrides_entered_as_known" CHECK ("quote_overrides"."entered_as" in ('line_total', 'unit_price', 'grand_total', 'percent_discount', 'discount_amount', 'lead_time_days')),
	CONSTRAINT "quote_overrides_reason_known" CHECK ("quote_overrides"."reason_code" in ('price_match', 'volume', 'relationship', 'goodwill', 'correction', 'rounding', 'other')),
	CONSTRAINT "quote_overrides_supersession_reason_known" CHECK ("quote_overrides"."supersession_reason" is null
          or "quote_overrides"."supersession_reason" in ('replaced', 'revoked')),
	CONSTRAINT "quote_overrides_scope_shape" CHECK (("quote_overrides"."anchor" = 'line_total') = ("quote_overrides"."quote_line_id" is not null)),
	CONSTRAINT "quote_overrides_value_shape" CHECK (case "quote_overrides"."anchor"
            when 'lead_time_days' then "quote_overrides"."computed_days" is not null and "quote_overrides"."override_days" is not null
                                       and "quote_overrides"."computed_thb_minor" is null and "quote_overrides"."override_thb_minor" is null
            else "quote_overrides"."computed_thb_minor" is not null and "quote_overrides"."override_thb_minor" is not null
                 and "quote_overrides"."computed_days" is null and "quote_overrides"."override_days" is null
          end),
	CONSTRAINT "quote_overrides_money_nonnegative" CHECK (("quote_overrides"."computed_thb_minor" is null or "quote_overrides"."computed_thb_minor" >= 0)
          and ("quote_overrides"."override_thb_minor" is null or "quote_overrides"."override_thb_minor" >= 0)),
	CONSTRAINT "quote_overrides_days_nonnegative" CHECK (("quote_overrides"."computed_days" is null or "quote_overrides"."computed_days" >= 0)
          and ("quote_overrides"."override_days" is null or "quote_overrides"."override_days" >= 0)),
	CONSTRAINT "quote_overrides_value_differs" CHECK ("quote_overrides"."override_thb_minor" is distinct from "quote_overrides"."computed_thb_minor"
          or "quote_overrides"."override_days" is distinct from "quote_overrides"."computed_days"),
	CONSTRAINT "quote_overrides_entry_mode_fits_anchor" CHECK (case "quote_overrides"."anchor"
            when 'line_total'     then "quote_overrides"."entered_as" in ('line_total', 'unit_price', 'percent_discount', 'discount_amount')
            when 'grand_total'    then "quote_overrides"."entered_as" in ('grand_total', 'percent_discount', 'discount_amount')
            else "quote_overrides"."entered_as" = 'lead_time_days'
          end),
	CONSTRAINT "quote_overrides_entered_text_present" CHECK (btrim("quote_overrides"."entered_value_text") <> ''),
	CONSTRAINT "quote_overrides_other_needs_a_note" CHECK ("quote_overrides"."reason_code" <> 'other' or btrim(coalesce("quote_overrides"."note_th", '')) <> ''),
	CONSTRAINT "quote_overrides_supersession_shape" CHECK (case
            when "quote_overrides"."superseded_at" is null
              then "quote_overrides"."superseded_by_user_id" is null and "quote_overrides"."supersession_reason" is null
                   and "quote_overrides"."superseded_by_override_id" is null
            else "quote_overrides"."superseded_by_user_id" is not null and "quote_overrides"."supersession_reason" is not null
                 and ("quote_overrides"."supersession_reason" <> 'replaced') = ("quote_overrides"."superseded_by_override_id" is null)
          end),
	CONSTRAINT "quote_overrides_successor_is_another_row" CHECK ("quote_overrides"."superseded_by_override_id" is distinct from "quote_overrides"."id")
);
--> statement-breakpoint
ALTER TABLE "authority_limits" ADD CONSTRAINT "authority_limits_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "authority_limits" ADD CONSTRAINT "authority_limits_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_superseded_by_user_id_users_id_fk" FOREIGN KEY ("superseded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "quote_overrides" ADD CONSTRAINT "quote_overrides_line_fk" FOREIGN KEY ("quote_line_id","order_id") REFERENCES "public"."quote_lines"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "authority_limits_dimension_idx" ON "authority_limits" USING btree ("dimension");--> statement-breakpoint
CREATE INDEX "quote_lines_order_seq_idx" ON "quote_lines" USING btree ("order_id","seq");--> statement-breakpoint
CREATE INDEX "quote_lines_live_idx" ON "quote_lines" USING btree ("order_id","seq") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "quote_lines_product_version_idx" ON "quote_lines" USING btree ("product_version_id") WHERE product_version_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "quote_overrides_one_active_per_line" ON "quote_overrides" USING btree ("quote_line_id","anchor") WHERE superseded_at is null and quote_line_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "quote_overrides_one_active_per_document" ON "quote_overrides" USING btree ("order_id","anchor") WHERE superseded_at is null and quote_line_id is null;--> statement-breakpoint
CREATE INDEX "quote_overrides_active_idx" ON "quote_overrides" USING btree ("order_id","anchor") WHERE superseded_at is null;--> statement-breakpoint
CREATE INDEX "quote_overrides_history_idx" ON "quote_overrides" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "quote_overrides_line_idx" ON "quote_overrides" USING btree ("quote_line_id") WHERE quote_line_id is not null;