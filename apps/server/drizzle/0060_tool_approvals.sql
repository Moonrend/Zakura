-- 工具调用审批：策略/规则/AI 门控触发，人工或 AI 决定，可审计

CREATE TABLE IF NOT EXISTS "agent_tool_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "session_id" text NOT NULL,
  "run_id" text,
  "tool_call_id" text,
  "tool_name" text NOT NULL,
  "qualified_name" text,
  "args_json" text DEFAULT '{}' NOT NULL,
  "reason" text DEFAULT 'policy_ask' NOT NULL,
  "ai_json" text DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by" text,
  "always_allow" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_tool_approvals" ADD CONSTRAINT "agent_tool_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_approvals_session" ON "agent_tool_approvals" ("session_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_approvals_due" ON "agent_tool_approvals" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_approvals_tenant" ON "agent_tool_approvals" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tool_approvals_agent" ON "agent_tool_approvals" ("agent_id","created_at");
