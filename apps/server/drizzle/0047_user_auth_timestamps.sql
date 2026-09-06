-- users 表补齐三个鉴权相关时间戳列。
-- schema.ts 已声明 emailVerifiedAt / lastLoginAt / passwordUpdatedAt，
-- 但此前没有对应迁移，导致 select users.* 在真实库上直接报 42703（列不存在），
-- 启动阶段 ensureSaasPlatformAdmin 首个查询即 fatal。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_updated_at" timestamp with time zone;