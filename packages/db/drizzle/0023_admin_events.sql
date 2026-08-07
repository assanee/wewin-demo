CREATE TABLE "admin_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"subject_user_id" uuid,
	"subject_group_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_events_action_known" CHECK ("admin_events"."action" in ('user.created', 'user.suspended', 'user.reinstated', 'user.groups_changed', 'user.sessions_revoked', 'user.password_link_sent', 'user.mfa_disabled', 'group.created', 'group.renamed', 'group.deleted', 'group.permissions_changed')),
	CONSTRAINT "admin_events_not_both_subjects" CHECK ("admin_events"."subject_user_id" is null or "admin_events"."subject_group_id" is null),
	CONSTRAINT "admin_events_group_actions_carry_a_code" CHECK ("admin_events"."action" not like 'group.%' or "admin_events"."payload" ? 'code'),
	CONSTRAINT "admin_events_user_actions_name_a_user" CHECK ("admin_events"."action" not like 'user.%' or "admin_events"."subject_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "admin_events" ADD CONSTRAINT "admin_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "admin_events" ADD CONSTRAINT "admin_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "admin_events_seq_idx" ON "admin_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "admin_events_subject_user_idx" ON "admin_events" USING btree ("subject_user_id","seq");--> statement-breakpoint
CREATE INDEX "admin_events_actor_idx" ON "admin_events" USING btree ("actor_user_id","seq");