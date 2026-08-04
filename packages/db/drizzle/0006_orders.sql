CREATE TABLE "notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"outcome" text NOT NULL,
	"channel" text NOT NULL,
	"recipient_key" text NOT NULL,
	"locale" text NOT NULL,
	"rendered_subject" text,
	"provider_message_id" text,
	"error" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_attempts_attempt_key" UNIQUE("notification_id","attempt_no"),
	CONSTRAINT "notification_attempts_attempt_no_positive" CHECK ("notification_attempts"."attempt_no" >= 1),
	CONSTRAINT "notification_attempts_outcome_known" CHECK ("notification_attempts"."outcome" in ('sent', 'failed')),
	CONSTRAINT "notification_attempts_failure_has_a_reason" CHECK ("notification_attempts"."outcome" <> 'failed' or "notification_attempts"."error" is not null)
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"event_type" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"coalesce_group" text,
	"coalesce_seconds" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_rules_pkey" PRIMARY KEY("event_type","recipient_kind","channel"),
	CONSTRAINT "notification_rules_channel_known" CHECK ("notification_rules"."channel" in ('email', 'line')),
	CONSTRAINT "notification_rules_recipient_kind_known" CHECK ("notification_rules"."recipient_kind" in ('customer', 'sales_queue', 'approver_queue')),
	CONSTRAINT "notification_rules_event_type_known" CHECK ("notification_rules"."event_type" in ('created', 'quote_revised', 'submitted_for_payment', 'payment_confirmed', 'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign', 'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved')),
	CONSTRAINT "notification_rules_template_key_shape" CHECK ("notification_rules"."template_key" ~ '^[a-z][a-z0-9_.]*$'),
	CONSTRAINT "notification_rules_coalesce_window_sane" CHECK ("notification_rules"."coalesce_seconds" >= 0 and ("notification_rules"."coalesce_group" is not null or "notification_rules"."coalesce_seconds" = 0))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"latest_event_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"recipient_key" text,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"suppressed_reason" text,
	"coalesce_key" text,
	"coalesced_count" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_idempotency_key" UNIQUE NULLS NOT DISTINCT("event_id","recipient_key","channel"),
	CONSTRAINT "notifications_status_known" CHECK ("notifications"."status" in ('pending', 'sending', 'sent', 'dead', 'suppressed')),
	CONSTRAINT "notifications_channel_known" CHECK ("notifications"."channel" in ('email', 'line')),
	CONSTRAINT "notifications_recipient_kind_known" CHECK ("notifications"."recipient_kind" in ('customer', 'sales_queue', 'approver_queue')),
	CONSTRAINT "notifications_recipient_key_shape" CHECK ("notifications"."recipient_key" is null
          or "notifications"."recipient_key" ~ '^(email|user|guest|group):.+$'),
	CONSTRAINT "notifications_status_shape" CHECK (case "notifications"."status"
            when 'sent'       then "notifications"."sent_at" is not null and "notifications"."dead_at" is null
            when 'dead'       then "notifications"."dead_at" is not null and "notifications"."attempt_count" > 0
            when 'suppressed' then "notifications"."suppressed_reason" is not null and "notifications"."recipient_key" is null
            else "notifications"."sent_at" is null and "notifications"."dead_at" is null
          end),
	CONSTRAINT "notifications_addressed_unless_suppressed" CHECK ("notifications"."status" = 'suppressed' or "notifications"."recipient_key" is not null),
	CONSTRAINT "notifications_counters_nonnegative" CHECK ("notifications"."attempt_count" >= 0 and "notifications"."coalesced_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"opened_event_id" uuid NOT NULL,
	"note_th" text,
	"resolved_event_id" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_change_requests_resolution_shape" CHECK (num_nonnulls("order_change_requests"."resolved_event_id", "order_change_requests"."resolution", "order_change_requests"."resolved_at") in (0, 3)),
	CONSTRAINT "order_change_requests_resolution_known" CHECK ("order_change_requests"."resolution" is null
          or "order_change_requests"."resolution" in ('accepted', 'rejected', 'withdrawn', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "order_document_product_versions" (
	"order_document_id" uuid NOT NULL,
	"product_version_id" uuid NOT NULL,
	CONSTRAINT "order_document_product_versions_pkey" PRIMARY KEY("order_document_id","product_version_id")
);
--> statement-breakpoint
CREATE TABLE "order_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" char(64) NOT NULL,
	"pin_schema_version" smallint DEFAULT 1 NOT NULL,
	"pinned_core_version" text NOT NULL,
	"pinned_vat_rate_bp" integer NOT NULL,
	"pinned_vat_treatment" text NOT NULL,
	"pinned_locale" text NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"net_thb_minor" bigint NOT NULL,
	"vat_thb_minor" bigint NOT NULL,
	"grand_total_thb_minor" bigint NOT NULL,
	"created_by_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_documents_order_revision_key" UNIQUE("order_id","revision"),
	CONSTRAINT "order_documents_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "order_documents_revision_positive" CHECK ("order_documents"."revision" >= 1),
	CONSTRAINT "order_documents_currency_is_thb" CHECK ("order_documents"."currency" = 'THB'),
	CONSTRAINT "order_documents_hash_is_hex" CHECK ("order_documents"."document_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_documents_document_is_object" CHECK (jsonb_typeof("order_documents"."document") = 'object'),
	CONSTRAINT "order_documents_vat_treatment_known" CHECK ("order_documents"."pinned_vat_treatment" in ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
	CONSTRAINT "order_documents_vat_rate_in_range" CHECK ("order_documents"."pinned_vat_rate_bp" between 0 and 10000),
	CONSTRAINT "order_documents_total_foots" CHECK ("order_documents"."grand_total_thb_minor" = "order_documents"."net_thb_minor" + "order_documents"."vat_thb_minor"),
	CONSTRAINT "order_documents_money_nonnegative" CHECK ("order_documents"."net_thb_minor" >= 0 and "order_documents"."vat_thb_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"actor_guest_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"write_txid" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_order_seq_key" UNIQUE("order_id","seq"),
	CONSTRAINT "order_events_id_order_status_key" UNIQUE("id","order_id","to_status"),
	CONSTRAINT "order_events_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "order_events_type_known" CHECK ("order_events"."event_type" in ('created', 'quote_revised', 'submitted_for_payment', 'payment_confirmed', 'production_started', 'installation_scheduled', 'delivered', 'bounced_to_redesign', 'redesign_approved', 'cancelled', 'superseded', 'change_requested', 'change_resolved')),
	CONSTRAINT "order_events_actor_kind_known" CHECK ("order_events"."actor_kind" in ('customer', 'guest', 'staff', 'system')),
	CONSTRAINT "order_events_status_known" CHECK (("order_events"."from_status" is null or "order_events"."from_status" in ('draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'))
          and ("order_events"."to_status" is null or "order_events"."to_status" in ('draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded'))),
	CONSTRAINT "order_events_seq_positive" CHECK ("order_events"."seq" >= 1),
	CONSTRAINT "order_events_status_pair_shape" CHECK (case
            when "order_events"."to_status" is null then "order_events"."from_status" is null
            when "order_events"."from_status" is null then "order_events"."seq" = 1
            else true
          end),
	CONSTRAINT "order_events_actor_shape" CHECK (case "order_events"."actor_kind"
            when 'customer' then "order_events"."actor_user_id" is not null and "order_events"."actor_guest_id" is null
            when 'staff'    then "order_events"."actor_user_id" is not null and "order_events"."actor_guest_id" is null
            when 'guest'    then "order_events"."actor_guest_id" is not null and "order_events"."actor_user_id" is null
            else "order_events"."actor_user_id" is null and "order_events"."actor_guest_id" is null
          end),
	CONSTRAINT "order_events_payload_is_object" CHECK (jsonb_typeof("order_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "order_status_transitions" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_kind" text NOT NULL,
	"required_payload_keys" text[] DEFAULT '{}' NOT NULL,
	"allowed_actor_kinds" text[] NOT NULL,
	"description_th" text NOT NULL,
	CONSTRAINT "order_status_transitions_pkey" PRIMARY KEY("from_status","to_status"),
	CONSTRAINT "order_status_transitions_no_self_loop" CHECK ("order_status_transitions"."from_status" <> "order_status_transitions"."to_status"),
	CONSTRAINT "order_status_transitions_actor_kinds_known" CHECK ("order_status_transitions"."allowed_actor_kinds" <@ array['customer', 'guest', 'staff', 'system']::text[]
          and array_length("order_status_transitions"."allowed_actor_kinds", 1) >= 1),
	CONSTRAINT "order_status_transitions_post_freeze_cancel_demands_fault" CHECK ("order_status_transitions"."payload_kind" <> 'cancel_post_freeze'
          or "order_status_transitions"."required_payload_keys" @> array['fault', 'reason']::text[])
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_no" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_event_id" uuid NOT NULL,
	"customer_user_id" uuid,
	"guest_id" uuid,
	"contact_email" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_locale" text DEFAULT 'th' NOT NULL,
	"supersedes_order_id" uuid,
	"frozen_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"document_id" uuid,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"net_thb_minor" bigint,
	"vat_thb_minor" bigint,
	"grand_total_thb_minor" bigint,
	"scheduled_deposit_thb_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_no_unique" UNIQUE("order_no"),
	CONSTRAINT "orders_supersedes_order_key" UNIQUE("supersedes_order_id"),
	CONSTRAINT "orders_status_known" CHECK ("orders"."status" in ('draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded')),
	CONSTRAINT "orders_currency_is_thb" CHECK ("orders"."currency" = 'THB'),
	CONSTRAINT "orders_has_an_owner" CHECK (num_nonnulls("orders"."customer_user_id", "orders"."guest_id") >= 1),
	CONSTRAINT "orders_contact_email_lowercase" CHECK ("orders"."contact_email" is null or "orders"."contact_email" = lower("orders"."contact_email")),
	CONSTRAINT "orders_contact_email_shape" CHECK ("orders"."contact_email" is null
          or "orders"."contact_email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	CONSTRAINT "orders_draft_has_no_contract" CHECK ("orders"."status" <> 'draft'
          or ("orders"."submitted_at" is null and "orders"."frozen_at" is null and "orders"."document_id" is null)),
	CONSTRAINT "orders_redesign_has_a_contract" CHECK ("orders"."status" <> 'redesign'
          or ("orders"."submitted_at" is not null and "orders"."frozen_at" is not null and "orders"."document_id" is not null)),
	CONSTRAINT "orders_submitted_before_leaving_draft" CHECK ("orders"."status" in ('draft', 'cancelled') or "orders"."submitted_at" is not null),
	CONSTRAINT "orders_submitted_shape" CHECK (("orders"."submitted_at" is null) = ("orders"."order_no" is null)
          and ("orders"."submitted_at" is null) = ("orders"."document_id" is null)
          and ("orders"."submitted_at" is null) = ("orders"."grand_total_thb_minor" is null)
          and ("orders"."submitted_at" is null) = ("orders"."scheduled_deposit_thb_minor" is null)),
	CONSTRAINT "orders_submitted_has_a_contact_channel" CHECK ("orders"."submitted_at" is null or "orders"."contact_email" is not null),
	CONSTRAINT "orders_frozen_after_submitted" CHECK ("orders"."frozen_at" is null
          or ("orders"."submitted_at" is not null and "orders"."frozen_at" >= "orders"."submitted_at")),
	CONSTRAINT "orders_awaiting_payment_is_pre_freeze" CHECK ("orders"."status" <> 'awaiting_payment' or "orders"."frozen_at" is null),
	CONSTRAINT "orders_money_shape" CHECK (num_nonnulls("orders"."net_thb_minor", "orders"."vat_thb_minor", "orders"."grand_total_thb_minor") in (0, 3)),
	CONSTRAINT "orders_total_foots" CHECK ("orders"."grand_total_thb_minor" is null
          or "orders"."grand_total_thb_minor" = "orders"."net_thb_minor" + "orders"."vat_thb_minor"),
	CONSTRAINT "orders_money_nonnegative" CHECK (("orders"."net_thb_minor" is null or "orders"."net_thb_minor" >= 0)
          and ("orders"."vat_thb_minor" is null or "orders"."vat_thb_minor" >= 0)),
	CONSTRAINT "orders_scheduled_deposit_within_total" CHECK ("orders"."scheduled_deposit_thb_minor" is null
          or ("orders"."scheduled_deposit_thb_minor" >= 0
              and "orders"."scheduled_deposit_thb_minor" <= "orders"."grand_total_thb_minor")),
	CONSTRAINT "orders_not_own_successor" CHECK ("orders"."supersedes_order_id" is distinct from "orders"."id")
);
--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_fk" FOREIGN KEY ("event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_latest_event_fk" FOREIGN KEY ("latest_event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_opened_event_fk" FOREIGN KEY ("opened_event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_change_requests" ADD CONSTRAINT "order_change_requests_resolved_event_fk" FOREIGN KEY ("resolved_event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_document_product_versions" ADD CONSTRAINT "order_document_product_versions_order_document_id_order_documents_id_fk" FOREIGN KEY ("order_document_id") REFERENCES "public"."order_documents"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_document_product_versions" ADD CONSTRAINT "order_document_product_versions_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_documents" ADD CONSTRAINT "order_documents_created_by_event_fk" FOREIGN KEY ("created_by_event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_guest_id_guests_id_fk" FOREIGN KEY ("actor_guest_id") REFERENCES "public"."guests"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "notification_attempts_notification_idx" ON "notification_attempts" USING btree ("notification_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_pending_coalesce_key" ON "notifications" USING btree ("order_id","coalesce_key","recipient_key","channel") WHERE status = 'pending' and coalesce_key is not null;--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("send_after") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_dead_idx" ON "notifications" USING btree ("dead_at") WHERE status = 'dead';--> statement-breakpoint
CREATE INDEX "notifications_order_idx" ON "notifications" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_change_requests_one_open" ON "order_change_requests" USING btree ("order_id") WHERE resolved_event_id is null;--> statement-breakpoint
CREATE INDEX "order_change_requests_order_idx" ON "order_change_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_document_product_versions_version_idx" ON "order_document_product_versions" USING btree ("product_version_id");--> statement-breakpoint
CREATE INDEX "order_documents_order_idx" ON "order_documents" USING btree ("order_id","revision");--> statement-breakpoint
CREATE INDEX "order_events_order_seq_idx" ON "order_events" USING btree ("order_id","seq");--> statement-breakpoint
CREATE INDEX "order_events_type_idx" ON "order_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "orders_customer_status_idx" ON "orders" USING btree ("customer_user_id","status");--> statement-breakpoint
CREATE INDEX "orders_guest_idx" ON "orders" USING btree ("guest_id") WHERE guest_id is not null;--> statement-breakpoint
CREATE INDEX "orders_live_status_idx" ON "orders" USING btree ("status","updated_at") WHERE status not in ('cancelled', 'superseded', 'delivered');