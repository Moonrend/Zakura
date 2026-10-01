-- Space 多 Agent 空间模型：
-- spaces = 一台共享电脑；agents 归入 space（缺省"默认空间"）。
CREATE TABLE IF NOT EXISTS "spaces" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "workspace_image" text,
  "runtime_node_id" text REFERENCES "runtime_nodes"("id") ON DELETE SET NULL,
  "workspace_kind" text NOT NULL DEFAULT 'container',
  "workspace_status" text NOT NULL DEFAULT 'ready',
  "workspace_revision" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_tenant_slug" ON "spaces" ("tenant_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_tenant" ON "spaces" ("tenant_id");
--> statement-breakpoint
-- 回填：每租户建"默认空间"，存量 agent 全部归入
INSERT INTO "spaces" ("id", "tenant_id", "name", "slug", "description", "workspace_kind", "workspace_status", "created_at", "updated_at")
SELECT 'spc_default_' || t.id, t.id, '默认空间', 'default', '', 'container', 'ready', now(), now()
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "spaces" s WHERE s.tenant_id = t.id AND s.slug = 'default');
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "agents" a
SET "space_id" = 'spc_default_' || a.tenant_id
WHERE a."space_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "space_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "agents_tenant_slug";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_space_slug" ON "agents" ("tenant_id", "space_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_space" ON "agents" ("space_id");
