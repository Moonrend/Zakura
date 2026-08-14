ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "project" text;
ALTER TABLE "agent_schedules" ADD COLUMN IF NOT EXISTS "project" text;
