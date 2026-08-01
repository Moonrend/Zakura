-- 按会话保存聊天输入草稿、模型、固定路由与思考等级
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "model_route_id" text;
--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "reasoning" text;
--> statement-breakpoint
ALTER TABLE "cloud_agent_sessions" ADD COLUMN IF NOT EXISTS "draft_text" text DEFAULT '' NOT NULL;
