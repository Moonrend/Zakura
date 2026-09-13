-- Routine: listener trigger + ask_user questions

ALTER TABLE "agent_schedules" ALTER COLUMN "pattern" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "trigger_kind" text DEFAULT 'cron' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "listener_json" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "webhook_secret" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_trigger" ON "agent_schedules" ("agent_id","trigger_kind","enabled");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_user_questions" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "session_id" text NOT NULL,
  "run_id" text,
  "tool_call_id" text,
  "question" text NOT NULL,
  "options_json" text DEFAULT '[]' NOT NULL,
  "allow_multiple" boolean DEFAULT false NOT NULL,
  "secret" boolean DEFAULT false NOT NULL,
  "mode" text DEFAULT 'sync' NOT NULL,
  "timeout_seconds" integer,
  "timeout_action" text DEFAULT 'skip' NOT NULL,
  "default_option_ids_json" text DEFAULT '[]' NOT NULL,
  "placeholder" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "answer_json" text DEFAULT '{}' NOT NULL,
  "expires_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_user_questions" ADD CONSTRAINT "agent_user_questions_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_user_questions" ADD CONSTRAINT "agent_user_questions_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_user_questions_session" ON "agent_user_questions" ("session_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_user_questions_due" ON "agent_user_questions" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_user_questions_tenant" ON "agent_user_questions" ("tenant_id");
