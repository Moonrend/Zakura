CREATE TABLE IF NOT EXISTS "agent_projects" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "instructions" text DEFAULT '' NOT NULL,
  "has_workspace" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_projects_agent_slug" ON "agent_projects" ("agent_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_projects_agent" ON "agent_projects" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_projects_tenant" ON "agent_projects" ("tenant_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
