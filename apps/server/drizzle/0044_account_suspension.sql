-- 平台封号（suspend）：用户级与团队级。
-- 非空 suspended_at 即视为已封禁；鉴权中间件与登录路径都会拒绝。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_reason" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_reason" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_by_user_id" text;
--> statement-breakpoint
-- 管理后台按状态筛选走这两个索引
CREATE INDEX IF NOT EXISTS "users_suspended_at" ON "users" ("suspended_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_suspended_at" ON "tenants" ("suspended_at");
--> statement-breakpoint
-- 用户列表默认按创建时间倒序分页
CREATE INDEX IF NOT EXISTS "users_created_at" ON "users" ("created_at");
