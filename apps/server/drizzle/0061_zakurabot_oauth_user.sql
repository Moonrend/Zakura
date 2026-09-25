-- Zakura Bot 改为标准 OAuth 用户授权：设备表与授权请求表删除，
-- 消息/文件/交互表的 device_id 改为存用户 id（外键解除，历史数据保留）。
ALTER TABLE "zakurabot_messages" DROP CONSTRAINT IF EXISTS "zakurabot_messages_device_id_fkey";--> statement-breakpoint
ALTER TABLE "zakurabot_files" DROP CONSTRAINT IF EXISTS "zakurabot_files_device_id_fkey";--> statement-breakpoint
ALTER TABLE "zakurabot_interactions" DROP CONSTRAINT IF EXISTS "zakurabot_interactions_device_id_fkey";--> statement-breakpoint
DROP TABLE IF EXISTS "zakurabot_authorizations";--> statement-breakpoint
DROP TABLE IF EXISTS "zakurabot_devices";
