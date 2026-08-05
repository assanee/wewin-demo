CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_document_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"concession_thb_minor" bigint NOT NULL,
	"reason_th" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note_th" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_document_dimension_key" UNIQUE("order_document_id","dimension"),
	CONSTRAINT "approvals_dimension_known" CHECK ("approvals"."dimension" in ('margin', 'cashflow')),
	CONSTRAINT "approvals_status_known" CHECK ("approvals"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "approvals_concession_positive" CHECK ("approvals"."concession_thb_minor" > 0),
	CONSTRAINT "approvals_decision_shape" CHECK (case "approvals"."status"
            when 'pending' then "approvals"."decided_by_user_id" is null and "approvals"."decided_at" is null
            else "approvals"."decided_by_user_id" is not null and "approvals"."decided_at" is not null
          end),
	CONSTRAINT "approvals_decider_is_not_requester" CHECK ("approvals"."decided_by_user_id" is null
          or "approvals"."decided_by_user_id" <> "approvals"."requested_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "forfeit_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description_th" text NOT NULL,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forfeit_policies_code_unique" UNIQUE("code"),
	CONSTRAINT "forfeit_policies_code_shape" CHECK ("forfeit_policies"."code" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "forfeit_policy_rules" (
	"policy_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"fault" text NOT NULL,
	"forfeit_bp" integer NOT NULL,
	"note_th" text,
	CONSTRAINT "forfeit_policy_rules_pkey" PRIMARY KEY("policy_id","from_status","fault"),
	CONSTRAINT "forfeit_policy_rules_from_status_known" CHECK ("forfeit_policy_rules"."from_status" in ('draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded')),
	CONSTRAINT "forfeit_policy_rules_fault_known" CHECK ("forfeit_policy_rules"."fault" in ('customer', 'company')),
	CONSTRAINT "forfeit_policy_rules_bp_in_range" CHECK ("forfeit_policy_rules"."forfeit_bp" between 0 and 10000),
	CONSTRAINT "forfeit_policy_rules_freeze_point_forfeits_nothing" CHECK ("forfeit_policy_rules"."from_status" <> 'production_confirmed' or "forfeit_policy_rules"."forfeit_bp" = 0),
	CONSTRAINT "forfeit_policy_rules_company_fault_forfeits_nothing" CHECK ("forfeit_policy_rules"."fault" <> 'company' or "forfeit_policy_rules"."forfeit_bp" = 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"slip_id" uuid,
	"event_id" uuid,
	"variance_kind" text,
	"memo_th" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "ledger_entries_kind_known" CHECK ("ledger_entries"."kind" in ('slip_accepted', 'remittance_landed', 'revenue_recognised', 'carried_forward', 'forfeited', 'refund_accrued', 'refund_disbursed', 'variance')),
	CONSTRAINT "ledger_entries_variance_kind_known" CHECK ("ledger_entries"."variance_kind" is null or "ledger_entries"."variance_kind" in ('fx_spread', 'bank_fee', 'refund_fx')),
	CONSTRAINT "ledger_entries_variance_shape" CHECK (("ledger_entries"."kind" = 'variance') = ("ledger_entries"."variance_kind" is not null)),
	CONSTRAINT "ledger_entries_slip_required" CHECK ("ledger_entries"."kind" not in ('slip_accepted', 'remittance_landed') or "ledger_entries"."slip_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"leg_no" integer NOT NULL,
	"account" text NOT NULL,
	"amount_thb_minor" bigint NOT NULL,
	CONSTRAINT "ledger_postings_entry_leg_key" UNIQUE("entry_id","leg_no"),
	CONSTRAINT "ledger_postings_account_known" CHECK ("ledger_postings"."account" in ('bank_thb', 'remittance_in_transit', 'deposit_held', 'refund_payable', 'credit_clearing', 'trade_receivable', 'revenue', 'forfeited', 'settlement_variance')),
	CONSTRAINT "ledger_postings_leg_no_positive" CHECK ("ledger_postings"."leg_no" >= 1),
	CONSTRAINT "ledger_postings_amount_nonzero" CHECK ("ledger_postings"."amount_thb_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "order_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"basis" text NOT NULL,
	"percent_bp" integer,
	"fixed_thb_minor" bigint,
	"due_thb_minor" bigint NOT NULL,
	"gates_entry_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_instalments_order_seq_key" UNIQUE("order_id","seq"),
	CONSTRAINT "order_instalments_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "order_instalments_seq_positive" CHECK ("order_instalments"."seq" >= 1),
	CONSTRAINT "order_instalments_basis_known" CHECK ("order_instalments"."basis" in ('percent', 'fixed', 'remainder')),
	CONSTRAINT "order_instalments_gate_known" CHECK ("order_instalments"."gates_entry_to" is null or "order_instalments"."gates_entry_to" in ('draft', 'awaiting_payment', 'production_confirmed', 'in_production', 'awaiting_installation', 'delivered', 'redesign', 'cancelled', 'superseded')),
	CONSTRAINT "order_instalments_basis_shape" CHECK (case "order_instalments"."basis"
            when 'percent'   then "order_instalments"."percent_bp" between 1 and 10000 and "order_instalments"."fixed_thb_minor" is null
            when 'fixed'     then "order_instalments"."fixed_thb_minor" >= 0 and "order_instalments"."percent_bp" is null
            else "order_instalments"."percent_bp" is null and "order_instalments"."fixed_thb_minor" is null
          end),
	CONSTRAINT "order_instalments_due_nonnegative" CHECK ("order_instalments"."due_thb_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_payment_schedules" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payment_schedules_closed_shape" CHECK (num_nonnulls("order_payment_schedules"."closed_at", "order_payment_schedules"."closed_reason") in (0, 2)),
	CONSTRAINT "order_payment_schedules_close_reason_known" CHECK ("order_payment_schedules"."closed_reason" is null or "order_payment_schedules"."closed_reason" in ('cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "payment_slips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"amount_thb_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"bank_reference" text,
	"storage_key" text,
	"storage_key_erased_at" timestamp with time zone,
	"payer_name" text,
	"payer_account_last4" char(4),
	"submitted_by_user_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"rejected_reason_th" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_slips_id_order_key" UNIQUE("id","order_id"),
	CONSTRAINT "payment_slips_status_known" CHECK ("payment_slips"."status" in ('submitted', 'accepted', 'rejected')),
	CONSTRAINT "payment_slips_currency_is_thb" CHECK ("payment_slips"."currency" = 'THB'),
	CONSTRAINT "payment_slips_amount_positive" CHECK ("payment_slips"."amount_thb_minor" > 0),
	CONSTRAINT "payment_slips_payer_last4_shape" CHECK ("payment_slips"."payer_account_last4" is null or "payment_slips"."payer_account_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_slips_erasure_shape" CHECK ("payment_slips"."storage_key_erased_at" is null or "payment_slips"."storage_key" is null),
	CONSTRAINT "payment_slips_review_shape" CHECK (case "payment_slips"."status"
            when 'submitted' then "payment_slips"."reviewed_by_user_id" is null and "payment_slips"."reviewed_at" is null
                                  and "payment_slips"."rejected_reason_th" is null
            when 'accepted'  then "payment_slips"."reviewed_by_user_id" is not null and "payment_slips"."reviewed_at" is not null
                                  and "payment_slips"."rejected_reason_th" is null
            else "payment_slips"."reviewed_by_user_id" is not null and "payment_slips"."reviewed_at" is not null
                                  and "payment_slips"."rejected_reason_th" is not null
          end),
	CONSTRAINT "payment_slips_reviewer_is_not_submitter" CHECK ("payment_slips"."reviewed_by_user_id" is null
          or "payment_slips"."reviewed_by_user_id" is distinct from "payment_slips"."submitted_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"accrual_entry_id" uuid NOT NULL,
	"amount_thb_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'THB' NOT NULL,
	"payee_name" text NOT NULL,
	"payee_bank_code" text NOT NULL,
	"payee_account_last4" char(4) NOT NULL,
	"payee_is_original_account" text DEFAULT 'yes' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"disbursed_by_user_id" uuid,
	"disbursed_at" timestamp with time zone,
	"disbursement_reference" text,
	"rejected_reason_th" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_accrual_entry_key" UNIQUE("accrual_entry_id"),
	CONSTRAINT "refunds_status_known" CHECK ("refunds"."status" in ('requested', 'approved', 'rejected', 'disbursed')),
	CONSTRAINT "refunds_currency_is_thb" CHECK ("refunds"."currency" = 'THB'),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_thb_minor" > 0),
	CONSTRAINT "refunds_payee_last4_shape" CHECK ("refunds"."payee_account_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "refunds_payee_original_known" CHECK ("refunds"."payee_is_original_account" in ('yes', 'no')),
	CONSTRAINT "refunds_status_shape" CHECK (case "refunds"."status"
            when 'requested' then "refunds"."approved_by_user_id" is null and "refunds"."disbursed_by_user_id" is null
                                  and "refunds"."rejected_reason_th" is null
            when 'rejected'  then "refunds"."rejected_reason_th" is not null and "refunds"."disbursed_by_user_id" is null
            when 'approved'  then "refunds"."approved_by_user_id" is not null and "refunds"."approved_at" is not null
                                  and "refunds"."disbursed_by_user_id" is null
            else "refunds"."approved_by_user_id" is not null and "refunds"."disbursed_by_user_id" is not null
                 and "refunds"."disbursed_at" is not null and "refunds"."disbursement_reference" is not null
          end),
	CONSTRAINT "refunds_approver_is_not_requester" CHECK ("refunds"."approved_by_user_id" is null
          or "refunds"."approved_by_user_id" <> "refunds"."requested_by_user_id"),
	CONSTRAINT "refunds_disburser_is_not_approver" CHECK ("refunds"."disbursed_by_user_id" is null
          or "refunds"."disbursed_by_user_id" <> "refunds"."approved_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "slip_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slip_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"amount_thb_minor" bigint NOT NULL,
	"carried_from_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slip_allocations_slip_instalment_key" UNIQUE("slip_id","instalment_id"),
	CONSTRAINT "slip_allocations_amount_positive" CHECK ("slip_allocations"."amount_thb_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_document_fk" FOREIGN KEY ("order_document_id","order_id") REFERENCES "public"."order_documents"("id","order_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "forfeit_policy_rules" ADD CONSTRAINT "forfeit_policy_rules_policy_id_forfeit_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."forfeit_policies"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_slip_id_payment_slips_id_fk" FOREIGN KEY ("slip_id") REFERENCES "public"."payment_slips"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_event_fk" FOREIGN KEY ("event_id","order_id") REFERENCES "public"."order_events"("id","order_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_slip_fk" FOREIGN KEY ("slip_id","order_id") REFERENCES "public"."payment_slips"("id","order_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_entry_fk" FOREIGN KEY ("entry_id","order_id") REFERENCES "public"."ledger_entries"("id","order_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_instalments" ADD CONSTRAINT "order_instalments_order_id_order_payment_schedules_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order_payment_schedules"("order_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_payment_schedules" ADD CONSTRAINT "order_payment_schedules_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_disbursed_by_user_id_users_id_fk" FOREIGN KEY ("disbursed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_accrual_entry_fk" FOREIGN KEY ("accrual_entry_id","order_id") REFERENCES "public"."ledger_entries"("id","order_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "slip_allocations" ADD CONSTRAINT "slip_allocations_slip_id_payment_slips_id_fk" FOREIGN KEY ("slip_id") REFERENCES "public"."payment_slips"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "slip_allocations" ADD CONSTRAINT "slip_allocations_instalment_id_order_instalments_id_fk" FOREIGN KEY ("instalment_id") REFERENCES "public"."order_instalments"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "slip_allocations" ADD CONSTRAINT "slip_allocations_carried_from_order_id_orders_id_fk" FOREIGN KEY ("carried_from_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_order_idx" ON "approvals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_idx" ON "ledger_entries" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_kind_idx" ON "ledger_entries" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_postings_order_account_idx" ON "ledger_postings" USING btree ("order_id","account");--> statement-breakpoint
CREATE UNIQUE INDEX "order_instalments_one_remainder" ON "order_instalments" USING btree ("order_id") WHERE basis = 'remainder';--> statement-breakpoint
CREATE INDEX "order_instalments_order_seq_idx" ON "order_instalments" USING btree ("order_id","seq");--> statement-breakpoint
CREATE INDEX "order_instalments_gate_idx" ON "order_instalments" USING btree ("gates_entry_to") WHERE gates_entry_to is not null;--> statement-breakpoint
CREATE INDEX "payment_slips_review_queue_idx" ON "payment_slips" USING btree ("transferred_at") WHERE status = 'submitted';--> statement-breakpoint
CREATE INDEX "payment_slips_order_idx" ON "payment_slips" USING btree ("order_id","transferred_at");--> statement-breakpoint
CREATE INDEX "refunds_payable_queue_idx" ON "refunds" USING btree ("approved_at") WHERE status = 'approved';--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id","requested_at");--> statement-breakpoint
CREATE INDEX "slip_allocations_instalment_idx" ON "slip_allocations" USING btree ("instalment_id");--> statement-breakpoint
CREATE INDEX "slip_allocations_slip_idx" ON "slip_allocations" USING btree ("slip_id");--> statement-breakpoint
CREATE INDEX "slip_allocations_carried_idx" ON "slip_allocations" USING btree ("carried_from_order_id") WHERE carried_from_order_id is not null;