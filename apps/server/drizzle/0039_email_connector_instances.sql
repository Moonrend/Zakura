-- 多实例邮箱连接器：同一 provider 可配置多个账号并分别绑定 Agent。
CREATE TABLE IF NOT EXISTS "email_connector_instances" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "product" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "config_enc" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "email_connector_instances_tenant"
  ON "email_connector_instances" ("tenant_id");
CREATE INDEX IF NOT EXISTS "email_connector_instances_tenant_product"
  ON "email_connector_instances" ("tenant_id", "product");
