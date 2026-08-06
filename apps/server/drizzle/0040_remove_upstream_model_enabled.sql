-- 模型库存采用“存在即启用”：先删除历史停用记录，再移除模型级开关。
DELETE FROM "upstream_models"
WHERE "enabled" = false;
--> statement-breakpoint
ALTER TABLE "upstream_models"
DROP COLUMN IF EXISTS "enabled";
