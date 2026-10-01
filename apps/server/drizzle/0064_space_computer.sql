-- 电脑、项目、Gateway Key 归 Space；Agent 行只留身份（提示词 / 记忆 / 会话）
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "enable_computer" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "last_migration_id" text;
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
-- 每个空间取一个成员的电脑配置：已开电脑且绑了节点、最近更新的优先
UPDATE "spaces" AS s
SET "enable_computer" = a."enable_computer",
    "runtime_node_id" = a."runtime_node_id",
    "workspace_image" = a."workspace_image",
    "workspace_kind" = a."workspace_kind",
    "workspace_status" = 'ready',
    "workspace_revision" = a."workspace_revision"
FROM (
  SELECT DISTINCT ON ("space_id") "space_id", "enable_computer", "runtime_node_id",
         "workspace_image", "workspace_kind", "workspace_revision"
  FROM "agents"
  ORDER BY "space_id", "enable_computer" DESC, ("runtime_node_id" IS NOT NULL) DESC, "updated_at" DESC
) AS a
WHERE a."space_id" = s."id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "workspace_profile";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "enable_fs";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "enable_shell";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "enable_computer";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "enable_browser";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "workspace_image";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "runtime_node_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "workspace_kind";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "workspace_status";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "workspace_revision";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "last_migration_id";
--> statement-breakpoint
-- 迁移任务按空间记；旧的按 Agent 的任务直接清掉
DELETE FROM "workspace_migrations";
--> statement-breakpoint
DROP INDEX IF EXISTS "workspace_migrations_agent";
--> statement-breakpoint
ALTER TABLE "workspace_migrations" DROP COLUMN IF EXISTS "agent_id";
--> statement-breakpoint
ALTER TABLE "workspace_migrations" ADD COLUMN IF NOT EXISTS "space_id" text NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_migrations_space" ON "workspace_migrations" ("space_id");
--> statement-breakpoint
ALTER TABLE "managed_containers" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- 旧的按 Agent 的电脑/ACP 容器记录作废，由空间重新拉起
DELETE FROM "managed_containers" WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "containers_space" ON "managed_containers" ("space_id");
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "api_keys" AS k
SET "space_id" = a."space_id"
FROM "agents" AS a
WHERE k."agent_id" = a."id" AND k."space_id" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_projects" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "space_id" text NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "instructions" text NOT NULL DEFAULT '',
  "has_workspace" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "space_projects_space_slug" ON "space_projects" ("space_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_projects_tenant" ON "space_projects" ("tenant_id");
--> statement-breakpoint
INSERT INTO "space_projects" ("id", "tenant_id", "space_id", "slug", "name", "description", "instructions", "has_workspace", "created_at", "updated_at")
SELECT p."id", p."tenant_id", a."space_id", p."slug", p."name", p."description", p."instructions", p."has_workspace", p."created_at", p."updated_at"
FROM "agent_projects" AS p
JOIN "agents" AS a ON a."id" = p."agent_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_projects";
