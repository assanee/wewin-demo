CREATE TABLE "mfa_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_sealed" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_accepted_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_credentials_secret_sealed" CHECK ("mfa_credentials"."secret_sealed" like 'v1.%'),
	CONSTRAINT "mfa_credentials_step_positive" CHECK ("mfa_credentials"."last_accepted_step" is null or "mfa_credentials"."last_accepted_step" > 0)
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_recovery_codes_user_hash_key" UNIQUE("user_id","code_hash"),
	CONSTRAINT "mfa_recovery_codes_hash_hex" CHECK ("mfa_recovery_codes"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mfa_credentials" ADD CONSTRAINT "mfa_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_unused_idx" ON "mfa_recovery_codes" USING btree ("user_id") WHERE used_at is null;