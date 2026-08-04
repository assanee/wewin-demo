CREATE TYPE "public"."auth_provider" AS ENUM('line', 'google', 'facebook', 'apple');--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."pkce_method" AS ENUM('S256');--> statement-breakpoint
CREATE TYPE "public"."refresh_rotation_outcome" AS ENUM('rotated', 'graced', 'reused', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."session_revocation_reason" AS ENUM('logout', 'refresh_reuse', 'password_changed', 'email_changed', 'revoked_by_admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"user_id" uuid NOT NULL,
	"user_email_id" uuid,
	"token_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "auth_tokens_token_hash_is_digest" CHECK ("auth_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_tokens_expires_after_created" CHECK ("auth_tokens"."expires_at" > "auth_tokens"."created_at"),
	CONSTRAINT "auth_tokens_email_target_shape" CHECK (case "auth_tokens"."purpose"
            when 'email_verification' then "auth_tokens"."user_email_id" is not null
            else "auth_tokens"."user_email_id" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "group_permissions" (
	"group_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_permissions_pkey" PRIMARY KEY("group_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_th" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_code_unique" UNIQUE("code"),
	CONSTRAINT "groups_code_shape" CHECK ("groups"."code" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claimed_by_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_claim_shape" CHECK (("guests"."claimed_by_user_id" is null) = ("guests"."claimed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"state_hash" char(64) NOT NULL,
	"binding_hash" char(64) NOT NULL,
	"pkce_method" "pkce_method" DEFAULT 'S256' NOT NULL,
	"pkce_challenge" text NOT NULL,
	"return_to" text DEFAULT '/' NOT NULL,
	"guest_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_states_state_hash_key" UNIQUE("state_hash"),
	CONSTRAINT "oauth_states_state_hash_is_digest" CHECK ("oauth_states"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_states_binding_hash_is_digest" CHECK ("oauth_states"."binding_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_states_expires_after_created" CHECK ("oauth_states"."expires_at" > "oauth_states"."created_at"),
	CONSTRAINT "oauth_states_pkce_challenge_shape" CHECK ("oauth_states"."pkce_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_states_return_to_is_local" CHECK (left("oauth_states"."return_to", 1) = '/'
          and left("oauth_states"."return_to", 2) <> '//'
          and left("oauth_states"."return_to", 2) <> ('/' || chr(92)))
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_credentials_argon2id" CHECK ("password_credentials"."password_hash" like '$argon2id$%')
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_code_shape" CHECK ("permissions"."code" ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "provider_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"subject" text NOT NULL,
	"asserted_email" text,
	"asserted_email_verified" boolean DEFAULT false NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_identities_provider_subject_key" UNIQUE("provider","subject"),
	CONSTRAINT "provider_identities_asserted_email_lowercase" CHECK ("provider_identities"."asserted_email" is null or "provider_identities"."asserted_email" = lower("provider_identities"."asserted_email")),
	CONSTRAINT "provider_identities_asserted_email_present" CHECK (not "provider_identities"."asserted_email_verified" or "provider_identities"."asserted_email" is not null)
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"parent_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "refresh_tokens_token_hash_is_digest" CHECK ("refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "refresh_tokens_expires_after_issued" CHECK ("refresh_tokens"."expires_at" > "refresh_tokens"."issued_at"),
	CONSTRAINT "refresh_tokens_consumed_after_issued" CHECK ("refresh_tokens"."consumed_at" is null or "refresh_tokens"."consumed_at" >= "refresh_tokens"."issued_at"),
	CONSTRAINT "refresh_tokens_not_own_parent" CHECK ("refresh_tokens"."parent_id" is distinct from "refresh_tokens"."id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "session_revocation_reason",
	CONSTRAINT "sessions_expires_after_created" CHECK ("sessions"."expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_revocation_shape" CHECK (("sessions"."revoked_at" is null) = ("sessions"."revoked_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "user_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_user_address_key" UNIQUE("user_id","address"),
	CONSTRAINT "user_emails_address_lowercase" CHECK ("user_emails"."address" = lower("user_emails"."address")),
	CONSTRAINT "user_emails_address_shape" CHECK ("user_emails"."address" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	CONSTRAINT "user_emails_primary_is_verified" CHECK (not "user_emails"."is_primary" or "user_emails"."verified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_user_id" uuid,
	CONSTRAINT "user_groups_pkey" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_suspended_at_present" CHECK ("users"."status" <> 'suspended' or "users"."suspended_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_email_id_user_emails_id_fk" FOREIGN KEY ("user_email_id") REFERENCES "public"."user_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_identities" ADD CONSTRAINT "provider_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_user_idx" ON "auth_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "group_permissions_permission_idx" ON "group_permissions" USING btree ("permission_code");--> statement-breakpoint
CREATE INDEX "guests_claimed_by_idx" ON "guests" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "provider_identities_user_idx" ON "provider_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_emails_one_verified_owner" ON "user_emails" USING btree ("address") WHERE verified_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_emails_one_primary_per_user" ON "user_emails" USING btree ("user_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "user_emails_address_idx" ON "user_emails" USING btree ("address");--> statement-breakpoint
CREATE INDEX "user_groups_group_idx" ON "user_groups" USING btree ("group_id");