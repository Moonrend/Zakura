-- Per-user usage telemetry (product data plane). Query by user_id.
CREATE TABLE IF NOT EXISTS "user_usage_events" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_kind" text NOT NULL DEFAULT 'user',
  "category" text NOT NULL,
  "action" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ok',
  "duration_ms" integer NOT NULL DEFAULT 0,
  "agent_id" text,
  "session_id" text,
  "resource_kind" text,
  "resource_id" text,
  "summary" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_usage_events_user_time"
  ON "user_usage_events" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_usage_events_tenant_user_time"
  ON "user_usage_events" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_usage_events_tenant_cat_time"
  ON "user_usage_events" ("tenant_id", "category", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_usage_daily" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "day" text NOT NULL,
  "logins" integer NOT NULL DEFAULT 0,
  "sessions_started" integer NOT NULL DEFAULT 0,
  "runs_ok" integer NOT NULL DEFAULT 0,
  "runs_error" integer NOT NULL DEFAULT 0,
  "tool_calls" integer NOT NULL DEFAULT 0,
  "tool_errors" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_usage_daily_unique"
  ON "user_usage_daily" ("tenant_id", "user_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_usage_daily_user_day"
  ON "user_usage_daily" ("user_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_usage_daily_tenant_day"
  ON "user_usage_daily" ("tenant_id", "day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_sessions_created_by"
  ON "cloud_agent_sessions" ("created_by_user_id", "updated_at");
