-- 会话类型标记：所有系统产生的对话（子代理/委派/系统调用）与用户对话统一落库，用 kind 区分
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'chat' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "origin_json" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_sessions_agent_kind" ON "cloud_agent_sessions" USING btree ("agent_id","kind","updated_at");
