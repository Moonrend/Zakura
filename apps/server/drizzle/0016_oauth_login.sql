-- 0016_oauth_login
-- Platform login OAuth (ZeroCat etc.): identities + PKCE state; OAuth-only users may lack password.

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "user_id" text NOT NULL,
  "profile_json" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_identities_provider_user" ON "oauth_identities" ("provider","provider_user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oauth_identities_user" ON "oauth_identities" ("user_id");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_login_states" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "code_verifier" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oauth_login_states_expires" ON "oauth_login_states" ("expires_at");
