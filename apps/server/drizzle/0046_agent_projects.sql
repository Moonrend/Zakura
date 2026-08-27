ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "project" text;
--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "project" text;
