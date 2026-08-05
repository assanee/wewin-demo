ALTER TABLE "orders" ADD COLUMN "forfeit_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD COLUMN "payer_verified_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD COLUMN "payer_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD COLUMN "unallocated_thb_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD COLUMN "submitted_by_guest_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_payer_verified_by_user_id_users_id_fk" FOREIGN KEY ("payer_verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_submitted_by_guest_id_guests_id_fk" FOREIGN KEY ("submitted_by_guest_id") REFERENCES "public"."guests"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_instalments" ADD CONSTRAINT "order_instalments_gate_is_ahead_of_payment" CHECK ("order_instalments"."gates_entry_to" is null
          or "order_instalments"."gates_entry_to" in ('production_confirmed', 'in_production', 'awaiting_installation', 'delivered'));--> statement-breakpoint
ALTER TABLE "order_instalments" ADD CONSTRAINT "order_instalments_gate_needs_money" CHECK ("order_instalments"."gates_entry_to" is null or "order_instalments"."due_thb_minor" > 0);--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_unallocated_nonnegative" CHECK ("payment_slips"."unallocated_thb_minor" >= 0);--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_unallocated_within_amount" CHECK ("payment_slips"."unallocated_thb_minor" <= "payment_slips"."amount_thb_minor");--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_unallocated_needs_acceptance" CHECK ("payment_slips"."status" = 'accepted' or "payment_slips"."unallocated_thb_minor" = 0);--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_payer_verified_shape" CHECK (num_nonnulls("payment_slips"."payer_verified_by_user_id", "payment_slips"."payer_verified_at") in (0, 2));--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_payer_verified_needs_payer" CHECK ("payment_slips"."payer_verified_by_user_id" is null
          or ("payment_slips"."payer_name" is not null and "payment_slips"."payer_account_last4" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_forfeit_policy_id_forfeit_policies_id_fk" FOREIGN KEY ("forfeit_policy_id") REFERENCES "public"."forfeit_policies"("id") ON DELETE restrict ON UPDATE cascade;
