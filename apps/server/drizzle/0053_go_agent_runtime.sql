-- Go 本地代理：电脑/服务器双模式
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_kind" text DEFAULT 'container' NOT NULL;
--> statement-breakpoint
UPDATE "runtime_nodes" SET "kind" = 'computer' WHERE "kind" IN ('local', 'runner');
