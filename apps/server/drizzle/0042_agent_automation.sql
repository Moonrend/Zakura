-- Agent automation: cron schedules + periodic heartbeats + run audit log

CREATE TABLE IF NOT EXISTS "agent_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "pattern" text NOT NULL,
  "prompt" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "max_runs" integer,
  "run_count" integer DEFAULT 0 NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "last_status" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_heartbeats" (
  "agent_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "interval_minutes" integer DEFAULT 60 NOT NULL,
  "prompt" text DEFAULT '' NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "last_status" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_automation_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "kind" text NOT NULL,
  "schedule_id" text,
  "session_id" text,
  "cloud_run_id" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "prompt" text DEFAULT '' NOT NULL,
  "result_text" text,
  "error" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "agent_heartbeats_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "agent_heartbeats_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_automation_runs" ADD CONSTRAINT "agent_automation_runs_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_automation_runs" ADD CONSTRAINT "agent_automation_runs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_automation_runs" ADD CONSTRAINT "agent_automation_runs_schedule_id_agent_schedules_id_fk"
    FOREIGN KEY ("schedule_id") REFERENCES "public"."agent_schedules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_agent" ON "agent_schedules" ("agent_id","enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_due" ON "agent_schedules" ("enabled","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_tenant" ON "agent_schedules" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_heartbeats_due" ON "agent_heartbeats" ("enabled","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_heartbeats_tenant" ON "agent_heartbeats" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_automation_runs_agent" ON "agent_automation_runs" ("agent_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_automation_runs_schedule" ON "agent_automation_runs" ("schedule_id","created_at");
