-- Agent 级连接器安装：OAuth 客户端仍在 connector_auth_profiles；
-- 用户授权令牌与安装关系落在本表。
CREATE TABLE IF NOT EXISTS "agent_connector_installations" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "connector_ref" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "config_enc" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_connector_installations_agent_ref"
  ON "agent_connector_installations" ("agent_id", "connector_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_connector_installations_tenant"
  ON "agent_connector_installations" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_connector_installations_tenant_connector"
  ON "agent_connector_installations" ("tenant_id", "connector_ref");
