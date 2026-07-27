-- Temporary public download links for agent workspace files
CREATE TABLE IF NOT EXISTS "file_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"path" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"ttl_minutes" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"disposition" text DEFAULT 'attachment' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_shares_token" ON "file_shares" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_shares_agent" ON "file_shares" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_shares_tenant" ON "file_shares" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_shares_expires" ON "file_shares" USING btree ("expires_at");
