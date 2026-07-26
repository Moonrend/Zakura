-- Cloud Agent 持久会话：事件日志 + Run 生命周期
CREATE TABLE IF NOT EXISTS "cloud_agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text DEFAULT '新对话' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"active_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"run_id" text,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_agent_sessions" ADD CONSTRAINT "cloud_agent_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_agent_sessions" ADD CONSTRAINT "cloud_agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_agent_sessions" ADD CONSTRAINT "cloud_agent_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_agent_events" ADD CONSTRAINT "cloud_agent_events_session_id_cloud_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cloud_agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_session_id_cloud_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cloud_agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_sessions_agent" ON "cloud_agent_sessions" USING btree ("agent_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_sessions_tenant" ON "cloud_agent_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_agent_events_session_seq" ON "cloud_agent_events" USING btree ("session_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_events_session" ON "cloud_agent_events" USING btree ("session_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_session" ON "cloud_agent_runs" USING btree ("session_id","created_at");
