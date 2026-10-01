-- 空间级配置：ACP / MCP 等只在 space 上存一份
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "config_json" text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "agent_channel_bindings" ADD COLUMN IF NOT EXISTS "space_id" text;
--> statement-breakpoint
UPDATE "agent_channel_bindings" AS b
SET "space_id" = a."space_id"
FROM "agents" AS a
WHERE b."agent_id" = a."id" AND b."space_id" IS NULL;
--> statement-breakpoint
DELETE FROM "agent_channel_bindings" WHERE "space_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_channel_bindings" ALTER COLUMN "space_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_channel_bindings" ADD CONSTRAINT "agent_channel_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_channel_bindings_space" ON "agent_channel_bindings" ("space_id");
--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD COLUMN IF NOT EXISTS "space_id" text;
--> statement-breakpoint
UPDATE "agent_bindings" AS b
SET "space_id" = a."space_id"
FROM "agents" AS a
WHERE b."agent_id" = a."id" AND b."space_id" IS NULL;
--> statement-breakpoint
DELETE FROM "agent_bindings" AS b
USING "agent_bindings" AS d
WHERE b."space_id" IS NOT NULL
  AND b."space_id" = d."space_id"
  AND b."instance_id" = d."instance_id"
  AND b.ctid > d.ctid;
--> statement-breakpoint
DELETE FROM "agent_bindings" WHERE "space_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_bindings" ALTER COLUMN "space_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_bindings_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_bindings_space_instance" ON "agent_bindings" ("space_id", "instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bindings_space" ON "agent_bindings" ("space_id");
--> statement-breakpoint
ALTER TABLE "agent_bindings" DROP CONSTRAINT IF EXISTS "agent_bindings_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_bindings" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
